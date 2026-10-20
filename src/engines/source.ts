import type { ColumnKind, Dialect } from '../core/canonical.js';

/** A column of a source table. */
export interface ColumnInfo {
  /** Column name as the engine reports it. */
  name: string;
  /** The engine's raw type name. */
  dataType: string;
  /** The canonicalization family this column falls into. */
  kind: ColumnKind;
  /** Whether the column accepts NULLs. */
  nullable: boolean;
  /** Ordinal position in the table. */
  ordinal: number;
}

/** A table (or view) that can be diffed. */
export interface TableInfo {
  /** Fully qualified name as it should be written in a query. */
  qualifiedName: string;
  /** Unqualified table name. */
  name: string;
  /** Schema, when the engine has schemas. */
  schema: string | null;
  columns: ColumnInfo[];
}

/**
 * A connection to one data source.
 *
 * Implementations must be read-only: dataparity never writes to a user's
 * database. The interface is deliberately small so that new engines are cheap
 * to add.
 */
export interface Source {
  /** Stable identifier for this source, used in reports and config keys. */
  readonly id: string;
  /** The dialect this source speaks. */
  readonly dialect: Dialect;
  /** A human-readable label. */
  readonly label: string;
  /** Whether the source is a local DuckDB instance. */
  readonly isLocal: boolean;
  /**
   * Identifies the physical database this source points at.
   *
   * Two sources with the same `databaseKey` are the same database, and a diff
   * between them can run as a single in-database join. This is what makes the
   * exact strategy available for the common case of diffing two tables that
   * live in the same Postgres, while a comparison across two different
   * databases falls back to the hash-based strategy.
   */
  readonly databaseKey: string;

  /**
   * Runs a query and returns rows as plain objects.
   *
   * Parameters are passed separately and are never interpolated into the SQL
   * string, so values cannot change the shape of a statement.
   */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;

  /** Lists the tables visible to this connection. */
  listTables(schema?: string): Promise<TableInfo[]>;

  /** Describes a single table's columns. */
  describeTable(qualifiedName: string): Promise<TableInfo>;

  /** Closes the connection and releases resources. */
  close(): Promise<void>;
}

/** Thrown when a source cannot be reached or a query fails. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly code: SourceErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export type SourceErrorCode =
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'QUERY_FAILED'
  | 'UNSUPPORTED'
  | 'CLOSED';

/** Quotes an identifier for the given dialect. */
export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === 'mysql') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a fully qualified `schema.table` reference. */
export function quoteQualified(qualifiedName: string, dialect: Dialect): string {
  const parts = qualifiedName.split('.');
  return parts.map((p) => quoteIdent(p, dialect)).join('.');
}
