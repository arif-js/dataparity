import * as duckdbModule from '@duckdb/node-api';
import { classifyType, type Dialect } from '../core/canonical.js';
import { type ColumnInfo, type Source, SourceError, type TableInfo } from './source.js';

/** Options for the local DuckDB source. */
export interface DuckdbOptions {
  id?: string;
  /** Path to a DuckDB database file. Defaults to an in-memory database. */
  path?: string;
  label?: string;
  /**
   * Files to expose as tables, e.g. `['data/orders.parquet', 'data/users.csv']`.
   * The table name is the file's base name without extension.
   */
  files?: string[];
}

/**
 * Local DuckDB source.
 *
 * DuckDB is the compute engine: it can read Parquet and CSV directly, and it
 * is the reference implementation of the canonical hashing rules. It is also
 * what makes the tool usable with no database at all — point it at two Parquet
 * files and it diffs them.
 */
export class DuckdbSource implements Source {
  readonly id: string;
  readonly dialect: Dialect = 'duckdb';
  readonly label: string;
  readonly isLocal = true;
  readonly databaseKey: string;

  // biome-ignore lint/suspicious/noExplicitAny: duckdb instance type
  private conn: any;
  private closed = false;

  private constructor(conn: unknown, id: string, label: string, databaseKey: string) {
    this.conn = conn;
    this.id = id;
    this.label = label;
    this.databaseKey = databaseKey;
  }

  /** Opens a DuckDB database (in memory by default). */
  static async open(options: DuckdbOptions = {}): Promise<DuckdbSource> {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const path = options.path ?? ':memory:';
    // biome-ignore lint/suspicious/noExplicitAny: duckdb instance type
    let instance: any;
    // biome-ignore lint/suspicious/noExplicitAny: duckdb connection type
    let conn: any;
    try {
      instance = await DuckDBInstance.create(path);
      conn = await instance.connect();
    } catch (err) {
      throw new SourceError(
        `Failed to open DuckDB database: ${(err as Error).message}`,
        'CONNECTION_FAILED',
        err,
      );
    }
    const id =
      options.id ??
      `duckdb:${(options.path ?? 'memory').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
    const source = new DuckdbSource(
      conn,
      id,
      options.label ?? id,
      `duckdb-db:${options.path ?? 'memory'}`,
    );

    for (const file of options.files ?? []) {
      await source.registerFile(file);
    }
    return source;
  }

  /** Exposes a Parquet, CSV or JSON file as a table named after the file. */
  async registerFile(file: string): Promise<string> {
    const lower = file.toLowerCase();
    const base = file.split('/').pop() ?? file;
    const name = base
      .replace(/\.(parquet|csv|json|jsonl|tsv)$/i, '')
      .replace(/[^a-zA-Z0-9_]/g, '_');
    if (lower.endsWith('.parquet')) {
      await this.conn.run(
        `create or replace view "${name}" as select * from read_parquet('${file.replace(/'/g, "''")}')`,
      );
    } else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
      await this.conn.run(
        `create or replace view "${name}" as select * from read_csv_auto('${file.replace(/'/g, "''")}')`,
      );
    } else if (lower.endsWith('.json') || lower.endsWith('.jsonl')) {
      await this.conn.run(
        `create or replace view "${name}" as select * from read_json_auto('${file.replace(/'/g, "''")}')`,
      );
    } else {
      throw new SourceError(`Unsupported file type: ${file}`, 'UNSUPPORTED');
    }
    return name;
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (this.closed) throw new SourceError('Source is closed', 'CLOSED');
    try {
      if (params.length === 0) {
        const result = await this.conn.runAndReadAll(sql);
        return result.getRowObjects() as Record<string, unknown>[];
      }
      // DuckDB's node API needs a prepared statement plus an explicit type per
      // parameter, so the value and its type are chosen together here.
      const duckdb = await import('@duckdb/node-api');
      const statement = await this.conn.prepare(sql);
      const types = params.map((p) => duckdbTypeFor(p));
      const values = params.map((p, i) => duckdb.jsToDuckDBValue(p as never, types[i] as never));
      statement.bind(values);
      const result = await statement.runAndReadAll();
      return result.getRowObjects() as Record<string, unknown>[];
    } catch (err) {
      throw new SourceError(`Query failed: ${(err as Error).message}`, 'QUERY_FAILED', err);
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.query(
      `select table_name, column_name, data_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_schema = 'main'
        order by table_name, ordinal_position`,
    );
    const byTable = new Map<string, TableInfo>();
    for (const row of rows) {
      const name = String(readField(row, 'table_name'));
      const column: ColumnInfo = {
        name: String(readField(row, 'column_name')),
        dataType: String(readField(row, 'data_type') ?? ''),
        kind: classifyType(String(readField(row, 'data_type') ?? '')),
        nullable: String(readField(row, 'is_nullable') ?? 'YES').toUpperCase() === 'YES',
        ordinal: Number(readField(row, 'ordinal_position') ?? 0),
      };
      const existing = byTable.get(name);
      if (existing) {
        existing.columns.push(column);
      } else {
        byTable.set(name, {
          name,
          schema: 'main',
          qualifiedName: `main.${name}`,
          columns: [column],
        });
      }
    }
    for (const table of byTable.values()) {
      table.columns.sort((a, b) => a.ordinal - b.ordinal);
    }
    return [...byTable.values()];
  }

  async describeTable(qualifiedName: string): Promise<TableInfo> {
    const name = qualifiedName.includes('.')
      ? (qualifiedName.split('.').pop() ?? qualifiedName)
      : qualifiedName;
    const rows = await this.query(
      `select table_name, column_name, data_type, is_nullable, ordinal_position
         from information_schema.columns
        where table_schema = 'main' and table_name = '${name.replace(/'/g, "''")}'
        order by ordinal_position`,
    );
    if (rows.length === 0) {
      throw new SourceError(`Table not found: ${qualifiedName}`, 'NOT_FOUND');
    }
    const table: TableInfo = {
      name,
      schema: 'main',
      qualifiedName: `main.${name}`,
      columns: rows.map((row) => ({
        name: String(readField(row, 'column_name')),
        dataType: String(readField(row, 'data_type') ?? ''),
        kind: classifyType(String(readField(row, 'data_type') ?? '')),
        nullable: String(readField(row, 'is_nullable') ?? 'YES').toUpperCase() === 'YES',
        ordinal: Number(readField(row, 'ordinal_position') ?? 0),
      })),
    };
    return table;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.conn?.close?.();
  }
}

/**
 * Reads a field from a result row, ignoring case.
 *
 * Engine result labels differ in case, so the lookup is case-insensitive.
 */
function readField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field];
  const lower = field.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Chooses the DuckDB type for a JavaScript parameter value.
 *
 * DuckDB's node API requires an explicit type when binding a parameter, so the
 * type is inferred from the value the same way every time.
 */
function duckdbTypeFor(value: unknown): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: duckdb type objects
  const duckdb = duckdbModule as any;
  if (value === null || value === undefined) return duckdb.VARCHAR;
  if (typeof value === 'boolean') return duckdb.BOOLEAN;
  if (typeof value === 'bigint') return duckdb.BIGINT;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? duckdb.BIGINT : duckdb.DOUBLE;
  }
  if (value instanceof Date) return duckdb.TIMESTAMP;
  if (Buffer.isBuffer(value)) return duckdb.BLOB;
  return duckdb.VARCHAR;
}
