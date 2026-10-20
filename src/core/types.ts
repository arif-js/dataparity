/**
 * The public result contract.
 *
 * This shape is a versioned interface: CLI, MCP and any future HTTP surface
 * all return exactly this. Additive changes are fine; breaking changes
 * require a major version bump.
 */

/** How a row differs between the two sides. */
export type RowChangeKind = 'added' | 'removed' | 'modified';

/** A single column-level change within a modified row. */
export interface ColumnChange {
  column: string;
  /** Canonical value on the left (base) side. */
  before: string | null;
  /** Canonical value on the right (target) side. */
  after: string | null;
}

/** One row-level difference. */
export interface RowChange {
  kind: RowChangeKind;
  /** The key that identifies the row, rendered canonically. */
  key: string;
  /** Column-level differences, present for `modified` rows only. */
  columns?: ColumnChange[];
}

/** A difference between the two schemas. */
export interface SchemaDifference {
  column: string;
  kind: 'added' | 'removed' | 'type_changed' | 'nullability_changed';
  leftType?: string;
  rightType?: string;
  leftNullable?: boolean;
  rightNullable?: boolean;
}

/** How the diff was computed. */
export type DiffStrategy = 'join' | 'checksum' | 'bisect';

/** The verdict a diff produces. */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** A segment of data that concentrates an unusual share of the changes. */
export interface Attribution {
  /** The column and value that the changes cluster on. */
  column: string;
  value: string;
  /** Number of changed rows with this value. */
  count: number;
  /** Share of changed rows with this value, 0..1. */
  share: number;
  /**
   * How much this value is over-represented among changed rows relative to its
   * share of the base table. 1 means "exactly as common as usual".
   */
  overRepresentation: number;
}

/** The complete result of a diff. */
export interface DiffReport {
  /** The two sides that were compared. */
  left: SideInfo;
  right: SideInfo;
  /** Which algorithm produced the result. */
  strategy: DiffStrategy;
  /** Whether the two sides are identical. */
  identical: boolean;
  /** Row counts on each side. */
  rowCounts: { left: number; right: number };
  /** Counts per change kind. */
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  /** Schema differences between the two sides. */
  schemaDifferences: SchemaDifference[];
  /** Sample of row-level differences, capped by the caller's limit. */
  changes: RowChange[];
  /** Whether `changes` was truncated. */
  changesTruncated: boolean;
  /** Segments where the changes concentrate. */
  attributions: Attribution[];
  /** The overall risk assessment. */
  risk: {
    level: RiskLevel;
    /** A human-readable explanation of the verdict. */
    reason: string;
    /** The signals that drove the verdict. */
    signals: string[];
  };
  /** Columns used to match rows across the two sides. */
  keyColumns: string[];
  /** Wall-clock duration of the diff in milliseconds. */
  durationMs: number;
  /** Whether the comparison was limited to a sample of rows. */
  sampled: boolean;
  /** Notes about anything the user should know about the result. */
  warnings: string[];
}

/** Identifies one side of a diff. */
export interface SideInfo {
  /** The source id. */
  source: string;
  /** The table or file compared. */
  table: string;
  /** Number of rows examined. */
  rowCount: number;
  /** A checksum over the whole side, when one was computed. */
  checksum: string | null;
}
