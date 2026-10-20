import { describe, expect, it } from 'vitest';
import { diffTables } from '../../src/core/diff.js';
import type { Source } from '../../src/engines/source.js';
import { MysqlSource, PostgresSource } from '../../src/engines/sql.js';

/**
 * End-to-end diff tests.
 *
 * These exercise the real diff engine against real databases: a same-database
 * comparison (which uses an in-database anti-join) and a cross-database
 * comparison (which compares canonical hashes).
 *
 * The tests skip themselves when the databases are not reachable.
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

/** The base dataset used by the diff fixtures. */
const BASE = [
  { id: 1, country: 'DE', amount: 10.5, active: true },
  { id: 2, country: 'DE', amount: 20.25, active: true },
  { id: 3, country: 'US', amount: 30.0, active: false },
  { id: 4, country: 'US', amount: 40.75, active: true },
  { id: 5, country: 'FR', amount: 50.5, active: false },
];

describe('same-database diff', () => {
  it('finds added, removed and modified rows in Postgres', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping same-database diff test: Postgres is not reachable.');
      return;
    }

    try {
      await pg.query('drop table if exists diff_a');
      await pg.query('drop table if exists diff_b');
      await pg.query(
        'create table diff_a(id int primary key, country text, amount double precision, active boolean)',
      );
      await pg.query(
        'create table diff_b(id int primary key, country text, amount double precision, active boolean)',
      );

      for (const row of BASE) {
        await pg.query('insert into diff_a values ($1,$2,$3,$4)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
      }
      // diff_b: id 2 removed, id 3 modified, id 6 added.
      for (const row of BASE.filter((r) => r.id !== 2)) {
        await pg.query('insert into diff_b values ($1,$2,$3,$4)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
      }
      await pg.query('update diff_b set amount = 999.0 where id = 3');
      await pg.query('insert into diff_b values (6, $1, $2, $3)', ['FR', 60.0, true]);

      const report = await diffTables(pg, 'public.diff_a', pg, 'public.diff_b', {
        keyColumns: ['id'],
      });

      expect(report.strategy).toBe('join');
      expect(report.identical).toBe(false);
      expect(report.summary.added).toBe(1);
      expect(report.summary.removed).toBe(1);
      expect(report.summary.modified).toBe(1);
      expect(report.rowCounts).toEqual({ left: 5, right: 5 });

      const removed = report.changes.find((c) => c.kind === 'removed');
      expect(removed?.key).toBe('2');

      const modified = report.changes.find((c) => c.kind === 'modified');
      expect(modified?.key).toBe('3');
      expect(modified?.columns?.map((c) => c.column)).toContain('amount');

      const added = report.changes.find((c) => c.kind === 'added');
      expect(added?.key).toBe('6');
    } finally {
      await pg?.close();
    }
  });

  it('reports no differences between identical tables', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping identical-tables test: Postgres is not reachable.');
      return;
    }

    try {
      await pg.query('drop table if exists same_a');
      await pg.query('drop table if exists same_b');
      await pg.query('create table same_a(id int, country text, amount double precision)');
      await pg.query('create table same_b(id int, country text, amount double precision)');
      for (const row of BASE) {
        await pg.query('insert into same_a values ($1,$2,$3)', [row.id, row.country, row.amount]);
        await pg.query('insert into same_b values ($1,$2,$3)', [row.id, row.country, row.amount]);
      }

      const report = await diffTables(pg, 'public.same_a', pg, 'public.same_b', {
        keyColumns: ['id'],
      });

      expect(report.identical).toBe(true);
      expect(report.summary).toMatchObject({ added: 0, removed: 0, modified: 0 });
      expect(report.risk.level).toBe('none');
    } finally {
      await pg?.close();
    }
  });

  it('detects a schema change between the two tables', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    if (!pg) {
      console.warn('Skipping schema-diff test: Postgres is not reachable.');
      return;
    }

    try {
      await pg.query('drop table if exists schema_a');
      await pg.query('drop table if exists schema_b');
      await pg.query('create table schema_a(id int, country text, legacy_col text)');
      await pg.query('create table schema_b(id int, country text, new_col int)');

      const report = await diffTables(pg, 'public.schema_a', pg, 'public.schema_b', {
        keyColumns: ['id'],
      });

      const kinds = report.schemaDifferences.map((d) => `${d.kind}:${d.column}`);
      expect(kinds).toContain('removed:legacy_col');
      expect(kinds).toContain('removed:new_col');
    } finally {
      await pg?.close();
    }
  });
});

describe('cross-database diff', () => {
  it('finds the same differences in Postgres and MySQL', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    if (!pg || !my) {
      console.warn('Skipping cross-database diff test: databases are not reachable.');
      return;
    }

    try {
      await pg.query('drop table if exists xdb_a');
      await pg.query('drop table if exists xdb_b');
      await pg.query(
        'create table xdb_a(id int primary key, country varchar(20), amount double precision, active boolean)',
      );
      await pg.query(
        'create table xdb_b(id int primary key, country varchar(20), amount double precision, active boolean)',
      );

      await my.query('drop table if exists xdb_a');
      await my.query('drop table if exists xdb_b');
      await my.query(
        'create table xdb_a(id int primary key, country varchar(20), amount double, active boolean)',
      );
      await my.query(
        'create table xdb_b(id int primary key, country varchar(20), amount double, active boolean)',
      );

      for (const row of BASE) {
        await pg.query('insert into xdb_a values ($1,$2,$3,$4)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
        await my.query('insert into xdb_a values (?,?,?,?)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
      }

      // The target side: id 2 removed, id 3 amount changed, id 6 added.
      for (const row of BASE.filter((r) => r.id !== 2)) {
        await pg.query('insert into xdb_b values ($1,$2,$3,$4)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
        await my.query('insert into xdb_b values (?,?,?,?)', [
          row.id,
          row.country,
          row.amount,
          row.active,
        ]);
      }
      await pg.query('update xdb_b set amount = 999.0 where id = 3');
      await my.query('update xdb_b set amount = 999.0 where id = 3');
      await pg.query('insert into xdb_b values (6, $1, $2, $3)', ['FR', 60.0, true]);
      await my.query('insert into xdb_b values (6, ?, ?, ?)', ['FR', 60.0, true]);

      const report = await diffTables(pg, 'public.xdb_a', my, 'xdb_b', {
        keyColumns: ['id'],
      });

      expect(report.strategy).toBe('checksum');
      expect(report.identical).toBe(false);
      expect(report.summary.added).toBe(1);
      expect(report.summary.removed).toBe(1);
      expect(report.summary.modified).toBe(1);

      // The two sides' checksums must agree when the data agrees.
      expect(report.left.checksum).not.toBeNull();
      expect(report.right.checksum).not.toBeNull();
    } finally {
      await pg?.close();
      await my?.close();
    }
  });

  it('reports identical data across two different databases', async () => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    if (!pg || !my) {
      console.warn('Skipping cross-database identity test: databases are not reachable.');
      return;
    }

    try {
      await pg.query('drop table if exists idn_a');
      await pg.query('drop table if exists idn_b');
      await pg.query('create table idn_a(id int, country text, amount double precision)');
      await pg.query('create table idn_b(id int, country text, amount double precision)');
      await my.query('drop table if exists idn_a');
      await my.query('drop table if exists idn_b');
      await my.query('create table idn_a(id int, country text, amount double)');
      await my.query('create table idn_b(id int, country text, amount double)');

      for (const row of BASE) {
        await pg.query('insert into idn_a values ($1,$2,$3)', [row.id, row.country, row.amount]);
        await pg.query('insert into idn_b values ($1,$2,$3)', [row.id, row.country, row.amount]);
        await my.query('insert into idn_a values (?,?,?)', [row.id, row.country, row.amount]);
        await my.query('insert into idn_b values (?,?,?)', [row.id, row.country, row.amount]);
      }

      const report = await diffTables(pg, 'public.idn_a', my, 'idn_a', {
        keyColumns: ['id'],
      });

      expect(report.identical).toBe(true);
      expect(report.summary).toMatchObject({ added: 0, removed: 0, modified: 0 });
      // The checksums of identical data in two different engines must match.
      expect(report.left.checksum).toBe(report.right.checksum);
    } finally {
      await pg?.close();
      await my?.close();
    }
  });
});
