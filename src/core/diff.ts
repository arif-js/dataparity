import {
  type ColumnInfo,
  quoteIdent,
  quoteQualified,
  type Source,
  SourceError,
} from '../engines/source.js';
import {
  type ColumnKind,
  canonicalExpr,
  hexToIntExpr as canonicalHexToIntExpr,
  checksumExpr,
  concatSepExpr,
  type Dialect,
  HASH_DIGITS,
  NULL_TAG,
  rowHashExpr,
  VALUE_TAG,
} from './canonical.js';
import type {
  Attribution,
  ColumnChange,
  DiffReport,
  DiffStrategy,
  RiskLevel,
  RowChange,
  SchemaDifference,
  SideInfo,
} from './types.js';

/** Options controlling a diff. */
export interface DiffOptions {
  /** Columns used to match rows across the two sides. */
  keyColumns: string[];
  /** Columns to compare. Defaults to the union of both schemas, minus keys. */
  columns?: string[];
  /** A `WHERE` expression applied to both sides. */
  where?: string;
  /** Maximum number of row-level changes to include in the report. */
  maxChanges?: number;
  /** Maximum number of attributions to compute. */
  maxAttributions?: number;
  /** How many distinct values to consider per candidate attribution column. */
  attributionValues?: number;
  /** Minimum share of changed rows a value must hold to be reported. */
  minAttributionShare?: number;
  /**
   * When true, stop after comparing a sample of rows. The report is marked as
   * sampled so callers never mistake it for a full comparison.
   */
  sampleOnly?: boolean;
  /** Maximum number of rows to examine per side when sampling. */
  sampleLimit?: number;
}

/** Default number of row changes included in a report. */
export const DEFAULT_MAX_CHANGES = 100;

/** Default number of attributions computed. */
export const DEFAULT_MAX_ATTRIBUTIONS = 5;

/** Number of buckets used when comparing two different databases. */
export const BUCKET_COUNT = 64;

/**
 * Compares two tables and produces a `DiffReport`.
 *
 * Two strategies are used, chosen by where the data lives:
 *
 *  - `join`: both tables are in the *same* database. A single anti-join
 *    classifies every row as added, removed or modified, entirely inside the
 *    database. The row data never leaves it, and the result is exact.
 *
 *  - `checksum`: the tables are in *different* databases. Both sides compute
 *    the same canonical row hash inside their own engine, and the hashes are
 *    compared. Only hashes cross the wire. The comparison is bucketed, so a
 *    large table that differs in a few rows transfers only the hashes of the
 *    buckets that actually differ.
 */
export async function diffTables(
  left: Source,
  leftTable: string,
  right: Source,
  rightTable: string,
  options: DiffOptions,
): Promise<DiffReport> {
  const started = Date.now();
  const warnings: string[] = [];

  const leftInfo = await left.describeTable(leftTable);
  const rightInfo = await right.describeTable(rightTable);

  const keyColumns = options.keyColumns;
  if (keyColumns.length === 0) {
    throw new SourceError('At least one key column is required', 'QUERY_FAILED');
  }

  const missingLeft = keyColumns.filter((k) => !leftInfo.columns.some((c) => c.name === k));
  const missingRight = keyColumns.filter((k) => !rightInfo.columns.some((c) => c.name === k));
  if (missingLeft.length || missingRight.length) {
    const parts: string[] = [];
    if (missingLeft.length) parts.push(`missing on the left: ${missingLeft.join(', ')}`);
    if (missingRight.length) parts.push(`missing on the right: ${missingRight.join(', ')}`);
    throw new SourceError(`Key column(s) ${parts.join('; ')}`, 'QUERY_FAILED');
  }

  const schemaDifferences = compareSchemas(leftInfo.columns, rightInfo.columns);
  const comparedColumns = pickComparedColumns(
    leftInfo.columns,
    rightInfo.columns,
    keyColumns,
    options.columns,
  );

  const sameDatabase = left.databaseKey === right.databaseKey && left.dialect === right.dialect;

  const result = sameDatabase
    ? await runJoinDiff(left, leftInfo, right, rightInfo, comparedColumns, keyColumns, options)
    : await runCrossDatabaseDiff(
        left,
        leftInfo,
        right,
        rightInfo,
        comparedColumns,
        keyColumns,
        options,
      );

  const attributions = await computeAttributions(
    left,
    leftInfo,
    comparedColumns,
    keyColumns,
    result.allChangedKeys ?? [],
    options,
    warnings,
  );

  const risk = assessRisk(result, schemaDifferences, attributions, warnings);

  const leftSide: SideInfo = {
    source: left.id,
    table: leftTable,
    rowCount: result.leftRowCount,
    checksum: result.leftChecksum,
  };
  const rightSide: SideInfo = {
    source: right.id,
    table: rightTable,
    rowCount: result.rightRowCount,
    checksum: result.rightChecksum,
  };

  return {
    left: leftSide,
    right: rightSide,
    strategy: result.strategy,
    identical: result.changes.length === 0 && schemaDifferences.length === 0 && !result.truncated,
    rowCounts: { left: result.leftRowCount, right: result.rightRowCount },
    summary: result.summary,
    schemaDifferences,
    changes: result.changes,
    changesTruncated: result.truncated,
    attributions,
    risk,
    keyColumns,
    durationMs: Date.now() - started,
    sampled: options.sampleOnly === true,
    warnings,
  };
}

/** The internal result of a diff run, before it is wrapped in a report. */
interface DiffRunResult {
  strategy: DiffStrategy;
  changes: RowChange[];
  truncated: boolean;
  summary: { added: number; removed: number; modified: number; unchanged: number };
  leftRowCount: number;
  rightRowCount: number;
  leftChecksum: string | null;
  rightChecksum: string | null;
  /** Every changed key, used for attribution. Not capped. */
  allChangedKeys: string[];
}

/**
 * Same-database diff: a single anti-join classifies every row.
 *
 * The `WHERE` clause is applied inside subqueries so that a column name
 * present in both tables is never ambiguous.
 */
async function runJoinDiff(
  left: Source,
  leftInfo: { qualifiedName: string; columns: ColumnInfo[] },
  right: Source,
  rightInfo: { qualifiedName: string; columns: ColumnInfo[] },
  comparedColumns: string[],
  keyColumns: string[],
  options: DiffOptions,
): Promise<DiffRunResult> {
  const dialect = left.dialect;
  const lTable = quoteQualified(leftInfo.qualifiedName, dialect);
  const rTable = quoteQualified(rightInfo.qualifiedName, dialect);
  const where = options.where ? ` where ${options.where}` : '';

  const joinOn = keyColumns
    .map((k) => `l.${quoteIdent(k, dialect)} = r.${quoteIdent(k, dialect)}`)
    .join(' and ');

  const keyCanonical = keyColumns.map((k) => {
    const col = leftInfo.columns.find((x) => x.name === k);
    return canonicalExpr(`l.${quoteIdent(k, dialect)}`, col?.kind ?? 'unknown', dialect);
  });
  const keySelect = keyCanonical
    .map((e, i) => `${e} as ${quoteIdent(`k${i}`, dialect)}`)
    .join(', ');

  // A column's canonical form depends on the other side's type for the same
  // column, so that a boolean on one side and a 0/1 integer on the other are
  // treated as the same logical type.
  const peerKindOf = (name: string, from: 'left' | 'right'): ColumnKind | undefined => {
    const peer = (from === 'left' ? rightInfo.columns : leftInfo.columns).find(
      (x) => x.name === name,
    );
    return peer?.kind;
  };

  const canonicalLeft = comparedColumns.map((c) => {
    const col = leftInfo.columns.find((x) => x.name === c);
    return canonicalExpr(
      `l.${quoteIdent(c, dialect)}`,
      resolveKind(col?.kind ?? 'unknown', peerKindOf(c, 'left')),
      dialect,
    );
  });
  const canonicalRight = comparedColumns.map((c) => {
    const col = rightInfo.columns.find((x) => x.name === c);
    return canonicalExpr(
      `r.${quoteIdent(c, dialect)}`,
      resolveKind(col?.kind ?? 'unknown', peerKindOf(c, 'right')),
      dialect,
    );
  });

  const differs = comparedColumns
    .map((c) =>
      isDistinctFrom(`l.${quoteIdent(c, dialect)}`, `r.${quoteIdent(c, dialect)}`, dialect),
    )
    .join(' or ');

  // When the two tables share no comparable columns, there is nothing to
  // compare and therefore no row can be "modified" — only added or removed.
  // The query is skipped rather than built with an empty predicate.
  const canHaveModified = comparedColumns.length > 0;

  // When sampling, both sides are restricted to the *same* set of keys, taken
  // from the left table. Sampling each side independently would report rows
  // as added or removed purely because they were not sampled.
  const sampleLimit = options.sampleOnly ? (options.sampleLimit ?? 100_000) : null;
  const keyIdents = keyColumns.map((k) => quoteIdent(k, dialect));
  const sampledKeys = sampleLimit
    ? `(select ${keyIdents.join(', ')} from ${lTable} sk${where} order by ${keyIdents.join(', ')} limit ${sampleLimit})`
    : null;

  /**
   * Restricts one side of the join to the sampled keys.
   *
   * This is a complete predicate, not a fragment to be appended to a WHERE
   * clause, because the side may or may not already have one.
   */
  const sampleFilter = (alias: string): string => {
    if (!sampledKeys) return '';
    const on = keyColumns
      .map((_k, i) => `s.${keyIdents[i]} = ${alias}.${keyIdents[i]}`)
      .join(' and ');
    return `exists (select 1 from ${sampledKeys} s where ${on})`;
  };

  /**
   * Builds the predicate for one side: the user's WHERE clause and the sample
   * restriction, combined.
   */
  const sidePredicate = (alias: string): string => {
    const parts: string[] = [];
    if (options.where) parts.push(`(${options.where})`);
    const sample = sampleFilter(alias);
    if (sample) parts.push(sample);
    if (parts.length === 0) return '';
    return ` where ${parts.join(' and ')}`;
  };

  // The two sides, as subqueries so the WHERE clause never sees an ambiguous
  // column name and the sample filter can reference the alias. Each subquery
  // already carries its `l` / `r` alias, so it is not repeated.
  const leftSource = `(select l0.* from ${lTable} l0${sidePredicate('l0')}) l`;
  const rightSource = `(select r0.* from ${rTable} r0${sidePredicate('r0')}) r`;

  const countsSql = `
    select (select count(*) from ${leftSource}) as left_count,
           (select count(*) from ${rightSource}) as right_count`;
  const counts = await left.query(countsSql);
  const leftRowCount = Number(counts[0]?.left_count ?? 0);
  const rightRowCount = Number(counts[0]?.right_count ?? 0);

  const removedRows = await left.query(`
    select ${keySelect}
      from ${leftSource}
     where not exists (select 1 from ${rightSource} where ${joinOn})`);

  const addedRows = await right.query(`
    select ${keySelect.replace(/\bl\./g, 'r.')}
      from ${rightSource}
     where not exists (select 1 from ${leftSource} where ${joinOn})`);

  const modifiedRows = canHaveModified
    ? await left.query(`
    select ${keySelect},
           ${canonicalLeft.map((e, i) => `${e} as ${quoteIdent(`lc${i}`, dialect)}`).join(', ')},
           ${canonicalRight.map((e, i) => `${e} as ${quoteIdent(`rc${i}`, dialect)}`).join(', ')}
      from ${leftSource}
      join ${rightSource} on ${joinOn}
     where ${differs}`)
    : [];

  const changes: RowChange[] = [];
  const allChangedKeys: string[] = [];

  for (const row of removedRows) {
    const key = renderKey(row, keyColumns.length);
    allChangedKeys.push(key);
    changes.push({ kind: 'removed', key: displayKey(key) });
  }
  for (const row of addedRows) {
    const key = renderKey(row, keyColumns.length);
    allChangedKeys.push(key);
    changes.push({ kind: 'added', key: displayKey(key) });
  }
  for (const row of modifiedRows) {
    const key = renderKey(row, keyColumns.length);
    allChangedKeys.push(key);
    const columnChanges: ColumnChange[] = [];
    for (let i = 0; i < comparedColumns.length; i++) {
      const before = row[`lc${i}`] === undefined ? null : String(row[`lc${i}`]);
      const after = row[`rc${i}`] === undefined ? null : String(row[`rc${i}`]);
      if (before !== after) {
        columnChanges.push({
          column: comparedColumns[i] as string,
          before: before === null ? null : displayValue(before),
          after: after === null ? null : displayValue(after),
        });
      }
    }
    changes.push({ kind: 'modified', key: displayKey(key), columns: columnChanges });
  }

  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;

  return {
    strategy: 'join',
    changes: changes.slice(0, maxChanges),
    truncated: changes.length > maxChanges,
    summary: {
      added: addedRows.length,
      removed: removedRows.length,
      modified: modifiedRows.length,
      unchanged: Math.max(0, leftRowCount - removedRows.length - modifiedRows.length),
    },
    leftRowCount,
    rightRowCount,
    leftChecksum: null,
    rightChecksum: null,
    allChangedKeys,
  };
}

/**
 * Cross-database diff.
 *
 * Both sides compute the canonical row hash inside their own engine, so only
 * hashes cross the network. The comparison happens in buckets: each side
 * reports a count and two independent checksums per bucket, and only buckets
 * that disagree are expanded down to the row level.
 */
async function runCrossDatabaseDiff(
  left: Source,
  leftInfo: { qualifiedName: string; columns: ColumnInfo[] },
  right: Source,
  rightInfo: { qualifiedName: string; columns: ColumnInfo[] },
  comparedColumns: string[],
  keyColumns: string[],
  options: DiffOptions,
): Promise<DiffRunResult> {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;

  // Each side canonicalizes a column using the *other* side's type for that
  // column, so that a boolean on one side and a 0/1 integer on the other are
  // treated as the same logical type.
  const leftPeerKinds = new Map<string, ColumnKind>();
  const rightPeerKinds = new Map<string, ColumnKind>();
  for (const col of leftInfo.columns) {
    const peer = rightInfo.columns.find((x) => x.name === col.name);
    if (peer) leftPeerKinds.set(col.name, peer.kind);
  }
  for (const col of rightInfo.columns) {
    const peer = leftInfo.columns.find((x) => x.name === col.name);
    if (peer) rightPeerKinds.set(col.name, peer.kind);
  }

  const leftBuckets = await fetchBuckets(
    left,
    leftInfo,
    comparedColumns,
    keyColumns,
    options,
    leftPeerKinds,
  );
  const rightBuckets = await fetchBuckets(
    right,
    rightInfo,
    comparedColumns,
    keyColumns,
    options,
    rightPeerKinds,
  );

  const differing = findDifferingBuckets(leftBuckets, rightBuckets);

  // Expand only the buckets that disagree. The expanded rows must be hashed
  // exactly as the buckets were, so the same peer kinds are used.
  const leftRows = differing.length
    ? await fetchHashes(
        left,
        leftInfo,
        comparedColumns,
        keyColumns,
        options,
        differing,
        leftPeerKinds,
      )
    : [];
  const rightRows = differing.length
    ? await fetchHashes(
        right,
        rightInfo,
        comparedColumns,
        keyColumns,
        options,
        differing,
        rightPeerKinds,
      )
    : [];

  const leftMap = new Map<string, string>();
  for (const h of leftRows) leftMap.set(h.key, h.hash);
  const rightMap = new Map<string, string>();
  for (const h of rightRows) rightMap.set(h.key, h.hash);

  const changes: RowChange[] = [];
  const allChangedKeys: string[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const [key, lhash] of leftMap) {
    const rhash = rightMap.get(key);
    if (rhash === undefined) {
      removed++;
      allChangedKeys.push(key);
      changes.push({ kind: 'removed', key: displayKey(key) });
    } else if (rhash !== lhash) {
      modified++;
      allChangedKeys.push(key);
      changes.push({ kind: 'modified', key: displayKey(key) });
    }
  }
  for (const key of rightMap.keys()) {
    if (!leftMap.has(key)) {
      added++;
      allChangedKeys.push(key);
      changes.push({ kind: 'added', key: displayKey(key) });
    }
  }

  const truncated = changes.length > maxChanges;
  const leftRowCount = leftBuckets.total;
  const rightRowCount = rightBuckets.total;

  return {
    strategy: 'checksum',
    changes: changes.slice(0, maxChanges),
    truncated,
    summary: {
      added,
      removed,
      modified,
      unchanged: Math.max(0, leftRowCount - removed - modified),
    },
    leftRowCount,
    rightRowCount,
    leftChecksum: leftBuckets.checksum,
    rightChecksum: rightBuckets.checksum,
    allChangedKeys,
  };
}

/** Per-bucket aggregates for one side of a cross-database comparison. */
interface BucketSummary {
  /** bucket id -> [count, checksum1, checksum2] */
  buckets: Map<number, [number, string, string]>;
  total: number;
  checksum: string;
}

/**
 * Builds a count expression that returns a number rather than a string.
 *
 * Postgres and DuckDB use `::bigint`. MySQL and SQLite have no `::` cast
 * operator at all, so they use a plain `count(*)`.
 */
function countExpr(dialect: Dialect): string {
  if (dialect === 'mysql' || dialect === 'sqlite') return 'count(*)';
  return 'count(*)::bigint';
}

/**
 * The kind a column should be canonicalized as, given the other side's kind.
 *
 * A boolean on one side and a 0/1 integer on the other are the same logical
 * type — SQLite has no boolean type, so a boolean there is an integer. They
 * must canonicalize identically or every row would read as different.
 */
function resolveKind(ownKind: ColumnKind, peerKind: ColumnKind | undefined): ColumnKind {
  if (peerKind === undefined) return ownKind;
  if (
    (ownKind === 'boolean' && peerKind === 'integer') ||
    (ownKind === 'integer' && peerKind === 'boolean')
  ) {
    return 'boolean';
  }
  return ownKind;
}

/**
 * Joins canonical key expressions into one string, per dialect.
 *
 * MySQL parses `||` as a logical OR, so it needs `concat()`.
 */
function joinKeyExprs(parts: string[], dialect: Dialect): string {
  if (parts.length === 0) return "''";
  return concatSepExpr(parts, KEY_JOIN, dialect);
}

/** Computes the bucket id for a row, from the hash of its canonical key. */
function bucketExpr(canonicalKey: string, dialect: Dialect): string {
  const hexSlice = `substr(md5(${canonicalKey}), 1, 8)`;
  return `(${canonicalHexToIntExpr(hexSlice, dialect)} % ${BUCKET_COUNT})`;
}

/**
 * Computes per-bucket aggregates inside one engine.
 *
 * The bucket id is derived from the canonical key, so the same logical row
 * lands in the same bucket on both sides. Each bucket carries a count and two
 * checksums taken from different slices of the row hash, so a bucket that
 * agrees on all three is treated as identical.
 */
async function fetchBuckets(
  source: Source,
  info: { qualifiedName: string; columns: ColumnInfo[] },
  comparedColumns: string[],
  keyColumns: string[],
  options: DiffOptions,
  peerKinds?: Map<string, ColumnKind>,
): Promise<BucketSummary> {
  const dialect = source.dialect;
  const table = quoteQualified(info.qualifiedName, dialect);

  const allColumns = [...keyColumns, ...comparedColumns];
  const canonicalCols = allColumns.map((c) => {
    const col = info.columns.find((x) => x.name === c);
    return canonicalExpr(
      quoteIdent(c, dialect),
      resolveKind(col?.kind ?? 'unknown', peerKinds?.get(c)),
      dialect,
    );
  });

  const where = options.where ? ` where ${options.where}` : '';
  const limit = options.sampleOnly ? ` limit ${options.sampleLimit ?? 100_000}` : '';

  // The inner query selects the canonical column expressions under stable
  // names, so the outer query can group by them without repeating the
  // expressions. The row hash is computed over the canonical values, exactly
  // as `rowHashExpr` would build it.
  const innerNames = allColumns.map((_c, i) => `c${i}`);
  const innerSelect = canonicalCols.map(
    (e, i) => `${e} as ${quoteIdent(innerNames[i] as string, dialect)}`,
  );

  const hashOverInner = rowHashExpr(
    innerNames.map((n) => quoteIdent(n, dialect)),
    dialect,
  );

  const sql = `
    select ${bucketExpr(
      joinKeyExprs(
        innerNames.slice(0, keyColumns.length).map((n) => quoteIdent(n, dialect)),
        dialect,
      ),
      dialect,
    )} as bucket,
           ${countExpr(dialect)} as n,
           ${checksumExpr(hashOverInner, dialect)} as c1,
           ${checksumExpr(`substr(${hashOverInner}, ${HASH_DIGITS + 1}, ${HASH_DIGITS})`, dialect)} as c2
      from (select ${innerSelect.join(', ')} from ${table}${where}${limit}) t
     group by 1`;

  // The overall checksum is the sum of every row hash's leading digits,
  // reduced. It is a separate query rather than a sum of the per-bucket
  // checksums, because a bucket's checksum is already reduced modulo
  // 2^61-1 and summing reduced values is not the same as reducing the sum.
  const overallSql = `
    select ${checksumExpr(hashOverInner, dialect)} as checksum
      from (select ${innerSelect.join(', ')} from ${table}${where}${limit}) t`;

  const [rows, overallRows] = await Promise.all([source.query(sql), source.query(overallSql)]);

  const buckets = new Map<number, [number, string, string]>();
  let total = 0;
  for (const row of rows) {
    const bucket = Number(row.bucket);
    buckets.set(bucket, [Number(row.n ?? 0), String(row.c1 ?? ''), String(row.c2 ?? '')]);
    total += Number(row.n ?? 0);
  }

  const checksum = String(overallRows[0]?.checksum ?? '0');
  return { buckets, total, checksum };
}

/** Finds the buckets whose aggregates disagree between the two sides. */
function findDifferingBuckets(left: BucketSummary, right: BucketSummary): number[] {
  const differing: number[] = [];
  const allBuckets = new Set([...left.buckets.keys(), ...right.buckets.keys()]);
  for (const bucket of allBuckets) {
    const l = left.buckets.get(bucket);
    const r = right.buckets.get(bucket);
    if (!l || !r || l[0] !== r[0] || l[1] !== r[1] || l[2] !== r[2]) {
      differing.push(bucket);
    }
  }
  return differing;
}

/** A row hash and the key that identifies it. */
interface HashedRow {
  key: string;
  hash: string;
}

/**
 * Fetches the canonical row hash for the rows in the given buckets.
 *
 * Only the requested buckets are read, so a table that differs in a handful of
 * rows transfers a handful of hashes rather than the whole table.
 */
async function fetchHashes(
  source: Source,
  info: { qualifiedName: string; columns: ColumnInfo[] },
  comparedColumns: string[],
  keyColumns: string[],
  options: DiffOptions,
  buckets: number[],
  peerKinds?: Map<string, ColumnKind>,
): Promise<HashedRow[]> {
  const dialect = source.dialect;
  const table = quoteQualified(info.qualifiedName, dialect);

  const allColumns = [...keyColumns, ...comparedColumns];
  const canonicalCols = allColumns.map((c) => {
    const col = info.columns.find((x) => x.name === c);
    return canonicalExpr(
      quoteIdent(c, dialect),
      resolveKind(col?.kind ?? 'unknown', peerKinds?.get(c)),
      dialect,
    );
  });

  // The inner query selects the canonical column expressions under stable
  // names, so the outer query can reference them and compute the row hash
  // over exactly the same canonical values.
  const innerNames = allColumns.map((_c, i) => `c${i}`);
  const innerSelect = canonicalCols.map(
    (e, i) => `${e} as ${quoteIdent(innerNames[i] as string, dialect)}`,
  );
  const hashOverInner = rowHashExpr(
    innerNames.map((n) => quoteIdent(n, dialect)),
    dialect,
  );
  const bucket = bucketExpr(
    joinKeyExprs(
      innerNames.slice(0, keyColumns.length).map((n) => quoteIdent(n, dialect)),
      dialect,
    ),
    dialect,
  );

  const bucketList = buckets.join(', ');
  const where = options.where ? ` where ${options.where}` : '';

  const sql = `
    select ${innerNames
      .slice(0, keyColumns.length)
      .map((n, i) => `${quoteIdent(n, dialect)} as ${quoteIdent(`k${i}`, dialect)}`)
      .join(', ')},
           ${hashOverInner} as ${quoteIdent('__hash', dialect)}
      from (select ${innerSelect.join(', ')} from ${table}${where}) t
     where ${bucket} in (${bucketList})`;

  const rows = await source.query(sql);
  return rows.map((row) => ({
    key: renderKey(row, keyColumns.length),
    hash: String(row.__hash ?? ''),
  }));
}

/** Separator used when a composite key is rendered as a single string. */
const KEY_JOIN = '';

/** Renders a composite key from the `k0`, `k1`, ... columns of a row. */
function renderKey(row: Record<string, unknown>, keyCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    const v = row[`k${i}`];
    parts.push(v === undefined || v === null ? 'N' : String(v));
  }
  return parts.join(KEY_JOIN);
}

/**
 * Strips the canonical tags from a rendered key, for display.
 *
 * The tagged form is what the attribution queries match on, so it is kept
 * internally; only the copy that reaches the report is untagged.
 */
function displayKey(key: string): string {
  return key
    .split(KEY_JOIN)
    .map((part) => displayValue(part))
    .join(KEY_JOIN);
}

/** The `IS DISTINCT FROM` equivalent for each dialect. */
function isDistinctFrom(left: string, right: string, dialect: Dialect): string {
  if (dialect === 'mysql') {
    // MySQL's null-safe equality operator.
    return `not (${left} <=> ${right})`;
  }
  if (dialect === 'sqlite') {
    // SQLite has no IS DISTINCT FROM. The null-safe equivalent is a pair of
    // comparisons: the values differ if exactly one of them is NULL, or if
    // neither is NULL and they are not equal.
    return `((${left} is null) <> (${right} is null) or (${left} is not null and ${right} is not null and ${left} <> ${right}))`;
  }
  return `${left} is distinct from ${right}`;
}

/** Chooses which columns to compare. */
function pickComparedColumns(
  leftColumns: ColumnInfo[],
  rightColumns: ColumnInfo[],
  keyColumns: string[],
  requested?: string[],
): string[] {
  if (requested && requested.length > 0) return requested;
  const rightNames = new Set(rightColumns.map((c) => c.name));
  const keys = new Set(keyColumns);
  return leftColumns.map((c) => c.name).filter((name) => rightNames.has(name) && !keys.has(name));
}

/**
 * Compares the two schemas.
 *
 * Types are compared by their canonicalization family rather than by their raw
 * engine-specific spelling, because `integer` in Postgres and `int` in MySQL
 * are the same logical type. The raw names are still reported so a reader can
 * see the difference.
 */
export function compareSchemas(
  leftColumns: ColumnInfo[],
  rightColumns: ColumnInfo[],
): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  const leftMap = new Map(leftColumns.map((c) => [c.name, c]));
  const rightMap = new Map(rightColumns.map((c) => [c.name, c]));

  for (const [name, lc] of leftMap) {
    const rc = rightMap.get(name);
    if (!rc) {
      differences.push({ column: name, kind: 'removed', leftType: lc.dataType });
      continue;
    }
    // A boolean and a 0/1 integer are the same logical type. SQLite has no
    // boolean type, so a boolean there is an integer, and MySQL reports
    // booleans as `tinyint(1)`. Reporting that as a type change would make
    // every cross-engine diff of a table with a boolean column look broken.
    const isBooleanPair =
      (lc.kind === 'boolean' && rc.kind === 'integer') ||
      (lc.kind === 'integer' && rc.kind === 'boolean');
    if (lc.kind !== rc.kind && !isBooleanPair) {
      differences.push({
        column: name,
        kind: 'type_changed',
        leftType: lc.dataType,
        rightType: rc.dataType,
      });
    }
    if (lc.nullable !== rc.nullable) {
      differences.push({
        column: name,
        kind: 'nullability_changed',
        leftNullable: lc.nullable,
        rightNullable: rc.nullable,
      });
    }
  }
  for (const [name, rc] of rightMap) {
    if (!leftMap.has(name)) {
      differences.push({ column: name, kind: 'removed', rightType: rc.dataType });
    }
  }
  return differences;
}

/**
 * Renders a canonical value for display.
 *
 * The canonical form is tagged (`V` for a value, `N` for NULL) so that the
 * two can never be confused. The tag is stripped for display, but a NULL is
 * still shown as NULL rather than as an empty string.
 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value);
  if (text === NULL_TAG) return 'NULL';
  if (text.startsWith(VALUE_TAG)) return text.slice(1);
  return text;
}

/**
 * Finds the values that the changes concentrate on.
 *
 * For each candidate column, the distribution of that column among the changed
 * rows is compared to its distribution across the whole table. A value that is
 * far more common among the changed rows than expected points at the slice of
 * data that was affected — the difference between "something moved" and "the
 * VAT change landed on German orders".
 */
async function computeAttributions(
  source: Source,
  info: { qualifiedName: string; columns: ColumnInfo[] },
  comparedColumns: string[],
  keyColumns: string[],
  changedKeys: string[],
  options: DiffOptions,
  warnings: string[],
): Promise<Attribution[]> {
  if (changedKeys.length === 0) return [];

  const dialect = source.dialect;
  const table = quoteQualified(info.qualifiedName, dialect);
  const maxAttributions = options.maxAttributions ?? DEFAULT_MAX_ATTRIBUTIONS;
  const topValues = options.attributionValues ?? 20;
  const minShare = options.minAttributionShare ?? 0.1;

  const candidates = comparedColumns.filter((c) => {
    const col = info.columns.find((x) => x.name === c);
    return col && (col.kind === 'text' || col.kind === 'uuid' || col.kind === 'integer');
  });
  if (candidates.length === 0) return [];

  const attributions: Attribution[] = [];

  for (const column of candidates.slice(0, 12)) {
    const col = info.columns.find((x) => x.name === column);
    if (!col) continue;
    const expr = canonicalExpr(quoteIdent(column, dialect), col.kind, dialect);

    // Distribution across the whole table.
    const baseRows = await source.query(
      `select ${expr} as v, ${countExpr(dialect)} as n from ${table} group by 1 order by n desc limit ${topValues}`,
    );
    if (baseRows.length === 0) continue;
    const baseTotal = baseRows.reduce((acc, r) => acc + Number(r.n ?? 0), 0);
    if (baseTotal === 0) continue;

    // How many changed rows fall into each of those buckets.
    const keyExpr = joinKeyExprs(
      keyColumns.map((k) => {
        const kc = info.columns.find((x) => x.name === k);
        return canonicalExpr(quoteIdent(k, dialect), kc?.kind ?? 'unknown', dialect);
      }),
      dialect,
    );

    const keyList = changedKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
    const changedRows = await source.query(
      `select ${expr} as v, ${countExpr(dialect)} as n
         from ${table}
        where ${keyExpr} in (${keyList})
        group by 1`,
    );
    const changedTotal = changedRows.reduce((acc, r) => acc + Number(r.n ?? 0), 0);
    if (changedTotal === 0) continue;

    for (const row of changedRows) {
      const value = displayValue(row.v);
      const count = Number(row.n ?? 0);
      const share = count / changedTotal;

      if (share < minShare) continue;

      const baseCount = Number(baseRows.find((b) => displayValue(b.v) === value)?.n ?? 0);
      const baseShare = baseCount / baseTotal;
      if (baseShare === 0) continue;

      const overRepresentation = share / baseShare;
      if (overRepresentation <= 1.2) continue;

      attributions.push({ column, value, count, share, overRepresentation });
    }
  }

  attributions.sort((a, b) => b.overRepresentation * b.count - a.overRepresentation * a.count);
  if (attributions.length > maxAttributions) {
    warnings.push(
      `Showing the top ${maxAttributions} attributions; ${attributions.length} segments qualified.`,
    );
  }
  return attributions.slice(0, maxAttributions);
}

/** Turns the diff signals into a risk verdict. */
function assessRisk(
  result: DiffRunResult,
  schemaDifferences: SchemaDifference[],
  attributions: Attribution[],
  warnings: string[],
): { level: RiskLevel; reason: string; signals: string[] } {
  const signals: string[] = [];
  const { added, removed, modified } = result.summary;
  const total = added + removed + modified;

  if (total === 0 && schemaDifferences.length === 0) {
    return { level: 'none', reason: 'The two sides are identical.', signals: [] };
  }

  const leftRows = result.leftRowCount || 1;
  const changeRatio = total / leftRows;

  if (removed > 0) signals.push(`${removed} row(s) exist only on the left`);
  if (added > 0) signals.push(`${added} row(s) exist only on the right`);
  if (modified > 0) signals.push(`${modified} row(s) differ in at least one column`);

  const breakingSchema = schemaDifferences.filter(
    (d) => d.kind === 'removed' || d.kind === 'type_changed',
  );
  if (breakingSchema.length > 0) {
    signals.push(
      `${breakingSchema.length} column(s) were removed or changed type, which can break consumers`,
    );
  }

  const dominant = attributions[0];
  if (dominant && dominant.overRepresentation >= 3) {
    signals.push(
      `${(dominant.share * 100).toFixed(1)}% of changes share ${dominant.column} = ${dominant.value} ` +
        `(${dominant.overRepresentation.toFixed(1)}x over-represented)`,
    );
  }

  let level: RiskLevel = 'none';
  if (breakingSchema.length > 0 && (added > 0 || removed > 0)) {
    level = 'critical';
  } else if (breakingSchema.length > 0) {
    level = 'high';
  } else if (changeRatio >= 0.25) {
    level = 'high';
  } else if (changeRatio >= 0.05) {
    level = 'medium';
  } else if (total > 0) {
    level = 'low';
  }

  if (result.strategy === 'checksum' && level !== 'none') {
    warnings.push(
      'Cross-database comparison matched rows on their canonical hash; the changed columns were not localised.',
    );
  }

  const reason =
    level === 'none'
      ? 'No differences were found.'
      : `${total} difference(s) found across ${leftRows.toLocaleString('en-US')} row(s) ` +
        `(${(changeRatio * 100).toFixed(2)}% of the left side).`;

  return { level, reason, signals };
}
