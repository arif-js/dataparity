import { createHash } from 'node:crypto';
import { classifyType, type Dialect, escapeSqlLiteral } from '../core/canonical.js';
import { type ColumnInfo, type Source, SourceError, type TableInfo } from './source.js';

/** A Postgres connection, identified by a connection string. */
export interface PostgresOptions {
  id?: string;
  /** libpq-style connection string, e.g. `postgres://user:pass@host:5432/db`. */
  connectionString: string;
  label?: string;
  /** Statement timeout in milliseconds. Applied to every query. */
  statementTimeoutMs?: number;
}

/**
 * PostgreSQL source.
 *
 * Uses the `pg` driver directly rather than DuckDB's postgres scanner, so
 * that queries run inside Postgres and results stream back without DuckDB
 * pulling the whole table across the wire. This is what makes cross-database
 * diffing scale: only checksums and matched keys are transferred.
 */
export class PostgresSource implements Source {
  readonly id: string;
  readonly dialect: Dialect = 'postgres';
  readonly label: string;
  readonly isLocal = false;
  readonly databaseKey: string;

  // biome-ignore lint/suspicious/noExplicitAny: pg's Client type
  private client: any;
  private closed = false;

  private constructor(
    client: unknown,
    id: string,
    label: string,
    databaseKey: string,
    private readonly statementTimeoutMs: number | undefined,
  ) {
    this.client = client;
    this.id = id;
    this.label = label;
    this.databaseKey = databaseKey;
  }

  /** Connects to Postgres. */
  static async connect(options: PostgresOptions): Promise<PostgresSource> {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: options.connectionString });
    try {
      await client.connect();
    } catch (err) {
      throw new SourceError(
        `Failed to connect to Postgres: ${(err as Error).message}`,
        isAuthError(err) ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
        err,
      );
    }
    const id = options.id ?? deriveId('postgres', redactConnectionString(options.connectionString));
    const databaseKey = deriveId('postgres-db', redactConnectionString(options.connectionString));
    return new PostgresSource(
      client,
      id,
      options.label ?? id,
      databaseKey,
      options.statementTimeoutMs,
    );
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (this.closed) throw new SourceError('Source is closed', 'CLOSED');
    try {
      if (this.statementTimeoutMs !== undefined) {
        await this.client.query(`set statement_timeout = ${Math.trunc(this.statementTimeoutMs)}`);
      }
      const result = await this.client.query(sql, params.length > 0 ? params : undefined);
      return result.rows;
    } catch (err) {
      throw new SourceError(`Query failed: ${(err as Error).message}`, 'QUERY_FAILED', err);
    }
  }

  async listTables(schema = 'public'): Promise<TableInfo[]> {
    const rows = await this.query(
      `select table_name, column_name, data_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_schema = '${escapeSqlLiteral(schema)}'
          and table_name in (
            select table_name from information_schema.tables
             where table_schema = '${escapeSqlLiteral(schema)}' and table_type = 'BASE TABLE'
          )
        order by table_name, ordinal_position`,
    );
    return groupTables(rows, 'postgres', schema);
  }

  async describeTable(qualifiedName: string): Promise<TableInfo> {
    const [schema, table] = splitQualified(qualifiedName, 'public');
    const rows = await this.query(
      `select table_name, column_name, data_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_schema = '${escapeSqlLiteral(schema)}' and table_name = '${escapeSqlLiteral(table)}'
        order by ordinal_position`,
    );
    if (rows.length === 0) {
      throw new SourceError(`Table not found: ${qualifiedName}`, 'NOT_FOUND');
    }
    return groupTables(rows, 'postgres', schema)[0] as TableInfo;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.end();
  }
}

/** A MySQL connection. */
export interface MysqlOptions {
  id?: string;
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  label?: string;
  connectionLimit?: number;
}

/** MySQL source, using `mysql2`. */
export class MysqlSource implements Source {
  readonly id: string;
  readonly dialect: Dialect = 'mysql';
  readonly label: string;
  readonly isLocal = false;
  readonly databaseKey: string;

  // biome-ignore lint/suspicious/noExplicitAny: mysql2's pool type
  private pool: any;
  private closed = false;

  private constructor(pool: unknown, id: string, label: string, databaseKey: string) {
    this.pool = pool;
    this.id = id;
    this.label = label;
    this.databaseKey = databaseKey;
  }

  /** Connects to MySQL. */
  static async connect(options: MysqlOptions): Promise<MysqlSource> {
    const mysql = await import('mysql2/promise');
    const pool = mysql.createPool({
      host: options.host,
      port: options.port ?? 3306,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit: options.connectionLimit ?? 4,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
    });
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw new SourceError(
        `Failed to connect to MySQL: ${(err as Error).message}`,
        isAuthError(err) ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
        err,
      );
    }
    const id =
      options.id ??
      deriveId('mysql', `${options.host}:${options.port ?? 3306}/${options.database}`);
    const databaseKey = deriveId(
      'mysql-db',
      `${options.host}:${options.port ?? 3306}/${options.database}`,
    );
    return new MysqlSource(pool, id, options.label ?? id, databaseKey);
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (this.closed) throw new SourceError('Source is closed', 'CLOSED');
    try {
      const [rows] = await this.pool.query(sql, params);
      return rows as Record<string, unknown>[];
    } catch (err) {
      throw new SourceError(`Query failed: ${(err as Error).message}`, 'QUERY_FAILED', err);
    }
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const targetSchema = schema ? `'${escapeSqlLiteral(schema)}'` : 'database()';
    const rows = await this.query(
      `select table_name, column_name, column_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_schema = ${targetSchema}
          and table_name in (
            select table_name from information_schema.tables
             where table_schema = ${targetSchema} and table_type = 'BASE TABLE'
          )
        order by table_name, ordinal_position`,
    );
    return groupTables(rows, 'mysql', schema || null);
  }

  async describeTable(qualifiedName: string): Promise<TableInfo> {
    const [schema, table] = splitQualified(qualifiedName, '');
    const targetSchema = schema ? `'${escapeSqlLiteral(schema)}'` : 'database()';
    const rows = await this.query(
      `select table_name, column_name, column_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_name = '${escapeSqlLiteral(table)}'
          and table_schema = ${targetSchema}
        order by ordinal_position`,
    );
    if (rows.length === 0) {
      throw new SourceError(`Table not found: ${qualifiedName}`, 'NOT_FOUND');
    }
    return groupTables(rows, 'mysql', schema || null)[0] as TableInfo;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

/** A SQLite database, read from a file path. */
export interface SqliteOptions {
  id?: string;
  /** Path to the SQLite database file. */
  path: string;
  label?: string;
  /** Open the database read-only. Defaults to true. */
  readOnly?: boolean;
}

/** Counter so distinct `:memory:` SQLite instances get distinct `databaseKey`s. */
let sqliteMemorySeq = 0;

/** SQLite source, using node's built-in `node:sqlite`. */
export class SqliteSource implements Source {
  readonly id: string;
  readonly dialect: Dialect = 'sqlite';
  readonly label: string;
  readonly isLocal = true;
  readonly databaseKey: string;

  // biome-ignore lint/suspicious/noExplicitAny: node:sqlite DatabaseSync
  private db: any;
  private closed = false;

  private constructor(db: unknown, id: string, label: string, databaseKey: string) {
    this.db = db;
    this.id = id;
    this.label = label;
    this.databaseKey = databaseKey;
  }

  /** Opens a SQLite database. */
  static async open(options: SqliteOptions): Promise<SqliteSource> {
    const { DatabaseSync } = await import('node:sqlite');
    const readOnly = options.readOnly ?? true;
    // biome-ignore lint/suspicious/noExplicitAny: node:sqlite DatabaseSync
    let db: any;
    try {
      db = new DatabaseSync(options.path, { readOnly });
    } catch (err) {
      throw new SourceError(
        `Failed to open SQLite database: ${(err as Error).message}`,
        'CONNECTION_FAILED',
        err,
      );
    }

    // SQLite has no built-in MD5, and the cross-database comparison depends on
    // the row hash being byte-identical to the one the other engines compute.
    // Registering the same MD5 keeps SQLite on the same hash as everyone else.
    try {
      db.function('md5', { deterministic: true }, (value: unknown) => {
        if (value === null || value === undefined) return null;
        return createHash('md5').update(String(value), 'utf8').digest('hex');
      });
      // SQLite has no way to read a hex string as an integer, and its `0x`
      // literal prefix silently yields 0, so the conversion is registered too.
      //
      // The value is reduced modulo 2^61-1 as it is converted, and returned as
      // a number. A full 60-bit value does not fit in a JavaScript number, so
      // node:sqlite refuses to carry one, and reducing it here keeps every
      // intermediate sum inside the safe integer range. The reduction is
      // applied to each value and to the final sum, which is the same as
      // reducing the total once.
      const MODULUS = 2305843009213693951n;
      db.function('hex2int', { deterministic: true }, (value: unknown) => {
        if (value === null || value === undefined) return null;
        const hex = String(value);
        if (hex.length === 0) return 0;
        return Number(BigInt(`0x${hex}`) % MODULUS);
      });
    } catch (err) {
      throw new SourceError(
        `Failed to register the hash functions on SQLite: ${(err as Error).message}`,
        'CONNECTION_FAILED',
        err,
      );
    }

    const id = options.id ?? deriveId('sqlite', options.path);
    const databaseKey =
      options.path === ':memory:'
        ? `sqlite-db:memory:${++sqliteMemorySeq}`
        : `sqlite-db:${options.path}`;
    return new SqliteSource(db, id, options.label ?? id, databaseKey);
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (this.closed) throw new SourceError('Source is closed', 'CLOSED');
    try {
      const statement = this.db.prepare(sql);
      if (params.length > 0) {
        return statement.all(...(params as never[])) as Record<string, unknown>[];
      }
      return statement.all() as Record<string, unknown>[];
    } catch (err) {
      throw new SourceError(`Query failed: ${(err as Error).message}`, 'QUERY_FAILED', err);
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.query(
      `select m.name as table_name, p.name as column_name, p.type as data_type,
              case when p."notnull" = 0 and p.pk = 0 then 'YES' else 'NO' end as is_nullable,
              p.cid + 1 as ordinal_position
         from sqlite_master m
         join pragma_table_info(m.name) p
        where m.type = 'table' and m.name not like 'sqlite_%'
        order by m.name, p.cid`,
    );
    return groupTables(rows, 'sqlite');
  }

  async describeTable(qualifiedName: string): Promise<TableInfo> {
    const [, table] = splitQualified(qualifiedName, '');
    const rows = await this.query(
      `select m.name as table_name, p.name as column_name, p.type as data_type,
              case when p."notnull" = 0 and p.pk = 0 then 'YES' else 'NO' end as is_nullable,
              p.cid + 1 as ordinal_position
         from sqlite_master m
         join pragma_table_info(m.name) p
        where m.type = 'table' and m.name = '${escapeSqlLiteral(table)}'
        order by p.cid`,
    );
    if (rows.length === 0) {
      throw new SourceError(`Table not found: ${qualifiedName}`, 'NOT_FOUND');
    }
    return groupTables(rows, 'sqlite')[0] as TableInfo;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Builds a `TableInfo` list from flat `information_schema`-style rows. */
export function groupTables(
  rows: Record<string, unknown>[],
  _dialect: Dialect,
  defaultSchema: string | null = null,
): TableInfo[] {
  const byTable = new Map<string, TableInfo>();
  for (const row of rows) {
    const name = String(readField(row, 'table_name'));
    const existing = byTable.get(name);
    // MySQL's `data_type` loses the detail that `column_type` keeps (a
    // boolean is `tinyint` in `data_type` but `tinyint(1)` in `column_type`),
    // so the richer column is preferred when both are present.
    const rawType = readField(row, 'column_type') ?? readField(row, 'data_type') ?? '';
    const column: ColumnInfo = {
      name: String(readField(row, 'column_name')),
      dataType: String(rawType),
      kind: classifyType(String(rawType)),
      nullable: String(readField(row, 'is_nullable') ?? 'YES').toUpperCase() === 'YES',
      ordinal: Number(readField(row, 'ordinal_position') ?? 0),
    };
    if (existing) {
      existing.columns.push(column);
    } else {
      byTable.set(name, {
        name,
        schema: defaultSchema,
        qualifiedName: defaultSchema ? `${defaultSchema}.${name}` : name,
        columns: [column],
      });
    }
  }
  for (const table of byTable.values()) {
    table.columns.sort((a, b) => a.ordinal - b.ordinal);
  }
  return [...byTable.values()];
}

/**
 * Reads a field from a result row, ignoring case.
 *
 * MySQL returns `information_schema` column labels in upper case, while
 * Postgres and DuckDB return them in lower case, so the lookup has to be
 * case-insensitive for the same code to work on all three.
 */
function readField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field];
  const lower = field.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Splits `schema.table` into its parts, applying a default schema. */
export function splitQualified(qualifiedName: string, defaultSchema: string): [string, string] {
  const idx = qualifiedName.lastIndexOf('.');
  if (idx === -1) return [defaultSchema, qualifiedName];
  return [qualifiedName.slice(0, idx), qualifiedName.slice(idx + 1)];
}

/** Derives a stable source id from a connection target. */
export function deriveId(kind: string, target: string): string {
  const sanitized = target.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}:${sanitized.toLowerCase() || 'default'}`;
}

/**
 * Strips credentials from a connection string so it can be used to derive an id
 * or appear in a report without leaking a password.
 */
export function redactConnectionString(connectionString: string): string {
  return connectionString.replace(/(:\/\/[^:@/]*):[^@/]*@/, '$1:***@');
}

/** Detects an authentication failure from a driver error. */
function isAuthError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === '28P01' || code === '28000' || code === 'ER_ACCESS_DENIED_ERROR';
}
