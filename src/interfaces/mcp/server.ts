import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig } from '../../config/config.js';
import { compareSchemas, diffTables, fingerprintTable } from '../../core/diff.js';
import { openSource } from '../../core/sources.js';
import type { Source } from '../../engines/source.js';
import { quoteQualified, SourceError } from '../../engines/source.js';
import { HistoryStore } from '../../history/store.js';
import { formatReport } from '../format.js';

/**
 * The MCP server.
 *
 * Configured data sources are never modified. The server persists diff reports
 * and baseline fingerprints in its separate local history store. Credentials
 * come from configuration or the environment, never from the model, and tools
 * take source names rather than connection strings.
 */

/** The error codes this server returns. */
const ERROR_CODES = [
  'BAD_INPUT',
  'NOT_CONFIGURED',
  'UNKNOWN_SOURCE',
  'CONNECTION_FAILED',
  'QUERY_FAILED',
  'NOT_FOUND',
  'INTERNAL',
] as const;

type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Thrown when a tool names a source that is not configured.
 *
 * This is separate from `SourceError`, whose `NOT_FOUND` means the source is
 * configured but the *table* is not there.
 */
class UnknownSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSourceError';
  }
}

/** Builds the standard failure envelope. */
function fail(code: ErrorCode, message: string, hint?: string): CallToolResult {
  const error: Record<string, unknown> = { code, message, retryable: false };
  if (hint) error.hint = hint;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
  };
}

/** Builds the standard success envelope. */
function ok(data: unknown, meta: Record<string, unknown> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data, meta }) }],
  };
}

/** The tool definitions. */
const TOOLS = [
  {
    name: 'dataparity_list_sources',
    description:
      'List the configured data sources that can be diffed. Returns each source name, engine type and label.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dataparity_list_tables',
    description:
      'List table names in a configured source. Use this to find candidate tables, then call dataparity_describe_table when you need column names, types, or nullability before choosing diff keys.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The configured source name.' },
        schema: { type: 'string', description: 'Optional schema to restrict the listing to.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_describe_table',
    description:
      'Return detailed metadata for one table, including each column name, type, and nullability. Use this after dataparity_list_tables to choose key and comparison columns.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The configured source name.' },
        table: { type: 'string', description: 'The table name, optionally schema-qualified.' },
      },
      required: ['source', 'table'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_diff_tables',
    description:
      'Compare two tables and report what changed. Works across different databases: both sides compute the same canonical row hash, so only hashes are compared, never raw data. Returns added, removed and modified rows, schema differences, a risk verdict, and the segments of data where the changes concentrate.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'The left source name.' },
        right: { type: 'string', description: 'The right source name.' },
        left_table: { type: 'string', description: 'The table on the left.' },
        right_table: { type: 'string', description: 'The table on the right.' },
        key_columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns used to match rows across the two sides.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns to compare. Defaults to every column the two tables share.',
        },
        where: {
          type: 'string',
          description: 'A WHERE expression applied to both sides.',
        },
        max_changes: {
          type: 'number',
          description: 'Maximum number of row changes to return. Defaults to 100.',
        },
        max_attributions: {
          type: 'number',
          description: 'Maximum number of attribution segments to return. Defaults to 5.',
        },
        sample: {
          type: 'boolean',
          description: 'Compare only a sample of rows. The result is marked as sampled.',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Defaults to json.',
        },
      },
      required: ['left', 'right', 'left_table', 'right_table', 'key_columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_list_diff_runs',
    description:
      'List recent saved diff runs, newest first. Successful dataparity_diff_tables calls are saved locally; use dataparity_get_diff_run to retrieve a full report.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of runs to return (1-100, default 20).',
          minimum: 1,
          maximum: 100,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_get_diff_run',
    description:
      'Retrieve a previously saved full diff report by the run id returned from dataparity_diff_tables or dataparity_list_diff_runs.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Saved diff run id.' } },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_delete_diff_run',
    description: 'Permanently delete a saved diff report from local history by run id.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Saved diff run id.' } },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_create_baseline',
    description:
      'Capture a named baseline for a configured table. The local store keeps schema and bucket-level canonical hashes, not table row values. A later dataparity_compare_baseline checks for data or schema drift.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for this baseline.' },
        source: { type: 'string', description: 'Configured source name.' },
        table: { type: 'string', description: 'Table name, optionally schema-qualified.' },
        key_columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns that identify rows and determine fingerprint buckets.',
        },
      },
      required: ['name', 'source', 'table', 'key_columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_list_baselines',
    description: 'List saved table baselines, optionally filtered by configured source.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Optional configured source name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_compare_baseline',
    description:
      'Compare a configured table with a saved baseline for the same source and table. Returns schema differences and changed hash buckets; use dataparity_diff_tables for row-level details against a live table.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Saved baseline name.' },
        source: { type: 'string', description: 'Configured source name.' },
        table: { type: 'string', description: 'Table name, optionally schema-qualified.' },
      },
      required: ['name', 'source', 'table'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataparity_delete_baseline',
    description: 'Permanently delete a saved table baseline by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Saved baseline name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Opens a source by name, closing it when the operation finishes.
 *
 * An unknown source *name* is a different failure from a table that is not
 * found, and an agent needs to tell them apart: the first means "you asked
 * for a source that is not configured", the second means "the source is
 * there but the table is not". The error carries a code, so the distinction
 * survives the trip through the transport.
 */
async function withSource<T>(sourceName: string, fn: (source: Source) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const entry = config.sources.find((s) => s.name === sourceName);
  if (!entry) {
    const available = config.sources.map((s) => s.name);
    throw new UnknownSourceError(
      `Unknown source "${sourceName}". Configured sources: ${available.join(', ') || 'none'}`,
    );
  }
  const source = await openSource(entry);
  try {
    return await fn(source);
  } finally {
    await source.close();
  }
}

/** Starts the MCP server on stdio. */
export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'dataparity', version: '0.3.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'dataparity://sources',
        name: 'Configured sources',
        description: 'The data sources that can be diffed.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === 'dataparity://sources') {
      const config = loadConfig();
      return {
        contents: [
          {
            uri: 'dataparity://sources',
            mimeType: 'application/json',
            text: JSON.stringify(
              config.sources.map((s) => ({
                name: s.name,
                type: s.type,
                label: s.name,
              })),
              null,
              2,
            ),
          },
        ],
      };
    }
    throw new SourceError(`Unknown resource: ${req.params.uri}`, 'NOT_FOUND');
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    try {
      switch (name) {
        case 'dataparity_list_sources': {
          const config = loadConfig();
          return ok(
            config.sources.map((s) => ({ name: s.name, type: s.type, label: s.name })),
            { count: config.sources.length },
          );
        }

        case 'dataparity_list_tables': {
          const source = z.string().parse(args.source);
          const schema = args.schema ? z.string().parse(args.schema) : undefined;
          const tables = await withSource(source, (s) => s.listTables(schema));
          return ok(
            tables.map(({ qualifiedName, name, schema: tableSchema }) => ({
              qualifiedName,
              name,
              schema: tableSchema,
            })),
            { count: tables.length },
          );
        }

        case 'dataparity_describe_table': {
          const source = z.string().parse(args.source);
          const table = z.string().parse(args.table);
          const info = await withSource(source, (s) => s.describeTable(table));
          return ok(info);
        }

        case 'dataparity_diff_tables': {
          const left = z.string().parse(args.left);
          const right = z.string().parse(args.right);
          const leftTable = z.string().parse(args.left_table);
          const rightTable = z.string().parse(args.right_table);
          const keyColumns = z.array(z.string()).min(1).parse(args.key_columns);
          const format = args.format === 'text' ? 'text' : 'json';

          const config = loadConfig();
          const leftEntry = config.sources.find((s) => s.name === left);
          const rightEntry = config.sources.find((s) => s.name === right);
          if (!leftEntry || !rightEntry) {
            // Name the source that was not found. "Unknown source" without a
            // name leaves the agent guessing which of the two it got wrong.
            const missing = !leftEntry ? left : right;
            const available = config.sources.map((s) => s.name).join(', ') || 'none';
            return fail(
              'UNKNOWN_SOURCE',
              `Unknown source "${missing}". Configured sources: ${available}`,
              'Call dataparity_list_sources first.',
            );
          }

          const leftSource = await openSource(leftEntry);
          const rightSource = await openSource(rightEntry);
          try {
            const report = await diffTables(leftSource, leftTable, rightSource, rightTable, {
              keyColumns,
              columns: args.columns ? z.array(z.string()).parse(args.columns) : undefined,
              where: args.where ? z.string().parse(args.where) : undefined,
              maxChanges: args.max_changes ? z.number().parse(args.max_changes) : undefined,
              maxAttributions: args.max_attributions
                ? z.number().parse(args.max_attributions)
                : undefined,
              sampleOnly: args.sample === true,
            });
            const store = new HistoryStore();
            let runId: string;
            try {
              runId = store.saveDiffRun(report).id;
            } finally {
              store.close();
            }
            // JSON diffs use the standard envelope; text is returned only
            // when the caller explicitly requests it.
            if (format === 'text') {
              return {
                content: [{ type: 'text', text: formatReport(report) }],
              };
            }
            return ok(report, {
              runId,
              strategy: report.strategy,
              identical: report.identical,
              durationMs: report.durationMs,
            });
          } finally {
            await leftSource.close();
            await rightSource.close();
          }
        }

        case 'dataparity_list_diff_runs': {
          const limit =
            args.limit === undefined ? 20 : z.number().int().min(1).max(100).parse(args.limit);
          const store = new HistoryStore();
          try {
            const runs = store.listDiffRuns(limit);
            return ok(runs, { count: runs.length });
          } finally {
            store.close();
          }
        }

        case 'dataparity_get_diff_run': {
          const id = z.string().min(1).parse(args.run_id);
          const store = new HistoryStore();
          try {
            const run = store.getDiffRun(id);
            if (!run) return fail('NOT_FOUND', `Diff run not found: ${id}`);
            return ok(run);
          } finally {
            store.close();
          }
        }

        case 'dataparity_delete_diff_run': {
          const id = z.string().min(1).parse(args.run_id);
          const store = new HistoryStore();
          try {
            if (!store.deleteDiffRun(id)) return fail('NOT_FOUND', `Diff run not found: ${id}`);
            return ok({ deleted: true, id });
          } finally {
            store.close();
          }
        }

        case 'dataparity_create_baseline': {
          const name = z.string().trim().min(1).max(120).parse(args.name);
          const sourceName = z.string().min(1).parse(args.source);
          const table = z.string().min(1).parse(args.table);
          const keyColumns = z.array(z.string().min(1)).min(1).parse(args.key_columns);
          const store = new HistoryStore();
          try {
            if (store.getBaseline(name)) {
              return fail(
                'BAD_INPUT',
                `Baseline "${name}" already exists. Delete it before replacing it.`,
              );
            }
            const fingerprint = await withSource(sourceName, (source) =>
              fingerprintTable(source, table, keyColumns),
            );
            const baseline = store.saveBaseline(name, sourceName, fingerprint);
            return ok({
              name: baseline.name,
              createdAt: baseline.createdAt,
              source: baseline.source,
              table: baseline.table,
              rowCount: fingerprint.rowCount,
              bucketCount: fingerprint.bucketCount,
              checksum: fingerprint.checksum,
            });
          } finally {
            store.close();
          }
        }

        case 'dataparity_list_baselines': {
          const source =
            args.source === undefined ? undefined : z.string().min(1).parse(args.source);
          const store = new HistoryStore();
          try {
            const baselines = store.listBaselines(source);
            return ok(baselines, { count: baselines.length });
          } finally {
            store.close();
          }
        }

        case 'dataparity_compare_baseline': {
          const name = z.string().min(1).parse(args.name);
          const sourceName = z.string().min(1).parse(args.source);
          const table = z.string().min(1).parse(args.table);
          const store = new HistoryStore();
          try {
            const baseline = store.getBaseline(name);
            if (!baseline) return fail('NOT_FOUND', `Baseline not found: ${name}`);
            if (baseline.source !== sourceName) {
              return fail(
                'BAD_INPUT',
                `Baseline "${name}" is for source "${baseline.source}", not "${sourceName}".`,
              );
            }

            return await withSource(sourceName, async (source) => {
              const info = await source.describeTable(table);
              if (baseline.table !== info.qualifiedName) {
                return fail(
                  'BAD_INPUT',
                  `Baseline "${name}" is for ${baseline.source}:${baseline.table}, not ${sourceName}:${info.qualifiedName}.`,
                );
              }
              const schemaDifferences = compareSchemas(baseline.fingerprint.columns, info.columns);
              if (schemaDifferences.length > 0) {
                const countRows = await source.query(
                  `select count(*) as n from ${quoteQualified(info.qualifiedName, source.dialect)}`,
                );
                return ok({
                  name,
                  baselineCreatedAt: baseline.createdAt,
                  source: sourceName,
                  table: info.qualifiedName,
                  identical: false,
                  schemaDifferences,
                  rowCounts: {
                    baseline: baseline.fingerprint.rowCount,
                    current: Number(countRows[0]?.n ?? 0),
                  },
                  changedBucketCount: null,
                  changedBucketIds: [],
                  changedBucketIdsTruncated: false,
                });
              }

              const baselineKinds = new Map(
                baseline.fingerprint.columns.map((column) => [column.name, column.kind]),
              );
              const current = await fingerprintTable(
                source,
                table,
                baseline.fingerprint.keyColumns,
                {
                  bucketCount: baseline.fingerprint.bucketCount,
                  peerKinds: baselineKinds,
                },
              );
              const expected = new Map(
                baseline.fingerprint.buckets.map((bucket) => [
                  bucket.bucket,
                  [bucket.count, bucket.checksum1, bucket.checksum2] as const,
                ]),
              );
              const actual = new Map(
                current.buckets.map((bucket) => [
                  bucket.bucket,
                  [bucket.count, bucket.checksum1, bucket.checksum2] as const,
                ]),
              );
              const changedBucketIds = [...new Set([...expected.keys(), ...actual.keys()])]
                .filter((bucket) => {
                  const before = expected.get(bucket);
                  const after = actual.get(bucket);
                  return (
                    !before ||
                    !after ||
                    before[0] !== after[0] ||
                    before[1] !== after[1] ||
                    before[2] !== after[2]
                  );
                })
                .sort((a, b) => a - b);
              return ok({
                name,
                baselineCreatedAt: baseline.createdAt,
                source: sourceName,
                table: info.qualifiedName,
                identical: changedBucketIds.length === 0,
                schemaDifferences,
                rowCounts: {
                  baseline: baseline.fingerprint.rowCount,
                  current: current.rowCount,
                },
                changedBucketCount: changedBucketIds.length,
                changedBucketIds: changedBucketIds.slice(0, 100),
                changedBucketIdsTruncated: changedBucketIds.length > 100,
              });
            });
          } finally {
            store.close();
          }
        }

        case 'dataparity_delete_baseline': {
          const name = z.string().min(1).parse(args.name);
          const store = new HistoryStore();
          try {
            if (!store.deleteBaseline(name))
              return fail('NOT_FOUND', `Baseline not found: ${name}`);
            return ok({ deleted: true, name });
          } finally {
            store.close();
          }
        }

        default:
          return fail('BAD_INPUT', `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof UnknownSourceError) {
        return fail('UNKNOWN_SOURCE', err.message, 'Call dataparity_list_sources first.');
      }
      if (err instanceof SourceError) {
        const code: ErrorCode =
          err.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : err.code === 'CONNECTION_FAILED' || err.code === 'AUTH_FAILED'
              ? 'CONNECTION_FAILED'
              : err.code === 'QUERY_FAILED'
                ? 'QUERY_FAILED'
                : 'INTERNAL';
        return fail(code, err.message);
      }
      if (err instanceof z.ZodError) {
        return fail('BAD_INPUT', err.issues.map((i) => i.message).join('; '));
      }
      return fail('INTERNAL', (err as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
