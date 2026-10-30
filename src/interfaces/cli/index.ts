#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type DiffOptions, diffTables } from '../../core/diff.js';
import { openNamedSource, openSource } from '../../core/sources.js';
import type { Source } from '../../engines/source.js';
import { SourceError } from '../../engines/source.js';
import { formatJson, formatReport } from '../format.js';

/** Exit codes, following the GNU diff convention where it makes sense. */
const EXIT_OK = 0;
const EXIT_DIFFERENCES = 1;
const EXIT_ERROR = 2;
const EXIT_USAGE = 64;

/** Parsed command-line arguments. */
interface Args {
  command: string;
  flags: Map<string, string | boolean>;
  positionals: string[];
}

/** Parses `--key value`, `--key=value` and `--flag` arguments. */
export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1]?.startsWith('--')) {
        flags.set(body, argv[i + 1] as string);
        i++;
      } else {
        flags.set(body, true);
      }
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}

/** Reads a flag as a string. */
function str(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

/** Reads a flag as a number. */
function num(flags: Map<string, string | boolean>, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads a repeatable flag as a list. */
function list(flags: Map<string, string | boolean>, name: string): string[] {
  const v = flags.get(name);
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const HELP = `dataparity - cross-database data diff and reconciliation

Usage:
  dataparity diff --left <source> --right <source> --left-table <table> --right-table <table> --key <cols> [options]
  dataparity tables --source <source>
  dataparity describe --source <source> --table <table>
  dataparity mcp
  dataparity --help

Diff options:
  --left <name>          Left source name (from the config file)
  --right <name>         Right source name
  --left-table <table>   Table on the left
  --right-table <table>  Table on the right
  --key <cols>           Comma-separated key columns used to match rows
  --columns <cols>       Comma-separated columns to compare (default: all shared)
  --where <expr>         WHERE expression applied to both sides
  --max-changes <n>      Maximum row changes to report (default 100)
  --max-attributions <n> Maximum attribution segments to report (default 5)
  --sample               Compare only a sample of rows
  --sample-limit <n>     Rows to sample per side (default 100000)
  --bucket-count <n>     Buckets for the cross-database comparison (default: from table size)
  --json                 Emit JSON instead of text

Sources are configured in ~/.dataparity/config.json:

  {
    "sources": [
      { "name": "prod",   "type": "postgres", "connectionString": "postgres://..." },
      { "name": "staging","type": "postgres", "connectionString": "postgres://..." },
      { "name": "files",  "type": "duckdb", "files": ["data/orders.parquet"] }
    ]
  }
`;

/** Runs the CLI. Returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.has('version') || args.command === 'version') {
    process.stdout.write('0.1.0\n');
    return EXIT_OK;
  }

  if (!args.command || args.flags.has('help') || args.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  try {
    switch (args.command) {
      case 'diff':
        return await runDiff(args);
      case 'tables':
        return await runTables(args);
      case 'describe':
        return await runDescribe(args);
      case 'mcp':
        return await runMcp();
      default:
        process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof SourceError) {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
      return EXIT_ERROR;
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
}

/** Opens a source by name, or from an inline connection string. */
async function resolveSource(
  name: string,
  inlineType: 'postgres' | 'mysql' | undefined,
  inlineConnectionString: string | undefined,
): Promise<Source> {
  if (inlineType && inlineConnectionString) {
    return openSource({
      name,
      type: inlineType,
      connectionString: inlineConnectionString,
    });
  }
  return openNamedSource(name);
}

/** Runs the `diff` command. */
async function runDiff(args: Args): Promise<number> {
  const flags = args.flags;
  const leftName = str(flags, 'left');
  const rightName = str(flags, 'right');
  const leftTable = str(flags, 'left-table');
  const rightTable = str(flags, 'right-table');
  const keys = list(flags, 'key');

  if (!leftName || !rightName || !leftTable || !rightTable || keys.length === 0) {
    process.stderr.write('diff needs --left, --right, --left-table, --right-table and --key.\n');
    return EXIT_USAGE;
  }

  const leftType = str(flags, 'left-type') as 'postgres' | 'mysql' | undefined;
  const leftConn = str(flags, 'left-connection-string');
  const rightType = str(flags, 'right-type') as 'postgres' | 'mysql' | undefined;
  const rightConn = str(flags, 'right-connection-string');

  const left = await resolveSource(leftName, leftType, leftConn);
  const sameSource = leftName === rightName && leftType === rightType && leftConn === rightConn;
  let right: Source;
  try {
    right = sameSource ? left : await resolveSource(rightName, rightType, rightConn);
  } catch (err) {
    await left.close();
    throw err;
  }

  const options: DiffOptions = {
    keyColumns: keys,
    columns: list(flags, 'columns').length > 0 ? list(flags, 'columns') : undefined,
    where: str(flags, 'where'),
    maxChanges: num(flags, 'max-changes'),
    maxAttributions: num(flags, 'max-attributions'),
    sampleOnly: flags.get('sample') === true,
    sampleLimit: num(flags, 'sample-limit'),
    bucketCount: num(flags, 'bucket-count'),
  };

  try {
    const report = await diffTables(left, leftTable, right, rightTable, options);
    if (flags.get('json') === true) {
      process.stdout.write(`${formatJson(report)}\n`);
    } else {
      process.stdout.write(`${formatReport(report)}\n`);
    }
    return report.identical ? EXIT_OK : EXIT_DIFFERENCES;
  } finally {
    await left.close();
    await right.close();
  }
}

/** Runs the `tables` command. */
async function runTables(args: Args): Promise<number> {
  const sourceName = str(args.flags, 'source');
  if (!sourceName) {
    process.stderr.write('tables needs --source.\n');
    return EXIT_USAGE;
  }
  const source = await resolveSource(
    sourceName,
    str(args.flags, 'type') as 'postgres' | 'mysql' | undefined,
    str(args.flags, 'connection-string'),
  );
  try {
    const tables = await source.listTables(str(args.flags, 'schema'));
    if (args.flags.get('json') === true) {
      process.stdout.write(`${JSON.stringify(tables, null, 2)}\n`);
    } else {
      for (const table of tables) {
        process.stdout.write(`${table.qualifiedName}\n`);
      }
    }
    return EXIT_OK;
  } finally {
    await source.close();
  }
}

/** Runs the `describe` command. */
async function runDescribe(args: Args): Promise<number> {
  const sourceName = str(args.flags, 'source');
  const table = str(args.flags, 'table');
  if (!sourceName || !table) {
    process.stderr.write('describe needs --source and --table.\n');
    return EXIT_USAGE;
  }
  const source = await resolveSource(
    sourceName,
    str(args.flags, 'type') as 'postgres' | 'mysql' | undefined,
    str(args.flags, 'connection-string'),
  );
  try {
    const info = await source.describeTable(table);
    if (args.flags.get('json') === true) {
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    } else {
      process.stdout.write(`${info.qualifiedName}\n`);
      for (const col of info.columns) {
        const nulls = col.nullable ? 'nullable' : 'not null';
        process.stdout.write(`  ${col.name}  ${col.dataType}  ${nulls}\n`);
      }
    }
    return EXIT_OK;
  } finally {
    await source.close();
  }
}

/** Runs the MCP server over stdio. */
async function runMcp(): Promise<number> {
  const { startMcpServer } = await import('../mcp/server.js');
  await startMcpServer();
  return EXIT_OK;
}

// Only run when invoked directly (including via npm/npx bin symlinks), not when imported by a test.
function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(invoked).href === import.meta.url;
  }
}

if (isDirectExecution()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exitCode = EXIT_ERROR;
    });
}
