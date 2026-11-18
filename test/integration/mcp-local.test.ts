import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'dp-mcp-local-'));
const databasePath = join(work, 'data.sqlite');
const configPath = join(work, 'config.json');
const historyPath = join(work, 'history.sqlite');
let client: Client | undefined;

async function callTool(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const result = await c.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const text = content.find((item) => item.type === 'text')?.text ?? '';
  return {
    isError: (result as { isError?: boolean }).isError === true,
    payload: JSON.parse(text),
  };
}

describe('MCP local history and baselines', () => {
  beforeAll(async () => {
    const db = new DatabaseSync(databasePath);
    db.exec(`
      create table items(id integer primary key, label text not null);
      create table reference_items(id integer primary key, label text not null);
      insert into items values (1, 'one'), (2, 'two');
      insert into reference_items values (1, 'one'), (2, 'previous');
    `);
    db.close();
    writeFileSync(
      configPath,
      JSON.stringify({
        sources: [{ name: 'local', type: 'sqlite', path: databasePath }],
      }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'dist/interfaces/cli/index.js'), 'mcp'],
      env: {
        ...process.env,
        DATAPARITY_CONFIG: configPath,
        DATAPARITY_HISTORY_PATH: historyPath,
      },
      cwd: process.cwd(),
    });
    client = new Client({ name: 'dataparity-local-test', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('saves, lists, retrieves, and deletes full diff runs', async () => {
    const { tools } = await (client as Client).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'dataparity_compare_baseline',
      'dataparity_create_baseline',
      'dataparity_delete_baseline',
      'dataparity_delete_diff_run',
      'dataparity_describe_table',
      'dataparity_diff_tables',
      'dataparity_get_diff_run',
      'dataparity_list_baselines',
      'dataparity_list_diff_runs',
      'dataparity_list_sources',
      'dataparity_list_tables',
    ]);

    const { isError: diffError, payload: diffPayload } = await callTool(
      client as Client,
      'dataparity_diff_tables',
      {
        left: 'local',
        right: 'local',
        left_table: 'items',
        right_table: 'reference_items',
        key_columns: ['id'],
      },
    );
    expect(diffError).toBe(false);
    const runId = (diffPayload.meta as { runId: string }).runId;
    expect(runId).toBeTruthy();

    const { payload: listPayload } = await callTool(
      client as Client,
      'dataparity_list_diff_runs',
      {},
    );
    expect((listPayload.data as Array<{ id: string }>)[0]?.id).toBe(runId);

    const { payload: getPayload } = await callTool(client as Client, 'dataparity_get_diff_run', {
      run_id: runId,
    });
    const savedRun = getPayload.data as {
      report: {
        identical: boolean;
        changes: Array<{ kind: string; key: string; columns?: Array<{ column: string }> }>;
      };
    };
    expect(savedRun.report.identical).toBe(false);
    expect(savedRun.report.changes).toContainEqual(
      expect.objectContaining({
        kind: 'modified',
        columns: expect.arrayContaining([expect.objectContaining({ column: 'label' })]),
      }),
    );

    const { isError } = await callTool(client as Client, 'dataparity_delete_diff_run', {
      run_id: runId,
    });
    expect(isError).toBe(false);
  });

  it('captures, compares, lists, and deletes a baseline', async () => {
    const { isError: createError, payload: createPayload } = await callTool(
      client as Client,
      'dataparity_create_baseline',
      {
        name: 'release',
        source: 'local',
        table: 'items',
        key_columns: ['id'],
      },
    );
    expect(createError).toBe(false);
    expect((createPayload.data as { rowCount: number }).rowCount).toBe(2);

    const { payload: initialPayload } = await callTool(
      client as Client,
      'dataparity_compare_baseline',
      { name: 'release', source: 'local', table: 'items' },
    );
    expect((initialPayload.data as { identical: boolean }).identical).toBe(true);

    const db = new DatabaseSync(databasePath);
    db.exec("update items set label = 'changed' where id = 2");
    db.close();

    const { payload: changedPayload } = await callTool(
      client as Client,
      'dataparity_compare_baseline',
      { name: 'release', source: 'local', table: 'items' },
    );
    const comparison = changedPayload.data as {
      identical: boolean;
      changedBucketCount: number;
      changedBucketIds: number[];
    };
    expect(comparison.identical).toBe(false);
    expect(comparison.changedBucketCount).toBeGreaterThan(0);
    expect(comparison.changedBucketIds.length).toBeGreaterThan(0);

    const { payload: listPayload } = await callTool(client as Client, 'dataparity_list_baselines', {
      source: 'local',
    });
    expect((listPayload.data as Array<{ name: string }>).map((item) => item.name)).toContain(
      'release',
    );

    const { isError } = await callTool(client as Client, 'dataparity_delete_baseline', {
      name: 'release',
    });
    expect(isError).toBe(false);
  });
});
