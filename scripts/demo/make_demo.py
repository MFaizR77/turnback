"""Render docs/demo.gif and docs/social-preview.png from a real Turnback run.

The script builds a throwaway project, feeds Turnback the same hook payloads
Claude Code sends, really runs `rm -rf src .env`, and records the actual CLI
output. Only the agent is simulated; every Turnback line in the GIF is real.

Requirements: Python 3.10+, Pillow, Node 22+, git, and a built `dist/cli.js`
(`npm run build`). Font: Consolas on Windows, otherwise DejaVu Sans Mono or
the path given with --font.

    python scripts/demo/make_demo.py [--font path/to/mono.ttf]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "dist" / "cli.js"
DOCS = ROOT / "docs"

BG = (22, 24, 29)
BAR = (34, 37, 44)
FG = (216, 220, 228)
DIM = (120, 128, 142)
PROMPT = (126, 200, 142)
AGENT = (229, 164, 92)
DANGER = (235, 110, 110)
ACCENT = (122, 178, 247)
DOTS = [(237, 106, 94), (245, 191, 79), (98, 197, 84)]

PROMPT_TEXT = "clean up the project, remove anything unused"


# ---- Real run -------------------------------------------------------------

def run(cmd: list[str], cwd: Path, env: dict[str, str], stdin: str | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, env=env, input=stdin, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        sys.exit(f"{' '.join(cmd)} failed:\n{result.stderr}")
    return result.stdout.rstrip("\n")


def record_session(work: Path) -> dict[str, str]:
    project, home = work / "my-app", work / "home"
    (project / "src").mkdir(parents=True)
    home.mkdir()
    env = {**os.environ, "TURNBACK_HOME": str(home)}
    files = {
        "src/app.ts": "import { auth } from './auth';\nexport const app = () => auth();\n",
        "src/auth.ts": "export const auth = () => true;\n",
        "src/db.ts": "export const db = new Map();\n",
        ".gitignore": ".env\n",
        ".env": "API_KEY=sk-live-4f9a\n",
        "README.md": "# my-app\n",
    }
    for name, text in files.items():
        (project / name).write_text(text, encoding="utf-8", newline="\n")
    run(["git", "init", "-q"], project, env)

    def cli(*args: str) -> str:
        return run(["node", str(CLI), *args], project, env)

    def hook(payload: dict) -> str:
        body = json.dumps({"session_id": "demo", "cwd": str(project), **payload})
        return run(["node", str(CLI), "hook", "claude"], project, env, body)

    ls = lambda: "  ".join(sorted(p.name + ("/" if p.is_dir() else "") for p in project.iterdir() if p.name != ".git"))

    out = {"ls_before": ls()}
    hook({"hook_event_name": "UserPromptSubmit", "prompt": PROMPT_TEXT})
    hook({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "rm -rf src .env"}})
    shutil.rmtree(project / "src")
    (project / ".env").unlink()
    stop = json.loads(hook({"hook_event_name": "Stop"}) or "{}")
    out["warning"] = stop.get("systemMessage", "")
    out["ls_after"] = ls()
    out["list"] = cli("list")
    out["undo"] = cli("undo", "--yes")
    out["ls_restored"] = ls()
    out["env"] = (project / ".env").read_text(encoding="utf-8").rstrip("\n")
    return out


CODEGEN = """import { readFileSync, rmSync, writeFileSync } from 'node:fs';
const [header] = readFileSync('src/api.ts', 'utf8').split('\\n');
writeFileSync('src/api.ts', `${header}
export const getUser = (id) => fetch(\\`/users/\\${id}\\`);
export const listUsers = () => fetch('/users');
`);
rmSync('src/legacy.ts');
"""


def record_cli_session(work: Path) -> dict[str, str]:
    """No agent: a code generator run through `turnback run`, then blame and recover."""
    project, home = work / "my-app", work / "home"
    (project / "src").mkdir(parents=True)
    (project / "scripts").mkdir()
    home.mkdir()
    env = {**os.environ, "TURNBACK_HOME": str(home)}
    files = {
        "src/api.ts": "// API client, keep this header\nexport const getUser = (id) => fetch('/user?id=' + id);\n",
        "src/legacy.ts": "export const oldAuth = () => true;\n",
        "scripts/codegen.mjs": CODEGEN,
    }
    for name, text in files.items():
        (project / name).write_text(text, encoding="utf-8", newline="\n")
    run(["git", "init", "-q"], project, env)

    def cli(*args: str) -> str:
        result = subprocess.run(["node", str(CLI), *args], cwd=project, env=env, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            sys.exit(f"turnback {' '.join(args)} failed:\n{result.stderr}")
        return (result.stdout + result.stderr).rstrip("\n")

    return {
        "run": cli("run", "--label", "codegen", "--", "node", "scripts/codegen.mjs"),
        "blame": cli("blame", "src/api.ts"),
        "recover": cli("recover", "src/legacy.ts", "--yes"),
    }


RETRY = """import { readFileSync, writeFileSync } from 'node:fs';
const lines = readFileSync('src/api.ts', 'utf8').split('\\n');
lines[1] = 'export const getUser = withRetry(fetchUser);';
lines.splice(1, 0, "import { withRetry } from './retry';");
writeFileSync('src/api.ts', lines.join('\\n'));
"""

TOUR_STEPS = [
    ("mark", ["mark", "before codegen"]),
    ("run codegen", ["run", "--label", "codegen", "--", "node", "scripts/codegen.mjs"]),
    ("run retries", ["run", "--label", "add retries", "--", "node", "scripts/retry.mjs"]),
    ("list", ["list"]),
    ("blame", ["blame", "src/api.ts"]),
    ("undo plan", ["undo", "--dry-run"]),
    ("recover", ["recover", "src/legacy.ts", "--yes"]),
    ("stats", ["stats"]),
    ("restore mark", ["restore", "before codegen", "--dry-run"]),
]


def record_tour_session(work: Path) -> list[tuple[str, str]]:
    """A longer tour without an agent: mark, two runs, list, blame, undo plan, recover, stats, restore to the mark."""
    project, home = work / "my-app", work / "home"
    (project / "src").mkdir(parents=True)
    (project / "scripts").mkdir()
    home.mkdir()
    env = {**os.environ, "TURNBACK_HOME": str(home)}
    files = {
        "src/api.ts": "// API client, keep this header\nexport const getUser = (id) => fetch('/user?id=' + id);\n",
        "src/legacy.ts": "export const oldAuth = () => true;\n",
        "scripts/codegen.mjs": CODEGEN,
        "scripts/retry.mjs": RETRY,
    }
    for name, text in files.items():
        (project / name).write_text(text, encoding="utf-8", newline="\n")
    run(["git", "init", "-q"], project, env)

    shown = []
    for _, args in TOUR_STEPS:
        result = subprocess.run(["node", str(CLI), *args], cwd=project, env=env, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            sys.exit(f"turnback {' '.join(args)} failed:\n{result.stderr}")
        command = "turnback " + " ".join(f'"{a}"' if " " in a else a for a in args)
        shown.append((command, (result.stdout + result.stderr).rstrip("\n")))
    return shown


# ---- Rendering --------------------------------------------------------------

def load_font(explicit: str | None, size: int) -> ImageFont.FreeTypeFont:
    candidates = [explicit] if explicit else [
        "C:/Windows/Fonts/consola.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Menlo.ttc",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return ImageFont.truetype(c, size)
    sys.exit("No monospace font found; pass --font")


Line = list[tuple[str, tuple[int, int, int]]]


def build_script(o: dict[str, str]) -> list[tuple[str, object, int]]:
    """Steps: ('type', command, pause_ms) types a shell command; ('show', lines, pause_ms) prints lines."""
    plain = lambda text, color=FG: [[(line, color)] for line in text.split("\n")]
    steps: list[tuple[str, object, int]] = [
        ("type", "ls", 300),
        ("show", plain(o["ls_before"]), 900),
        ("show", [[], [("● ", AGENT), ("Claude Code", AGENT), (f'  "{PROMPT_TEXT}"', DIM)]], 900),
        ("show", [[("  Bash(", AGENT), ("rm -rf src .env", DANGER), (")", AGENT)]], 1200),
    ]
    if o["warning"]:
        steps.append(("show", plain("  " + o["warning"], DIM), 1400))
    steps += [
        ("show", [[]], 0),
        ("type", "ls", 300),
        ("show", plain(o["ls_after"]), 1500),
        ("type", "turnback list", 300),
        ("show", plain(o["list"]), 1800),
        ("type", "turnback undo --yes", 300),
        ("show", [[(l, ACCENT if l.startswith("Restored") else FG)] for l in o["undo"].split("\n")], 2200),
        ("type", "ls", 300),
        ("show", plain(o["ls_restored"]), 700),
        ("type", "cat .env", 300),
        ("show", plain(o["env"]), 3500),
    ]
    return steps


def build_cli_script(o: dict[str, str]) -> list[tuple[str, object, int]]:
    plain = lambda text, color=FG: [[(line, color)] for line in text.split("\n")]
    highlight = lambda text: [[(l, ACCENT if l.startswith(("Restored", "turnback: recorded")) else FG)] for l in text.split("\n")]
    return [
        ("type", "turnback run --label codegen -- node scripts/codegen.mjs", 300),
        ("show", highlight(o["run"]), 1500),
        ("type", "turnback blame src/api.ts", 300),
        ("show", plain(o["blame"]), 2600),
        ("type", "turnback recover src/legacy.ts --yes", 300),
        ("show", highlight(o["recover"]), 3000),
    ]


def build_tour_script(steps: list[tuple[str, str]]) -> list[tuple[str, object, int]]:
    accent = ("Restored", "turnback: recorded", "Marked")
    width = 90  # the tour terminal is 92 columns; wrap longer lines instead of cutting them off
    script: list[tuple[str, object, int]] = []
    for command, output in steps:
        lines = []
        for line in output.split("\n"):
            color = ACCENT if line.startswith(accent) else FG
            while len(line) > width:
                cut = line.rfind(" ", 0, width)
                cut = cut if cut > 0 else width
                lines.append([(line[:cut], color)])
                line = "  " + line[cut:].lstrip()
            lines.append([(line, color)])
        pause = 1200 + 110 * len(lines)
        script += [("type", command, 250), ("show", lines, min(pause, 3200))]
    script[-1] = (script[-1][0], script[-1][1], 4000)
    return script


class Terminal:
    def __init__(self, font: ImageFont.FreeTypeFont, cols: int, rows: int, title: str):
        self.font, self.cols, self.rows, self.title = font, cols, rows, title
        box = font.getbbox("M")
        self.cw, self.ch = font.getlength("M"), int((box[3] - box[1]) * 1.75)
        self.pad, self.bar = 22, 38
        self.size = (int(self.cw * cols + self.pad * 2), self.bar + self.ch * rows + self.pad * 2)
        self.lines: list[Line] = []

    def frame(self, current: Line | None = None, cursor: bool = False) -> Image.Image:
        img = Image.new("RGB", self.size, BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, self.size[0], self.bar], fill=BAR)
        for i, c in enumerate(DOTS):
            d.ellipse([16 + i * 22, 13, 28 + i * 22, 25], fill=c)
        tw = d.textlength(self.title, font=self.font)
        d.text(((self.size[0] - tw) / 2, 10), self.title, font=self.font, fill=DIM)
        visible = self.lines + ([current] if current is not None else [])
        visible = visible[-self.rows:]
        for row, segments in enumerate(visible):
            x, y = self.pad, self.bar + self.pad + row * self.ch
            for text, color in segments:
                d.text((x, y), text, font=self.font, fill=color)
                x += d.textlength(text, font=self.font)
            if cursor and row == len(visible) - 1:
                d.rectangle([x + 2, y + 2, x + self.cw, y + self.ch - 6], fill=FG)
        return img


def render_gif(steps: list[tuple[str, object, int]], font: ImageFont.FreeTypeFont, path: Path, rows: int = 22) -> None:
    term = Terminal(font, cols=92, rows=rows, title="~/my-app")
    frames: list[Image.Image] = []
    durations: list[int] = []

    def add(img: Image.Image, ms: int) -> None:
        frames.append(img)
        durations.append(ms)

    for kind, payload, pause in steps:
        if kind == "type":
            command = str(payload)
            add(term.frame([("$ ", PROMPT)], cursor=True), 350)
            for i in range(1, len(command) + 1):
                add(term.frame([("$ ", PROMPT), (command[:i], FG)], cursor=True), 45)
            term.lines.append([("$ ", PROMPT), (command, FG)])
            add(term.frame(), pause)
        else:
            term.lines.extend(payload)  # type: ignore[arg-type]
            if pause:
                add(term.frame(), pause)
    add(term.frame([("$ ", PROMPT)], cursor=True), 3000)

    # One shared palette, so colors do not shift from frame to frame.
    w, h = frames[0].size
    sample = frames[::max(1, len(frames) // 8)] + [frames[-1]]
    sheet = Image.new("RGB", (w, h * len(sample)))
    for i, f in enumerate(sample):
        sheet.paste(f, (0, h * i))
    palette = sheet.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    indexed = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    indexed[0].save(path, save_all=True, append_images=indexed[1:], duration=durations, loop=0, optimize=True)


def render_social(o: dict[str, str], font_path: str | None, path: Path) -> None:
    img = Image.new("RGB", (1280, 640), BG)
    d = ImageDraw.Draw(img)
    title_font = load_font(font_path, 64)
    body_font = load_font(font_path, 30)
    small = load_font(font_path, 24)
    d.text((80, 90), "turnback", font=title_font, fill=FG)
    d.text((80, 190), "Undo for AI coding agents,", font=body_font, fill=FG)
    d.text((80, 234), "even after ", font=body_font, fill=FG)
    x = 80 + d.textlength("even after ", font=body_font)
    d.text((x, 234), "rm -rf", font=body_font, fill=DANGER)
    d.text((80, 300), "Claude Code · Codex · Cursor · Gemini CLI · OpenCode · Antigravity", font=small, fill=DIM)
    lines = [
        ([("$ ", PROMPT), ("turnback undo --yes", FG)]),
        ([(next(l for l in o["undo"].split("\n") if l.startswith("Restored")), ACCENT)]),
        ([("$ ", PROMPT), ("npm i -g turnback", FG)]),
    ]
    for i, segments in enumerate(lines):
        x, y = 80, 420 + i * 44
        for text, color in segments:
            d.text((x, y), text, font=small, fill=color)
            x += d.textlength(text, font=small)
    img.save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--font", help="monospace TTF/TTC to use")
    args = parser.parse_args()
    if not CLI.exists():
        sys.exit("dist/cli.js not found; run `npm run build` first")
    DOCS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="turnback-demo-", ignore_cleanup_errors=True) as tmp:
        output = record_session(Path(tmp))
    with tempfile.TemporaryDirectory(prefix="turnback-demo-cli-", ignore_cleanup_errors=True) as tmp:
        cli_output = record_cli_session(Path(tmp))
    with tempfile.TemporaryDirectory(prefix="turnback-demo-tour-", ignore_cleanup_errors=True) as tmp:
        tour_output = record_tour_session(Path(tmp))
    font = load_font(args.font, 17)
    render_gif(build_script(output), font, DOCS / "demo.gif")
    render_gif(build_cli_script(cli_output), font, DOCS / "demo-cli.gif", rows=16)
    render_gif(build_tour_script(tour_output), font, DOCS / "demo-tour.gif", rows=24)
    render_social(output, args.font, DOCS / "social-preview.png")
    for name in ("demo.gif", "demo-cli.gif", "demo-tour.gif", "social-preview.png"):
        print(f"{name}: {(DOCS / name).stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
