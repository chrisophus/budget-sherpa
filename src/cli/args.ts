import { parseArgs } from 'node:util';

export interface CliArgs {
  dir: string;
  skipTransfers: boolean;
  dryRun: boolean;
  import: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      dir:              { type: 'string',  default: '.' },
      'skip-transfers': { type: 'boolean', default: false },
      'dry-run':        { type: 'boolean', default: false },
      'import':         { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    dir:           values.dir as string,
    skipTransfers: values['skip-transfers'] as boolean,
    dryRun:        values['dry-run'] as boolean,
    import:        values['import'] as boolean,
  };
}
