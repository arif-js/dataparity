// Feature audit: exercise every documented surface and report what breaks.
// Run with: node scripts/audit-features.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  diffTables,
  PostgresSource,
  MysqlSource,
  SqliteSource,
  DuckdbSource,
  findSource,
  formatJson,
  formatReport,
  hashRow,
  loadConfig,
  openSource,
  SourceError,
} from '../dist/index.js';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message.split('\n')[0].slice(0, 160) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message.split('\n')[0].slice(0, 160) });
  }
}

// The same environment variables the integration suite uses, so both point at
// the same databases. The defaults match the Docker containers in the README.
const PG = process.env.DATAPARITY_TEST_PG ?? 'postgres://postgres:test@localhost:55432/difftest';
const MY = {
  host: process.env.DATAPARITY_TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DATAPARITY_TEST_MYSQL_PORT ?? 53306),
  user: process.env.DATAPARITY_TEST_MYSQL_USER ?? 'root',
  password: process.env.DATAPARITY_TEST_MYSQL_PASSWORD ?? 'test',
  database: process.env.DATAPARITY_TEST_MYSQL_DB ?? 'difftest',
};

// ---------------------------------------------------------------- fixtures
const work = mkdtempSync(join(tmpdir(), 'dp-audit-'));
const sqlitePath = join(work, 'audit.db');
{
  const db = new DatabaseSync(sqlitePath);
  db.exec('create table a(id int primary key, country text, amount real, active integer)');
  db.exec('create table b(id int primary key, country text, amount real, active integer)');
  for (const r of [
    [1, 'DE', 10.5, 1],
    [2, 'DE', 20.25, 1],
    [3, 'US', 30.0, 0],
    [4, 'US', 40.75, 1],
  ]) {
    db.prepare('insert into a values (?,?,?,?)').run(...r);
  }
  for (const r of [
    [1, 'DE', 10.5, 1],
    [3, 'US', 999.0, 0],
    [4, 'US', 40.75, 1],
    [5, 'FR', 50.5, 1],
  ]) {
    db.prepare('insert into b values (?,?,?,?)').run(...r);
  }
  db.close();
}

const csv = join(work, 'rows.csv');
const csv2 = join(work, 'rows2.csv');
writeFileSync(csv, 'id,country,amount\n1,DE,10.5\n2,DE,20.25\n3,US,30.0\n');
writeFileSync(csv2, 'id,country,amount\n1,DE,10.5\n3,US,999.0\n4,US,40.75\n');

// ---------------------------------------------------------------- 1. SQLite
const sqlite = await SqliteSource.open({ path: sqlitePath });
await checkAsync('SQLite: diff two tables in one database', async () => {
  const r = await diffTables(sqlite, 'a', sqlite, 'b', { keyColumns: ['id'] });
  if (r.summary.added !== 1 || r.summary.removed !== 1 || r.summary.modified !== 1) {
    throw new Error(`wrong summary: ${JSON.stringify(r.summary)}`);
  }
  return `added=${r.summary.added} removed=${r.summary.removed} modified=${r.summary.modified}`;
});
await checkAsync('SQLite: listTables', async () => {
  const t = await sqlite.listTables();
  if (t.length !== 2) throw new Error(`expected 2 tables, got ${t.length}`);
  return t.map((x) => x.name).join(',');
});
await checkAsync('SQLite: describeTable', async () => {
  const t = await sqlite.describeTable('a');
  if (t.columns.length !== 4) throw new Error(`expected 4 columns, got ${t.columns.length}`);
  return t.columns.map((c) => `${c.name}:${c.kind}`).join(',');
});
await checkAsync('SQLite: opens read-only by default', async () => {
  try {
    await sqlite.query("insert into a values (99, 'X', 1, 1)");
    throw new Error('write succeeded but should have been refused');
  } catch (err) {
    if (/write succeeded/.test(err.message)) throw err;
    if (!/readonly|read-only/i.test(err.message)) throw err;
    return 'write refused';
  }
});
await checkAsync('SQLite: computes a row hash identical to the other engines', async () => {
  const rows = await sqlite.query("select md5('abc') h");
  if (rows[0].h !== '900150983cd24fb0d6963f7d28e17f72') {
    throw new Error(`md5 mismatch: ${rows[0].h}`);
  }
  return 'md5 matches';
});
await checkAsync('SQLite: reads a hex string as an integer', async () => {
  const rows = await sqlite.query("select hex2int('ff') v");
  if (Number(rows[0].v) !== 255) throw new Error(`hex2int returned ${rows[0].v}`);
  return 'hex2int ok';
});
await sqlite.close();

// ---------------------------------------------------------------- 2. DuckDB files
const duck = await DuckdbSource.open({ files: [csv, csv2] });
await checkAsync('DuckDB: exposes CSV files as tables', async () => {
  const t = await duck.listTables();
  if (t.length !== 2) throw new Error(`expected 2 tables, got ${t.length}`);
  return t.map((x) => x.name).join(',');
});
await checkAsync('DuckDB: diffs two CSV files', async () => {
  const r = await diffTables(duck, 'rows', duck, 'rows2', { keyColumns: ['id'] });
  if (r.summary.added !== 1 || r.summary.removed !== 1 || r.summary.modified !== 1) {
    throw new Error(`wrong summary: ${JSON.stringify(r.summary)}`);
  }
  return `added=${r.summary.added} removed=${r.summary.removed} modified=${r.summary.modified}`;
});
await duck.close();

// ---------------------------------------------------------------- 3. Postgres / MySQL
const pg = await PostgresSource.connect({ connectionString: PG });
const my = await MysqlSource.connect(MY);

await pg.query('drop table if exists feat_a');
await pg.query('drop table if exists feat_b');
await pg.query('create table feat_a(id int primary key, country text, amount double precision, active boolean)');
await pg.query('create table feat_b(id int primary key, country text, amount double precision, active boolean)');
for (const [id, country, amount, active] of [
  [1, 'DE', 10.5, true],
  [2, 'DE', 20.25, true],
  [3, 'US', 30.0, false],
  [4, 'US', 40.75, true],
]) {
  await pg.query('insert into feat_a values ($1,$2,$3,$4)', [id, country, amount, active]);
}
for (const [id, country, amount, active] of [
  [1, 'DE', 10.5, true],
  [3, 'US', 999.0, false],
  [4, 'US', 40.75, true],
  [5, 'FR', 50.5, true],
]) {
  await pg.query('insert into feat_b values ($1,$2,$3,$4)', [id, country, amount, active]);
}

await checkAsync('Postgres: --where filters both sides', async () => {
  const r = await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', {
    keyColumns: ['id'],
    where: 'id <= 2',
  });
  if (r.summary.removed !== 1) throw new Error(`expected 1 removed, got ${r.summary.removed}`);
  if (r.summary.modified !== 0) throw new Error(`expected 0 modified, got ${r.summary.modified}`);
  return `removed=${r.summary.removed} modified=${r.summary.modified}`;
});

await checkAsync('Postgres: --columns limits the compared columns', async () => {
  const r = await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', {
    keyColumns: ['id'],
    columns: ['country'],
  });
  if (r.summary.modified !== 0) throw new Error(`expected 0 modified, got ${r.summary.modified}`);
  return `modified=${r.summary.modified}`;
});

await checkAsync('Postgres: --max-changes caps output and flags truncation', async () => {
  const r = await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', {
    keyColumns: ['id'],
    maxChanges: 1,
  });
  if (r.changes.length !== 1) throw new Error(`expected 1 change, got ${r.changes.length}`);
  if (!r.changesTruncated) throw new Error('truncation was not reported');
  return `changes=${r.changes.length} truncated=${r.changesTruncated}`;
});

await checkAsync('Postgres: --sample really limits the rows compared', async () => {
  const r = await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', {
    keyColumns: ['id'],
    sampleOnly: true,
    sampleLimit: 2,
  });
  if (!r.sampled) throw new Error('report was not marked as sampled');
  if (r.rowCounts.left > 2) throw new Error(`compared ${r.rowCounts.left} rows, limit was 2`);
  if (r.rowCounts.right > 2) throw new Error(`compared ${r.rowCounts.right} rows, limit was 2`);
  return `sampled=${r.sampled} leftRows=${r.rowCounts.left} rightRows=${r.rowCounts.right}`;
});

await checkAsync('Attribution: reports the segment the changes concentrate in', async () => {
  await pg.query('drop table if exists attr_a');
  await pg.query('drop table if exists attr_b');
  await pg.query('create table attr_a(id int primary key, country text, amount double precision)');
  await pg.query('create table attr_b(id int primary key, country text, amount double precision)');
  for (let i = 1; i <= 20; i++) {
    const country = i <= 15 ? 'DE' : 'US';
    await pg.query('insert into attr_a values ($1,$2,$3)', [i, country, 10.0]);
  }
  for (let i = 1; i <= 20; i++) {
    const country = i <= 15 ? 'DE' : 'US';
    const amount = i <= 8 ? 99.0 : 10.0;
    await pg.query('insert into attr_b values ($1,$2,$3)', [i, country, amount]);
  }
  const r = await diffTables(pg, 'public.attr_a', pg, 'public.attr_b', { keyColumns: ['id'] });
  const de = r.attributions.find((a) => a.column === 'country' && a.value === 'DE');
  if (!de) throw new Error(`no DE attribution, got ${JSON.stringify(r.attributions)}`);
  // 8 of 8 changed rows are DE (100%); DE is 15 of 20 rows (75%). 100/75 = 1.33x.
  const expected = 1 / 0.75;
  if (Math.abs(de.overRepresentation - expected) > 0.01) {
    throw new Error(`over-representation ${de.overRepresentation}, expected ${expected}`);
  }
  return `DE ${de.count} changes, ${de.overRepresentation.toFixed(2)}x (expected ${expected.toFixed(2)}x)`;
});

await checkAsync('Risk: a breaking schema change is at least high', async () => {
  await pg.query('drop table if exists risk_a');
  await pg.query('drop table if exists risk_b');
  await pg.query('create table risk_a(id int primary key, legacy text)');
  await pg.query('create table risk_b(id int primary key, replacement int)');
  const r = await diffTables(pg, 'public.risk_a', pg, 'public.risk_b', { keyColumns: ['id'] });
  if (!['high', 'critical'].includes(r.risk.level)) {
    throw new Error(`risk level was ${r.risk.level}`);
  }
  return `level=${r.risk.level}`;
});

await checkAsync('Risk: identical data is none', async () => {
  await pg.query('drop table if exists risk_c');
  await pg.query('drop table if exists risk_d');
  await pg.query('create table risk_c(id int primary key, v text)');
  await pg.query('create table risk_d(id int primary key, v text)');
  for (const [id, v] of [
    [1, 'a'],
    [2, 'b'],
  ]) {
    await pg.query('insert into risk_c values ($1,$2)', [id, v]);
    await pg.query('insert into risk_d values ($1,$2)', [id, v]);
  }
  const r = await diffTables(pg, 'public.risk_c', pg, 'public.risk_d', { keyColumns: ['id'] });
  if (r.risk.level !== 'none') throw new Error(`risk level was ${r.risk.level}`);
  return `level=${r.risk.level}`;
});

await checkAsync('Edge: two tables sharing only the key column do not break', async () => {
  await pg.query('drop table if exists onlykey_a');
  await pg.query('drop table if exists onlykey_b');
  await pg.query('create table onlykey_a(id int primary key)');
  await pg.query('create table onlykey_b(id int primary key)');
  await pg.query('insert into onlykey_a values (1), (2)');
  await pg.query('insert into onlykey_b values (1), (3)');
  const r = await diffTables(pg, 'public.onlykey_a', pg, 'public.onlykey_b', {
    keyColumns: ['id'],
  });
  if (r.summary.added !== 1 || r.summary.removed !== 1) {
    throw new Error(`summary was ${JSON.stringify(r.summary)}`);
  }
  return `added=${r.summary.added} removed=${r.summary.removed} modified=${r.summary.modified}`;
});

await checkAsync('Display: a float change is shown in the units the user wrote', async () => {
  // The canonical form of a float is an integer count of millionths, because
  // that is the only form that agrees across engines. The report has to undo
  // that scaling, or it shows `30000000` where the user wrote `30`.
  await pg.query('drop table if exists disp_a');
  await pg.query('drop table if exists disp_b');
  await pg.query('create table disp_a(id int primary key, amount double precision)');
  await pg.query('create table disp_b(id int primary key, amount double precision)');
  await pg.query('insert into disp_a values (1, $1)', [30]);
  await pg.query('insert into disp_b values (1, $1)', [999]);
  const r = await diffTables(pg, 'public.disp_a', pg, 'public.disp_b', { keyColumns: ['id'] });
  const amount = r.changes.find((c) => c.kind === 'modified')?.columns?.find((c) => c.column === 'amount');
  if (amount?.before !== '30' || amount?.after !== '999') {
    throw new Error(`shown as ${amount?.before} -> ${amount?.after}, expected 30 -> 999`);
  }
  return `before=${amount.before} after=${amount.after}`;
});

await checkAsync('Edge: a composite key works', async () => {
  await pg.query('drop table if exists ck_a');
  await pg.query('drop table if exists ck_b');
  await pg.query('create table ck_a(k1 int, k2 text, v text)');
  await pg.query('create table ck_b(k1 int, k2 text, v text)');
  await pg.query("insert into ck_a values (1, 'a', 'x'), (1, 'b', 'y')");
  await pg.query("insert into ck_b values (1, 'a', 'x'), (1, 'b', 'CHANGED')");
  const r = await diffTables(pg, 'public.ck_a', pg, 'public.ck_b', {
    keyColumns: ['k1', 'k2'],
  });
  if (r.summary.modified !== 1) throw new Error(`modified=${r.summary.modified}`);
  return `modified=${r.summary.modified}`;
});

await checkAsync('Error: a missing key column is reported, not crashed on', async () => {
  try {
    await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', { keyColumns: ['nope'] });
    throw new Error('expected an error');
  } catch (err) {
    if (!(err instanceof SourceError)) throw new Error(`wrong error type: ${err.constructor.name}`);
    if (!/missing on/.test(err.message)) throw err;
    return err.code;
  }
});

await checkAsync('Error: a missing table is reported', async () => {
  try {
    await diffTables(pg, 'public.nope_table', pg, 'public.feat_b', { keyColumns: ['id'] });
    throw new Error('expected an error');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw new Error(`code was ${err.code}`);
    return err.code;
  }
});

await checkAsync('Error: no key columns is rejected', async () => {
  try {
    await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', { keyColumns: [] });
    throw new Error('expected an error');
  } catch (err) {
    return err.message.slice(0, 50);
  }
});

await checkAsync('Config: env override replaces the connection string', async () => {
  const cfgPath = join(work, 'config.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      sources: [{ name: 'pg', type: 'postgres', connectionString: 'postgres://bogus@localhost:1/none' }],
    }),
  );
  process.env.DATAPARITY_PG_CONNECTION_STRING = PG;
  const cfg = loadConfig(cfgPath);
  if (cfg.sources[0].connectionString !== PG) {
    throw new Error('env override did not apply');
  }
  delete process.env.DATAPARITY_PG_CONNECTION_STRING;
  return 'env override applied';
});

await checkAsync('Config: openSource builds a working source from a config entry', async () => {
  const cfgPath = join(work, 'config2.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({ sources: [{ name: 'pg', type: 'postgres', connectionString: PG }] }),
  );
  const cfg = loadConfig(cfgPath);
  const src = await openSource(findSource(cfg, 'pg'));
  const rows = await src.query('select 1 as x');
  await src.close();
  if (rows[0].x !== 1) throw new Error('unexpected query result');
  return 'query ok';
});

await checkAsync('Config: an unknown source name is reported clearly', async () => {
  const cfgPath = join(work, 'config3.json');
  writeFileSync(cfgPath, JSON.stringify({ sources: [] }));
  const cfg = loadConfig(cfgPath);
  try {
    findSource(cfg, 'ghost');
    throw new Error('expected an error');
  } catch (err) {
    if (!/Unknown source/.test(err.message)) throw err;
    return err.message.slice(0, 40);
  }
});

await checkAsync('Formatting: report renders and stays parseable as JSON', async () => {
  const r = await diffTables(pg, 'public.feat_a', pg, 'public.feat_b', { keyColumns: ['id'] });
  const text = formatReport(r);
  if (!text.includes('strategy')) throw new Error('text report missing strategy line');
  const json = JSON.parse(formatJson(r));
  if (json.summary.modified !== r.summary.modified) throw new Error('json mismatch');
  return `text ${text.length} chars, json ok`;
});

await checkAsync('Hashing: the JS row hash matches the SQL row hash', async () => {
  const values = ['V1', 'Vhello'];
  const jsHash = hashRow(values);
  const rows = await pg.query(
    `select md5(concat_ws(chr(31), concat(length('${values[0]}'), ':', '${values[0]}'), concat(length('${values[1]}'), ':', '${values[1]}'))) h`,
  );
  if (jsHash !== rows[0].h) throw new Error(`js=${jsHash} sql=${rows[0].h}`);
  return 'identical';
});

await checkAsync('Checksum: the JS checksum matches the SQL checksum', async () => {
  // The SQL computes the checksum over the *row hashes* of the table, so the
  // same hashes are fed to both sides.
  const rows = await pg.query(
    'select md5(concat_ws(chr(31), cast(id as varchar))) h from generate_series(1,3) t(id)',
  );
  const hashes = rows.map((r) => String(r.h));
  const sql = await pg.query(
    `select (sum(('x' || substr(h, 1, 8))::bit(32)::bigint) % 2305843009213693951) c from (select md5(concat_ws(chr(31), cast(id as varchar))) h from generate_series(1,3) t(id)) x`,
  );
  const { checksumFromHashes } = await import('../dist/index.js');
  const js = checksumFromHashes(hashes);
  if (js !== String(sql[0].c)) throw new Error(`js=${js} sql=${sql[0].c}`);
  return `identical (${js})`;
});

await checkAsync('Cross-database: identical data gives identical checksums', async () => {
  await my.query('drop table if exists xcheck');
  await my.query('create table xcheck(id int primary key, country varchar(20), amount double)');
  await pg.query('drop table if exists xcheck');
  await pg.query('create table xcheck(id int primary key, country text, amount double precision)');
  for (const [id, country, amount] of [
    [1, 'DE', 10.5],
    [2, 'US', 20.25],
  ]) {
    await pg.query('insert into xcheck values ($1,$2,$3)', [id, country, amount]);
    await my.query('insert into xcheck values (?,?,?)', [id, country, amount]);
  }
  const r = await diffTables(pg, 'public.xcheck', my, 'xcheck', { keyColumns: ['id'] });
  if (r.left.checksum !== r.right.checksum) {
    throw new Error(`${r.left.checksum} != ${r.right.checksum}`);
  }
  if (!r.identical) throw new Error('not identical');
  return `checksum ${r.left.checksum}`;
});

await checkAsync('Cross-database: MySQL and Postgres detect the same difference', async () => {
  await my.query('drop table if exists xdiff');
  await my.query('create table xdiff(id int primary key, country varchar(20), amount double)');
  await pg.query('drop table if exists xdiff');
  await pg.query('create table xdiff(id int primary key, country text, amount double precision)');
  for (const [id, country, amount] of [
    [1, 'DE', 10.5],
    [2, 'DE', 20.25],
  ]) {
    await pg.query('insert into xdiff values ($1,$2,$3)', [id, country, amount]);
    await my.query('insert into xdiff values (?,?,?)', [id, country, amount]);
  }
  await my.query('update xdiff set amount = 999.0 where id = 2');
  const r = await diffTables(pg, 'public.xdiff', my, 'xdiff', { keyColumns: ['id'] });
  if (r.summary.modified !== 1) throw new Error(`modified=${r.summary.modified}`);
  return `modified=${r.summary.modified}`;
});

await checkAsync('Cross-database: a SQLite file and Postgres agree', async () => {
  const sqlite2 = await SqliteSource.open({ path: sqlitePath });
  await pg.query('drop table if exists xsq');
  await pg.query('create table xsq(id int primary key, country text, amount double precision, active boolean)');
  // The same rows as the SQLite fixture's table `a`.
  for (const [id, country, amount, active] of [
    [1, 'DE', 10.5, true],
    [2, 'DE', 20.25, true],
    [3, 'US', 30.0, false],
    [4, 'US', 40.75, true],
  ]) {
    await pg.query('insert into xsq values ($1,$2,$3,$4)', [id, country, amount, active]);
  }
  const r = await diffTables(sqlite2, 'a', pg, 'public.xsq', { keyColumns: ['id'] });
  if (r.strategy !== 'checksum') throw new Error(`strategy was ${r.strategy}`);
  if (!r.identical) {
    throw new Error(
      `not identical: ${JSON.stringify(r.summary)} left=${r.left.checksum} right=${r.right.checksum}`,
    );
  }
  // The two engines must also agree on the whole-table checksum.
  if (r.left.checksum !== r.right.checksum) {
    throw new Error(`checksums differ: ${r.left.checksum} vs ${r.right.checksum}`);
  }
  await sqlite2.close();
  return `checksum ${r.left.checksum}`;
});

await checkAsync('MySQL: listTables and describeTable without explicit schema', async () => {
  const tables = await my.listTables();
  if (!tables.some((t) => t.name === 'xdiff')) {
    throw new Error(`xdiff not found in ${tables.map((t) => t.name).join(',')}`);
  }
  const desc = await my.describeTable('xdiff');
  if (desc.columns.length !== 3) throw new Error(`expected 3 cols, got ${desc.columns.length}`);
  return `${tables.length} tables`;
});

await checkAsync('Timestamps: timestamptz and sub-second timestamps agree across all 4 engines', async () => {
  await pg.query('drop table if exists ts_pg');
  await pg.query('create table ts_pg(id int primary key, created_at timestamptz)');
  await pg.query("insert into ts_pg values (1, '2024-05-10 14:30:45.987654+02:00')");
  await my.query('drop table if exists ts_my');
  await my.query('create table ts_my(id int primary key, created_at datetime)');
  await my.query("insert into ts_my values (1, '2024-05-10 12:30:45')");
  const tsSqlitePath = join(work, 'ts.db');
  const tsDb = new DatabaseSync(tsSqlitePath);
  tsDb.exec('create table ts_sq(id int primary key, created_at timestamp)');
  tsDb.prepare('insert into ts_sq values (?, ?)').run(1, '2024-05-10 12:30:45.123');
  tsDb.close();
  const sqTs = await SqliteSource.open({ path: tsSqlitePath });
  const r1 = await diffTables(pg, 'public.ts_pg', my, 'ts_my', { keyColumns: ['id'] });
  const r2 = await diffTables(sqTs, 'ts_sq', my, 'ts_my', { keyColumns: ['id'] });
  await sqTs.close();
  if (r1.summary.modified !== 0 || r2.summary.modified !== 0) {
    throw new Error(`expected 0 modified: pg-my=${r1.summary.modified} sq-my=${r2.summary.modified}`);
  }
  return `checksum ${r1.left.checksum}`;
});

await checkAsync('DuckDB: two separate in-memory file sources diff correctly', async () => {
  const d1 = await DuckdbSource.open({ files: [csv] });
  const d2 = await DuckdbSource.open({ files: [csv2] });
  const r = await diffTables(d1, 'rows', d2, 'rows2', { keyColumns: ['id'] });
  await d1.close();
  await d2.close();
  if (r.strategy !== 'checksum') throw new Error(`expected checksum strategy, got ${r.strategy}`);
  if (r.summary.added !== 1 || r.summary.removed !== 1 || r.summary.modified !== 1) {
    throw new Error(`wrong summary: ${JSON.stringify(r.summary)}`);
  }
  return `strategy=${r.strategy} modified=${r.summary.modified}`;
});

await checkAsync('CLI: runs when invoked via a symlink (as npx / npm bin installs it)', async () => {
  const { symlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const binLink = join(work, 'dataparity-bin');
  symlinkSync(join(process.cwd(), 'dist/interfaces/cli/index.js'), binLink);
  const out = execFileSync(process.execPath, [binLink, '--help'], { encoding: 'utf8' });
  if (!out.includes('dataparity - cross-database data diff')) {
    throw new Error('CLI produced no output via symlink');
  }
  return 'symlink bin ok';
});

await pg.close();
await my.close();

// ---------------------------------------------------------------- report
console.log('\n=== FEATURE AUDIT ===');
let failed = 0;
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) failed++;
  console.log(`${mark}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`);

rmSync(work, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
