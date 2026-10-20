/**
 * dataparity — cross-database data diff and reconciliation.
 *
 * The public API. Everything here is stable; the internals under `core/` are
 * not, except for the result contract in `core/types.ts`.
 */

export {
  type Config,
  configSchema,
  defaultConfigPath,
  findSource,
  loadConfig,
} from './config/config.js';
export {
  type ColumnKind,
  canonicalExpr,
  charLength,
  checksumExpr,
  checksumFromHashes,
  classifyType,
  concatExpr,
  concatSepExpr,
  type Dialect,
  FIELD_SEPARATOR,
  hashRow,
  NULL_TAG,
  rowHashExpr,
  VALUE_TAG,
} from './core/canonical.js';
export {
  compareSchemas,
  DEFAULT_MAX_ATTRIBUTIONS,
  DEFAULT_MAX_CHANGES,
  type DiffOptions,
  diffTables,
} from './core/diff.js';
export { openNamedSource, openSource } from './core/sources.js';
export type {
  Attribution,
  ColumnChange,
  DiffReport,
  DiffStrategy,
  RiskLevel,
  RowChange,
  SchemaDifference,
  SideInfo,
} from './core/types.js';
export { type DuckdbOptions, DuckdbSource } from './engines/duckdb.js';
export {
  type ColumnInfo,
  quoteIdent,
  quoteQualified,
  type Source,
  SourceError,
  type SourceErrorCode,
  type TableInfo,
} from './engines/source.js';
export {
  type MysqlOptions,
  MysqlSource,
  type PostgresOptions,
  PostgresSource,
  type SqliteOptions,
  SqliteSource,
} from './engines/sql.js';
export { formatJson, formatReport } from './interfaces/format.js';
