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
import { diffTables } from '../../core/diff.js';
import { openSource } from '../../core/sources.js';
import type { Source } from '../../engines/source.js';
import { SourceError } from '../../engines/source.js';
import { formatJson, formatReport } from '../format.js';

/**
 * The MCP server.
 *
 * Every tool is read-only: an agent can list sources, inspect schemas and run
 * diffs, but it cannot write to any database. Credentials come from the
 * configuration file or the environment, never from the model, and tools take
 * *source names* rather than connection strings.
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
      'List the tables in a configured source, with their columns. Use this to find the right table and key columns before diffing.',
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
      'Describe one table: its columns, their types and whether they are nullable. Use this to choose key columns and comparison columns.',
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
    name: 'dataparity_diff',
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
] as const;

/** Opens a source by name, closing it when the operation finishes. */
async function withSource<T>(sourceName: string, fn: (source: Source) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const entry = config.sources.find((s) => s.name === sourceName);
  if (!entry) {
    const available = config.sources.map((s) => s.name);
    throw new SourceError(
      `Unknown source "${sourceName}". Configured sources: ${available.join(', ') || 'none'}`,
      'NOT_FOUND',
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
    { name: 'dataparity', version: '0.1.0' },
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
            config.sources.map((s) => ({ name: s.name, type: s.type })),
            { count: config.sources.length },
          );
        }

        case 'dataparity_list_tables': {
          const source = z.string().parse(args.source);
          const schema = args.schema ? z.string().parse(args.schema) : undefined;
          const tables = await withSource(source, (s) => s.listTables(schema));
          return ok(tables, { count: tables.length });
        }

        case 'dataparity_describe_table': {
          const source = z.string().parse(args.source);
          const table = z.string().parse(args.table);
          const info = await withSource(source, (s) => s.describeTable(table));
          return ok(info);
        }

        case 'dataparity_diff': {
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
            const available = config.sources.map((s) => s.name).join(', ') || 'none';
            return fail(
              'UNKNOWN_SOURCE',
              `Unknown source. Configured sources: ${available}`,
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
            const text = format === 'text' ? formatReport(report) : formatJson(report);
            return {
              content: [{ type: 'text', text }],
            };
          } finally {
            await leftSource.close();
            await rightSource.close();
          }
        }

        default:
          return fail('BAD_INPUT', `Unknown tool: ${name}`);
      }
    } catch (err) {
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
