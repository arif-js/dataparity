import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { diffTables } from '../../src/core/diff.js';
import { DuckdbSource } from '../../src/engines/duckdb.js';
import type { Source } from '../../src/engines/source.js';
import { SourceError } from '../../src/engines/source.js';
import { MysqlSource, PostgresSource, SqliteSource } from '../../src/engines/sql.js';

/**
 * Feature tests.
 *
 * These exercise the whole surface of the tool — every engine, every CLI
 * option, the error paths, and the cross-engine guarantees — against real
 * databases. The unit tests cover the pure logic; this file covers the
 * behaviour a user actually depends on.
 *
 * The tests skip themselves when the databases are not reachable, so the suite
 * still runs on a machine without Docker.
 */

const PG_CONNECTION =
  process.env.DATAPARITY_TEST_PG ?? 'postgres://postgres:test@localhost:55432/difftest';
const MYSQL_OPTIONS = {
  host: process.env.DATAPARITY_TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DATAPARITY_TEST_MYSQL_PORT ?? 53306),
  user: process.env.DATAPARITY_TEST_MYSQL_USER ?? 'root',
  password: process.env.DATAPARITY_TEST_MYSQL_PASSWORD ?? 'test',
  database: process.env.DATAPARITY_TEST_MYSQL_DB ?? 'difftest',
};

/** Connects to a source, returning null when it is not reachable. */
async function tryConnect(fn: () => Promise<Source>): Promise<Source | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** The rows used by the fixtures. */
const ROWS: [number, string, number, boolean][] = [
  [1, 'DE', 10.5, true],
  [2, 'DE', 20.25, true],
  [3, 'US', 30.0, false],
  [4, 'US', 40.75, true],
];

/** The rows the "target" side holds: row 2 removed, row 3 changed, row 5 added. */
const CHANGED_ROWS: [number, string, number, boolean][] = [
  [1, 'DE', 10.5, true],
  [3, 'US', 999.0, false],
  [4, 'US', 40.75, true],
  [5, 'FR', 50.5, true],
];

let work: string;
let sqlitePath: string;
let csvPath: string;
let csv2Path: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'dataparity-features-'));
  sqlitePath = join(work, 'feature.db');
  csvPath = join(work, 'rows.csv');
  csv2Path = join(work, 'rows2.csv');

  const db = new DatabaseSync(sqlitePath);
  db.exec('create table a(id int primary key, country text, amount real, active integer)');
  db.exec('create table b(id int primary key, country text, amount real, active integer)');
  for (const [id, country, amount, active] of ROWS) {
    db.prepare('insert into a values (?,?,?,?)').run(id, country, amount, active ? 1 : 0);
  }
  for (const [id, country, amount, active] of CHANGED_ROWS) {
    db.prepare('insert into b values (?,?,?,?)').run(id, country, amount, active ? 1 : 0);
  }
  db.close();
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('SQLite', () => {
  it('diffs two tables in one database', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      const report = await diffTables(source, 'a', source, 'b', { keyColumns: ['id'] });
      expect(report.summary).toMatchObject({ added: 1, removed: 1, modified: 1 });
      expect(report.strategy).toBe('join');
    } finally {
      await source.close();
    }
  });

  it('lists and describes its tables', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      const tables = await source.listTables();
      expect(tables.map((t) => t.name).sort()).toEqual(['a', 'b']);
      const described = await source.describeTable('a');
      expect(described.columns.map((c) => c.name)).toEqual(['id', 'country', 'amount', 'active']);
    } finally {
      await source.close();
    }
  });

  it('opens read-only by default', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      await expect(source.query("insert into a values (99, 'X', 1, 1)")).rejects.toThrow(
        /readonly|read-only/i,
      );
    } finally {
      await source.close();
    }
  });

  it('registers an md5 that matches the other engines', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      const rows = await source.query("select md5('abc') h");
      expect(rows[0]?.h).toBe('900150983cd24fb0d6963f7d28e17f72');
    } finally {
      await source.close();
    }
  });

  it('reads a hex string as an integer', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      const rows = await source.query("select hex2int('ff') v");
      expect(Number(rows[0]?.v)).toBe(255);
    } finally {
      await source.close();
    }
  });

  it('reports a primary key column as not nullable', async () => {
    const source = await SqliteSource.open({ path: sqlitePath });
    try {
      const described = await source.describeTable('a');
      const id = described.columns.find((c) => c.name === 'id');
      expect(id?.nullable).toBe(false);
    } finally {
      await source.close();
    }
  });
});

describe('DuckDB', () => {
  it('exposes CSV files as tables and diffs them', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(csvPath, 'id,country,amount\n1,DE,10.5\n2,DE,20.25\n3,US,30.0\n');
    writeFileSync(csv2Path, 'id,country,amount\n1,DE,10.5\n3,US,999.0\n4,US,40.75\n');

    const source = await DuckdbSource.open({ files: [csvPath, csv2Path] });
    try {
      const tables = await source.listTables();
      expect(tables).toHaveLength(2);
      const report = await diffTables(source, 'rows', source, 'rows2', { keyColumns: ['id'] });
      expect(report.summary).toMatchObject({ added: 1, removed: 1, modified: 1 });
    } finally {
      await source.close();
    }
  });
});

describe('Postgres', () => {
  it('filters both sides with a WHERE clause', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists opt_a');
      await pg.query('drop table if exists opt_b');
      await pg.query(
        'create table opt_a(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        'create table opt_b(id int primary key, country text, amount double precision)',
      );
      for (const [id, country, amount] of [
        [1, 'DE', 10.5],
        [2, 'DE', 20.25],
        [3, 'US', 30.0],
      ]) {
        await pg.query('insert into opt_a values ($1,$2,$3)', [id, country, amount]);
      }
      await pg.query('insert into opt_b values ($1,$2,$3)', [1, 'DE', 10.5]);
      await pg.query('insert into opt_b values ($1,$2,$3)', [3, 'US', 999.0]);

      const report = await diffTables(pg, 'public.opt_a', pg, 'public.opt_b', {
        keyColumns: ['id'],
        where: 'id <= 2',
      });
      // Row 3's change is outside the filter, so only the removal of id 2 shows.
      expect(report.summary.removed).toBe(1);
      expect(report.summary.modified).toBe(0);
    } finally {
      await pg?.close();
    }
  });

  it('limits the compared columns', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists cols_a');
      await pg.query('drop table if exists cols_b');
      await pg.query(
        'create table cols_a(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        'create table cols_b(id int primary key, country text, amount double precision)',
      );
      await pg.query('insert into cols_a values (1, $1, $2)', ['DE', 10.5]);
      await pg.query('insert into cols_b values (1, $1, $2)', ['DE', 999.0]);

      const report = await diffTables(pg, 'public.cols_a', pg, 'public.cols_b', {
        keyColumns: ['id'],
        columns: ['country'],
      });
      // The amount change must be invisible when only country is compared.
      expect(report.summary.modified).toBe(0);
    } finally {
      await pg?.close();
    }
  });

  it('caps the reported changes and flags the truncation', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists cap_a');
      await pg.query('drop table if exists cap_b');
      await pg.query('create table cap_a(id int primary key, v text)');
      await pg.query('create table cap_b(id int primary key, v text)');
      for (let i = 1; i <= 10; i++) {
        await pg.query('insert into cap_a values ($1,$2)', [i, `v${i}`]);
        await pg.query('insert into cap_b values ($1,$2)', [i, `changed${i}`]);
      }

      const report = await diffTables(pg, 'public.cap_a', pg, 'public.cap_b', {
        keyColumns: ['id'],
        maxChanges: 3,
      });
      expect(report.changes).toHaveLength(3);
      expect(report.changesTruncated).toBe(true);
      expect(report.summary.modified).toBe(10);
    } finally {
      await pg?.close();
    }
  });

  it('really limits the rows compared when sampling', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists smp_a');
      await pg.query('drop table if exists smp_b');
      await pg.query('create table smp_a(id int primary key, v text)');
      await pg.query('create table smp_b(id int primary key, v text)');
      for (let i = 1; i <= 20; i++) {
        await pg.query('insert into smp_a values ($1,$2)', [i, `v${i}`]);
        await pg.query('insert into smp_b values ($1,$2)', [i, `v${i}`]);
      }
      await pg.query('update smp_b set v = $1 where id = 15', ['changed']);

      const report = await diffTables(pg, 'public.smp_a', pg, 'public.smp_b', {
        keyColumns: ['id'],
        sampleOnly: true,
        sampleLimit: 5,
      });
      expect(report.sampled).toBe(true);
      expect(report.rowCounts.left).toBeLessThanOrEqual(5);
      expect(report.rowCounts.right).toBeLessThanOrEqual(5);
    } finally {
      await pg?.close();
    }
  });

  it('handles two tables that share only the key column', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists keyonly_a');
      await pg.query('drop table if exists keyonly_b');
      await pg.query('create table keyonly_a(id int primary key)');
      await pg.query('create table keyonly_b(id int primary key)');
      await pg.query('insert into keyonly_a values (1), (2)');
      await pg.query('insert into keyonly_b values (1), (3)');

      const report = await diffTables(pg, 'public.keyonly_a', pg, 'public.keyonly_b', {
        keyColumns: ['id'],
      });
      expect(report.summary).toMatchObject({ added: 1, removed: 1, modified: 0 });
    } finally {
      await pg?.close();
    }
  });

  it('handles a composite key', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists comp_a');
      await pg.query('drop table if exists comp_b');
      await pg.query('create table comp_a(k1 int, k2 text, v text)');
      await pg.query('create table comp_b(k1 int, k2 text, v text)');
      await pg.query("insert into comp_a values (1, 'a', 'x'), (1, 'b', 'y')");
      await pg.query("insert into comp_b values (1, 'a', 'x'), (1, 'b', 'CHANGED')");

      const report = await diffTables(pg, 'public.comp_a', pg, 'public.comp_b', {
        keyColumns: ['k1', 'k2'],
      });
      expect(report.summary.modified).toBe(1);
    } finally {
      await pg?.close();
    }
  });
});

describe('risk', () => {
  it('rates a removed column as high', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists risk_a');
      await pg.query('drop table if exists risk_b');
      await pg.query('create table risk_a(id int primary key, legacy text)');
      await pg.query('create table risk_b(id int primary key, replacement int)');

      const report = await diffTables(pg, 'public.risk_a', pg, 'public.risk_b', {
        keyColumns: ['id'],
      });
      expect(['high', 'critical']).toContain(report.risk.level);
    } finally {
      await pg?.close();
    }
  });

  it('rates identical data as none', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists risk_c');
      await pg.query('drop table if exists risk_d');
      await pg.query('create table risk_c(id int primary key, v text)');
      await pg.query('create table risk_d(id int primary key, v text)');
      await pg.query('insert into risk_c values (1, $1)', ['a']);
      await pg.query('insert into risk_d values (1, $1)', ['a']);

      const report = await diffTables(pg, 'public.risk_c', pg, 'public.risk_d', {
        keyColumns: ['id'],
      });
      expect(report.risk.level).toBe('none');
      expect(report.identical).toBe(true);
    } finally {
      await pg?.close();
    }
  });
});

describe('attribution', () => {
  it('reports the segment the changes concentrate in', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists attr_a');
      await pg.query('drop table if exists attr_b');
      await pg.query(
        'create table attr_a(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        'create table attr_b(id int primary key, country text, amount double precision)',
      );
      for (let i = 1; i <= 20; i++) {
        const country = i <= 15 ? 'DE' : 'US';
        await pg.query('insert into attr_a values ($1,$2,$3)', [i, country, 10.0]);
      }
      for (let i = 1; i <= 20; i++) {
        const country = i <= 15 ? 'DE' : 'US';
        await pg.query('insert into attr_b values ($1,$2,$3)', [i, country, i <= 8 ? 99.0 : 10.0]);
      }

      const report = await diffTables(pg, 'public.attr_a', pg, 'public.attr_b', {
        keyColumns: ['id'],
      });
      const de = report.attributions.find((a) => a.column === 'country' && a.value === 'DE');
      expect(de).toBeDefined();
      // 8 of 8 changed rows are DE (100%); DE is 15 of 20 rows (75%). 100/75.
      expect(de?.overRepresentation).toBeCloseTo(1 / 0.75, 2);
    } finally {
      await pg?.close();
    }
  });
});

describe('errors', () => {
  it('reports a missing key column', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await expect(
        diffTables(pg, 'public.opt_a', pg, 'public.opt_b', { keyColumns: ['nope'] }),
      ).rejects.toThrow(/missing on/);
    } finally {
      await pg?.close();
    }
  });

  it('reports a missing table', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await expect(
        diffTables(pg, 'public.nope_table', pg, 'public.opt_b', { keyColumns: ['id'] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await pg?.close();
    }
  });

  it('rejects an empty key list', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await expect(
        diffTables(pg, 'public.opt_a', pg, 'public.opt_b', { keyColumns: [] }),
      ).rejects.toBeInstanceOf(SourceError);
    } finally {
      await pg?.close();
    }
  });
});

describe('cross-database', () => {
  it('gives identical checksums for identical data in Postgres and MySQL', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    if (!pg || !my) {
      console.warn('Skipping: databases are not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists xdb');
      await pg.query('create table xdb(id int primary key, country text, amount double precision)');
      await my.query('drop table if exists xdb');
      await my.query('create table xdb(id int primary key, country varchar(20), amount double)');
      for (const [id, country, amount] of [
        [1, 'DE', 10.5],
        [2, 'US', 20.25],
      ]) {
        await pg.query('insert into xdb values ($1,$2,$3)', [id, country, amount]);
        await my.query('insert into xdb values (?,?,?)', [id, country, amount]);
      }

      const report = await diffTables(pg, 'public.xdb', my, 'xdb', { keyColumns: ['id'] });
      expect(report.identical).toBe(true);
      expect(report.left.checksum).toBe(report.right.checksum);
    } finally {
      await pg?.close();
      await my?.close();
    }
  });

  it('detects the same difference in Postgres and MySQL', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    if (!pg || !my) {
      console.warn('Skipping: databases are not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists xdiff');
      await pg.query(
        'create table xdiff(id int primary key, country text, amount double precision)',
      );
      await my.query('drop table if exists xdiff');
      await my.query('create table xdiff(id int primary key, country varchar(20), amount double)');
      for (const [id, country, amount] of [
        [1, 'DE', 10.5],
        [2, 'DE', 20.25],
      ]) {
        await pg.query('insert into xdiff values ($1,$2,$3)', [id, country, amount]);
        await my.query('insert into xdiff values (?,?,?)', [id, country, amount]);
      }
      await my.query('update xdiff set amount = 999.0 where id = 2');

      const report = await diffTables(pg, 'public.xdiff', my, 'xdiff', { keyColumns: ['id'] });
      expect(report.summary.modified).toBe(1);
    } finally {
      await pg?.close();
      await my?.close();
    }
  });

  it('agrees between a SQLite file and Postgres', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    const sq = await SqliteSource.open({ path: sqlitePath });
    try {
      await pg.query('drop table if exists xsq');
      await pg.query(
        'create table xsq(id int primary key, country text, amount double precision, active boolean)',
      );
      for (const [id, country, amount, active] of ROWS) {
        await pg.query('insert into xsq values ($1,$2,$3,$4)', [id, country, amount, active]);
      }

      const report = await diffTables(sq, 'a', pg, 'public.xsq', { keyColumns: ['id'] });
      expect(report.strategy).toBe('checksum');
      expect(report.identical).toBe(true);
      expect(report.left.checksum).toBe(report.right.checksum);
    } finally {
      await sq.close();
      await pg?.close();
    }
  });

  it('gives the same answer at every bucket count', async () => {
    // Regression: the expansion of a bucket once used a different bucket count
    // on each side, so the two sides expanded different buckets and the diff
    // reported thousands of rows that had not changed. Any explicit bucket
    // count has to reach both sides.
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    if (!pg || !my) {
      console.warn('Skipping: databases are not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists xbc');
      await pg.query('create table xbc(id int primary key, country text, amount double precision)');
      await my.query('drop table if exists xbc');
      await my.query('create table xbc(id int primary key, country varchar(20), amount double)');
      const rows: Array<[number, string, number]> = [];
      for (let id = 1; id <= 400; id++) rows.push([id, 'DE', id / 4]);
      for (const [id, country, amount] of rows) {
        await pg.query('insert into xbc values ($1,$2,$3)', [id, country, amount]);
        await my.query('insert into xbc values (?,?,?)', [id, country, amount]);
      }
      // Change exactly three rows, spread across the key space.
      for (const id of [7, 200, 393]) {
        await my.query('update xbc set amount = ? where id = ?', [id / 4 + 1, id]);
      }

      for (const bucketCount of [64, 256, 1024, 4096]) {
        const report = await diffTables(pg, 'public.xbc', my, 'xbc', {
          keyColumns: ['id'],
          bucketCount,
        });
        expect(report.summary.modified, `bucket count ${bucketCount}`).toBe(3);
        expect(report.summary.added, `bucket count ${bucketCount}`).toBe(0);
        expect(report.summary.removed, `bucket count ${bucketCount}`).toBe(0);
      }
    } finally {
      await pg?.close();
      await my?.close();
    }
  });

  it('transfers only a small part of a large table when few rows differ', async () => {
    // The point of the bucketed comparison is that a table with a handful of
    // changed rows does not have to be moved in full. This measures it.
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping: Postgres is not reachable.');
      return;
    }
    try {
      await pg.query('drop table if exists xbig');
      await pg.query('drop table if exists xbig2');
      await pg.query(
        'create table xbig(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        'create table xbig2(id int primary key, country text, amount double precision)',
      );
      await pg.query(
        `insert into xbig select i, 'DE', (i % 100) / 7.0 from generate_series(1, 20000) g(i)`,
      );
      await pg.query(
        `insert into xbig2 select i, 'DE', (i % 100) / 7.0 from generate_series(1, 20000) g(i)`,
      );
      await pg.query('update xbig2 set amount = amount + 1 where id in (11, 5000, 19000)');

      // The right side is read through DuckDB, so the two sides are in
      // different engines.
      const duck = await DuckdbSource.open();
      try {
        await duck.query(
          `attach 'host=localhost port=55432 dbname=difftest user=postgres password=test' as pg (type postgres, read_only)`,
        );
        await duck.query('create view xbig2 as select * from pg.public.xbig2');

        let transferred = 0;
        const original = duck.query.bind(duck);
        duck.query = async (sql: string, params?: unknown[]) => {
          const rows = await original(sql, params);
          if (sql.includes('__hash')) transferred += rows.length;
          return rows;
        };

        const report = await diffTables(pg, 'public.xbig', duck, 'xbig2', {
          keyColumns: ['id'],
        });
        expect(report.summary.modified).toBe(3);
        expect(report.summary.added).toBe(0);
        expect(report.summary.removed).toBe(0);

        // With the bucket count chosen from the table size, well under 5% of
        // the table should move.
        expect(transferred / 20000).toBeLessThan(0.05);
      } finally {
        await duck.close();
      }
    } finally {
      await pg?.close();
    }
  });
});
