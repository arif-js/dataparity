import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSource } from '../../src/engines/sql.js';
import { skipTest, tryConnect } from './helpers.js';

/**
 * The MCP server, driven the way an agent drives it.
 *
 * The server is spawned as a subprocess and talked to over stdio with the
 * official client, so the test covers the real transport, the real tool
 * registration and the real JSON-RPC framing. Testing the handlers directly
 * would skip the part that breaks in practice.
 *
 * The tools take source *names*, never connection strings, so the server is
 * given a config file that points at the test database.
 */

const PG_CONNECTION =
  process.env.DATAPARITY_TEST_PG ?? 'postgres://postgres:test@localhost:55432/difftest';

const work = mkdtempSync(join(tmpdir(), 'dp-mcp-'));
const configPath = join(work, 'config.json');

let client: Client | undefined;

/** Starts the MCP server as a subprocess and connects a client to it. */
async function startServer(): Promise<Client> {
  writeFileSync(
    configPath,
    JSON.stringify({
      sources: [{ name: 'pg', type: 'postgres', connectionString: PG_CONNECTION }],
    }),
  );
  // The built CLI is what ships, and it is the entry point the MCP server
  // lives behind, so the test drives that rather than a TypeScript loader.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/interfaces/cli/index.js'), 'mcp'],
    env: { ...process.env, DATAPARITY_CONFIG: configPath },
    cwd: process.cwd(),
  });
  const c = new Client({ name: 'dataparity-test', version: '1.0.0' });
  await c.connect(transport);
  return c;
}

/** Calls a tool and returns the parsed payload. */
async function callTool(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const result = await c.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const text = content.find((x) => x.type === 'text')?.text ?? '';
  return {
    isError: (result as { isError?: boolean }).isError === true,
    payload: JSON.parse(text),
  };
}

describe('MCP server', () => {
  beforeAll(async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) return;
    try {
      await pg.query('drop table if exists mcp_a');
      await pg.query('drop table if exists mcp_b');
      await pg.query(
        'create table mcp_a(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        'create table mcp_b(id int primary key, country text, amount double precision)',
      );
      await pg.query('insert into mcp_a values (1, $1, $2), (2, $3, $4)', [
        'DE',
        10.5,
        'US',
        20.25,
      ]);
      await pg.query('insert into mcp_b values (1, $1, $2), (3, $3, $4)', ['DE', 10.5, 'FR', 5]);
    } finally {
      await pg?.close();
    }
    client = await startServer();
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('lists the four read-only tools', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'dataparity_describe_table',
      'dataparity_diff',
      'dataparity_list_sources',
      'dataparity_list_tables',
    ]);
  });

  it('lists the configured sources', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_list_sources', {});
    expect(isError).toBe(false);
    const data = payload.data as Array<{ name: string; type: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ name: 'pg', type: 'postgres' });
  });

  it('lists the tables in a source', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_list_tables', {
      source: 'pg',
    });
    expect(isError).toBe(false);
    const data = payload.data as Array<{ name: string }>;
    expect(data.map((t) => t.name)).toContain('mcp_a');
  });

  it('describes a table', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_describe_table', {
      source: 'pg',
      table: 'public.mcp_a',
    });
    expect(isError).toBe(false);
    const data = payload.data as { columns: Array<{ name: string }> };
    expect(data.columns.map((c) => c.name)).toEqual(['id', 'country', 'amount']);
  });

  it('diffs two tables', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_diff', {
      left: 'pg',
      right: 'pg',
      left_table: 'public.mcp_a',
      right_table: 'public.mcp_b',
      key_columns: ['id'],
    });
    expect(isError).toBe(false);
    const report = payload.data as { summary: { added: number; removed: number } };
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
  });

  it('reports an unknown source as an error, not a crash', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_list_tables', {
      source: 'ghost',
    });
    expect(isError).toBe(true);
    const error = payload.error as { code: string; message: string };
    expect(error.code).toBe('UNKNOWN_SOURCE');
    expect(error.message).toContain('ghost');
  });

  it('rejects a diff with no key columns', async (ctx) => {
    if (!client) {
      skipTest(ctx, 'Skipping MCP test: Postgres is not reachable.');
    }
    const { isError, payload } = await callTool(client as Client, 'dataparity_diff', {
      left: 'pg',
      right: 'pg',
      left_table: 'public.mcp_a',
      right_table: 'public.mcp_b',
      key_columns: [],
    });
    expect(isError).toBe(true);
    expect((payload.error as { code: string }).code).toBe('BAD_INPUT');
  });
});
