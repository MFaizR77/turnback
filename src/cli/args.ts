export interface Args {
  positional: string[];
  flags: Set<string>;
  paths: string[];
  values: Map<string, string>;
}

/** Flags that take a value. */
const VALUE_FLAGS = new Set(['--before-step', '--port', '--message', '--out', '--session', '--label', '--days', '--svg', '-L', '--base']);

/** Split argv into positionals, boolean flags, repeated `--path` values, and value flags. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: new Set(), paths: [], values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path' && argv[i + 1]) args.paths.push(argv[++i]);
    else if (VALUE_FLAGS.has(argv[i]) && argv[i + 1] !== undefined) args.values.set(argv[i], argv[++i]);
    else if (argv[i].startsWith('--')) args.flags.add(argv[i]);
    else args.positional.push(argv[i]);
  }
  return args;
}
