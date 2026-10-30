// Scale benchmark for the cross-database diff.
//
// The headline claim of dataparity is that a table differing in a few rows
// transfers a few hashes rather than the whole table. That claim has never
// been tested on more than a few dozen rows.
//
// This measures it: how long the diff takes, and — the important part — how
// many rows each query actually pulls back.
import { diffTables, DuckdbSource, PostgresSource } from '../dist/index.js';

const PG = process.env.DATAPARITY_TEST_PG ?? 'postgres://postgres:test@localhost:55432/difftest';
const ROWS = Number(process.env.BENCH_ROWS ?? 1_000_000);
const CHANGED = Number(process.env.BENCH_CHANGED ?? 10);

const pg = await PostgresSource.connect({ connectionString: PG });

// Count how many rows each query returns, so we can see what crosses the wire.
let pulled = 0;
const origQuery = pg.query.bind(pg);
pg.query = async (sql, params) => {
  const rows = await origQuery(sql, params);
  // The row-hash expansion query is the one that can pull a lot.
  if (sql.includes('__hash')) {
    pulled += rows.length;
  }
  return rows;
};

console.log(`generating ${ROWS.toLocaleString('en-US')} rows in Postgres...`);
let t = Date.now();
await pg.query('drop table if exists bench_left');
await pg.query('drop table if exists bench_right');
await pg.query(
  `create table bench_left(id int primary key, country varchar(4), amount double precision, active boolean)`,
);
await pg.query(
  `create table bench_right(id int primary key, country varchar(4), amount double precision, active boolean)`,
);
// Two passes: one for the left side, one for the right with a few rows changed.
await pg.query(
  `insert into bench_left
   select i,
          case when i % 3 = 0 then 'DE' when i % 3 = 1 then 'US' else 'FR' end,
          (i % 1000) / 7.0,
          (i % 2 = 0)
     from generate_series(1, ${ROWS}) g(i)`,
);
await pg.query(
  `insert into bench_right
   select i,
          case when i % 3 = 0 then 'DE' when i % 3 = 1 then 'US' else 'FR' end,
          (i % 1000) / 7.0,
          (i % 2 = 0)
     from generate_series(1, ${ROWS}) g(i)`,
);
// Change a handful of rows on the right.
await pg.query(
  `update bench_right set amount = amount + 1 where id in (select i from generate_series(1, ${ROWS}) g(i) where i % ${Math.floor(ROWS / CHANGED)} = 0 limit ${CHANGED})`,
);
console.log(`  ${Date.now() - t} ms`);

// The right side is read straight out of Postgres by DuckDB, through its
// postgres scanner. That is the realistic shape of a cross-engine diff: one
// side is a warehouse, the other is an engine that can query it.
t = Date.now();
const duckFile = await DuckdbSource.open();
await duckFile.query(
  `attach 'host=localhost port=55432 dbname=difftest user=postgres password=test' as pg (type postgres, read_only)`,
);
await duckFile.query('create view bench_right as select * from pg.public.bench_right');
console.log(`attached Postgres in DuckDB in ${Date.now() - t} ms`);

const duckTables = await duckFile.listTables();
const rightTable = duckTables.find((t) => t.name === 'bench_right')?.name;
console.log(`duckdb sees: ${duckTables.map((t) => t.name).join(', ')}`);

// --- the diff ---
pulled = 0;
t = Date.now();
const report = await diffTables(pg, 'public.bench_left', duckFile, rightTable, {
  keyColumns: ['id'],
});
const elapsed = Date.now() - t;

console.log('\n=== RESULT ===');
console.log(`rows compared      ${report.rowCounts.left.toLocaleString('en-US')} vs ${report.rowCounts.right.toLocaleString('en-US')}`);
console.log(`elapsed            ${elapsed} ms`);
console.log(`summary            ${JSON.stringify(report.summary)}`);
console.log(`hashes pulled      ${pulled.toLocaleString('en-US')}  (${((pulled / report.rowCounts.left) * 100).toFixed(2)}% of the table)`);
console.log(`left checksum      ${report.left.checksum}`);
console.log(`right checksum     ${report.right.checksum}`);
console.log(`identical          ${report.identical}`);

const correct = report.summary.modified === CHANGED;
console.log(`\nexpected ${CHANGED} modified rows, got ${report.summary.modified} — ${correct ? 'CORRECT' : 'WRONG'}`);

await pg.close();
await duckFile.close();
process.exit(correct ? 0 : 1);
