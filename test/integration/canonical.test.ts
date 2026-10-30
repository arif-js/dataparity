import { describe, expect, it } from 'vitest';
import { canonicalExpr, checksumExpr, rowHashExpr } from '../../src/core/canonical.js';
import { DuckdbSource } from '../../src/engines/duckdb.js';
import { MysqlSource, PostgresSource } from '../../src/engines/sql.js';
import { skipTest, tryConnect } from './helpers.js';

/**
 * Cross-engine canonicalization.
 *
 * This is the test that proves the central claim of the project: that a value
 * written in Postgres and a value written in MySQL that mean the same thing
 * produce the same canonical text and the same row hash.
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

/** The values that break naive canonicalization implementations. */
const NASTY_VALUES: [number, number | null, string | null, boolean | null, string | null][] = [
  [1, 1.1, 'abc', true, '2024-01-01 12:00:00'],
  [2, 0.1 + 0.2, 'x', false, '2024-06-01 00:00:00'],
  [3, null, null, null, null],
  [4, 1e15, 'big', null, null],
  [5, 0.30000000000000004, 'prec', null, null],
  [6, 1e-9, 'tiny', null, null],
  [7, -5.25, 'neg', null, null],
  [8, 1234.5678, '', null, null],
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: the point is a float with many digits
  [9, 3.14159265358979, 'pi', null, null],
  [10, 0.1, 'separator\u001Finside', null, null],
  [11, 1.0, 'ünïcødé', null, null],
];

/** The columns used by the canonicalization fixtures. */
const COLUMNS = ['id', 'amt', 'txt', 'b', 'ts'];
const KINDS = ['integer', 'float', 'text', 'boolean', 'timestamp'] as const;

/** A decimal column, which renders differently from a float in every engine. */
const DECIMAL_KINDS = ['integer', 'decimal', 'text', 'boolean', 'timestamp'] as const;

describe('cross-engine canonicalization', () => {
  it('renders the same values identically in Postgres, MySQL and DuckDB', async (ctx) => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    const duck = await tryConnect(() => DuckdbSource.open());

    if (!pg || !my || !duck) {
      skipTest(ctx, 'Skipping cross-engine test: databases are not reachable.');
    }

    try {
      await pg.query('drop table if exists canon');
      await pg.query(
        'create table canon(id int, amt double precision, txt text, b boolean, ts timestamp)',
      );
      await my.query('drop table if exists canon');
      await my.query('create table canon(id int, amt double, txt text, b boolean, ts datetime)');
      await duck.query('drop table if exists canon');
      await duck.query(
        'create table canon(id int, amt double, txt varchar, b boolean, ts timestamp)',
      );

      for (const row of NASTY_VALUES) {
        await pg.query('insert into canon values ($1,$2,$3,$4,$5)', row);
        await my.query('insert into canon values (?,?,?,?,?)', row);
        await duck.query('insert into canon values (?,?,?,?,?)', row);
      }

      const rendered: Record<string, string[]> = {};

      for (const dialect of ['postgres', 'mysql', 'duckdb'] as const) {
        const source = dialect === 'postgres' ? pg : dialect === 'mysql' ? my : duck;
        // Each engine quotes identifiers differently: MySQL uses backticks and
        // treats a double-quoted name as a string literal.
        const ident = (name: string) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
        const exprs = COLUMNS.map((c, i) => canonicalExpr(ident(c), KINDS[i] as never, dialect));
        const rows = await source.query(
          `select ${exprs.map((e, i) => `${e} as c${i}`).join(', ')} from canon order by id`,
        );
        rendered[dialect] = rows.map((r) => JSON.stringify(Object.values(r)));
      }

      expect(rendered.mysql).toEqual(rendered.postgres);
      expect(rendered.duckdb).toEqual(rendered.postgres);
    } finally {
      await pg?.close();
      await my?.close();
      await duck?.close();
    }
  });

  it('renders a decimal column identically in every engine', async (ctx) => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));
    const duck = await tryConnect(() => DuckdbSource.open());

    if (!pg || !my || !duck) {
      skipTest(ctx, 'Skipping decimal test: databases are not reachable.');
    }

    try {
      // Postgres renders a decimal as `10.500000`, MySQL as `10.50`. The
      // canonical form must not depend on that.
      await pg.query('drop table if exists dectest');
      await pg.query('create table dectest(id int, amt numeric(18,4))');
      await my.query('drop table if exists dectest');
      await my.query('create table dectest(id int, amt decimal(18,4))');
      await duck.query('drop table if exists dectest');
      await duck.query('create table dectest(id int, amt decimal(18,4))');

      const values: [number, number][] = [
        [1, 10.5],
        [2, 20.25],
        [3, 0.1 + 0.2],
        [4, -5.25],
        [5, 999999.999999],
      ];
      for (const [id, amt] of values) {
        await pg.query('insert into dectest values ($1,$2)', [id, amt]);
        await my.query('insert into dectest values (?,?)', [id, amt]);
        await duck.query('insert into dectest values (?,?)', [id, amt]);
      }

      const rendered: Record<string, string[]> = {};
      for (const dialect of ['postgres', 'mysql', 'duckdb'] as const) {
        const source = dialect === 'postgres' ? pg : dialect === 'mysql' ? my : duck;
        const ident = (name: string) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
        const exprs = ['id', 'amt'].map((c, i) =>
          canonicalExpr(ident(c), DECIMAL_KINDS[i] as never, dialect),
        );
        const rows = await source.query(
          `select ${exprs.map((e, i) => `${e} as c${i}`).join(', ')} from dectest order by id`,
        );
        rendered[dialect] = rows.map((r) => JSON.stringify(Object.values(r)));
      }

      expect(rendered.mysql).toEqual(rendered.postgres);
      expect(rendered.duckdb).toEqual(rendered.postgres);
    } finally {
      await pg?.close();
      await my?.close();
      await duck?.close();
    }
  });

  it('produces the same row hash and checksum in Postgres and MySQL', async (ctx) => {
    const pg = await tryConnect(() => PostgresSource.connect({ connectionString: PG_CONNECTION }));
    const my = await tryConnect(() => MysqlSource.connect(MYSQL_OPTIONS));

    if (!pg || !my) {
      skipTest(ctx, 'Skipping checksum test: databases are not reachable.');
    }

    try {
      await pg.query('drop table if exists hashcheck');
      await pg.query('create table hashcheck(id int, amt double precision, txt text)');
      await my.query('drop table if exists hashcheck');
      await my.query('create table hashcheck(id int, amt double, txt text)');

      for (const [id, amt, txt] of NASTY_VALUES) {
        await pg.query('insert into hashcheck values ($1,$2,$3)', [id, amt, txt]);
        await my.query('insert into hashcheck values (?,?,?)', [id, amt, txt]);
      }

      const kinds = ['integer', 'float', 'text'] as const;
      const columns = ['id', 'amt', 'txt'];

      const pgExprs = columns.map((c, i) => canonicalExpr(`"${c}"`, kinds[i] as never, 'postgres'));
      const myExprs = columns.map((c, i) => canonicalExpr(`\`${c}\``, kinds[i] as never, 'mysql'));
      const pgHashExpr = rowHashExpr(pgExprs, 'postgres');
      const myHashExpr = rowHashExpr(myExprs, 'mysql');

      const pgRows = await pg.query(`select ${pgHashExpr} as h from hashcheck order by id`);
      const myRows = await my.query(`select ${myHashExpr} as h from hashcheck order by id`);

      const pgHashes = pgRows.map((r) => String(r.h));
      const myHashes = myRows.map((r) => String(r.h));
      expect(myHashes).toEqual(pgHashes);

      const pgChecksum = await pg.query(
        `select ${checksumExpr(pgHashExpr, 'postgres')} as c from hashcheck`,
      );
      const myChecksum = await my.query(
        `select ${checksumExpr(myHashExpr, 'mysql')} as c from hashcheck`,
      );
      expect(String(myChecksum[0]?.c)).toBe(String(pgChecksum[0]?.c));
    } finally {
      await pg?.close();
      await my?.close();
    }
  });
});
