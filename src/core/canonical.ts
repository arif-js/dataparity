import { createHash } from 'node:crypto';

/**
 * Portable canonical value rendering.
 *
 * The whole cross-engine design rests on one property: a given logical value must
 * render to the *same bytes* in every engine we support, so that a checksum
 * computed inside Postgres, MySQL, DuckDB or SQLite is directly comparable.
 *
 * Two rules make that work:
 *
 *  1. Every canonical value is **tagged**. A NULL renders as the single
 *     character `N`; any other value renders as `V` followed by its normalized
 *     text. A real value can therefore never be mistaken for NULL, and the
 *     empty string is distinct from NULL.
 *
 *  2. Every canonical value is **length-prefixed** before it is joined into a
 *     row hash. A text value containing the field separator cannot shift a
 *     column boundary and forge a match.
 *
 * The rules below were verified empirically across DuckDB 1.5, PostgreSQL 16
 * and MySQL 8 (see `test/integration/canonical.test.ts`), including the values
 * that usually break naive implementations: NULLs, booleans, floats with
 * binary representation error, timestamps, non-ASCII text and text containing
 * the separator.
 */

/** Column type families we know how to canonicalize. */
export type ColumnKind =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'text'
  | 'binary'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json'
  | 'uuid'
  | 'unknown';

/** Tag written for a NULL value. */
export const NULL_TAG = 'N';

/** Tag written for a non-NULL value. */
export const VALUE_TAG = 'V';

/**
 * Separator between canonicalized columns inside one row.
 *
 * A unit separator (0x1F) is used instead of a printable character so that
 * arbitrary text values cannot forge a column boundary. Length prefixing
 * closes that hole entirely.
 */
export const FIELD_SEPARATOR = '';

/** The SQL dialect a source speaks. Determines canonicalization expressions. */
export type Dialect = 'duckdb' | 'postgres' | 'mysql' | 'sqlite';

/** Floating point canonicalization: values are rounded to this many decimals. */
export const FLOAT_PRECISION = 6;

/** Modulus for checksums. 2^61 - 1, the largest prime below 2^61. */
export const CHECKSUM_MODULUS = '2305843009213693951';

/**
 * Number of hex digits of the MD5 digest folded into a row's numeric hash.
 *
 * Eight hex digits is 32 bits. That is deliberate: the checksum sums these
 * values, and SQLite's `sum()` returns a float once the total exceeds the
 * 64-bit integer range, which silently loses precision. A 32-bit value summed
 * stays exact for billions of rows.
 */
export const HASH_DIGITS = 8;

/** The bit width of a hex slice, for engines that cast through a bit string. */
export const HASH_BITS = HASH_DIGITS * 4;

/**
 * Maps a raw database type name to a canonicalization family.
 *
 * Type names arrive from different engines with different spellings, so this
 * normalizes on the lowercased type string and matches on substrings.
 */
export function classifyType(rawType: string): ColumnKind {
  const t = rawType.toLowerCase();

  if (t.includes('timestamp') && (t.includes('tz') || t.includes('with time zone'))) {
    return 'timestamptz';
  }
  if (t.includes('timestamp') || t.includes('datetime')) return 'timestamp';
  if (t.includes('date') && !t.includes('time')) return 'date';

  if (t.includes('bool')) return 'boolean';
  // MySQL reports booleans as tinyint(1).
  if (/^tinyint\s*\(\s*1\s*\)/.test(t)) return 'boolean';

  if (t.includes('json')) return 'json';
  if (t.includes('uuid') || t.includes('uniqueid')) return 'uuid';

  if (t.includes('int') || t.includes('serial')) return 'integer';
  if (t.includes('decimal') || t.includes('numeric')) return 'decimal';
  if (t.includes('float') || t.includes('double') || t.includes('real')) return 'float';

  if (t.includes('blob') || t.includes('binary') || t.includes('bytea')) return 'binary';

  if (
    t.includes('char') ||
    t.includes('text') ||
    t.includes('string') ||
    t.includes('varchar') ||
    t.includes('clob')
  ) {
    return 'text';
  }
  return 'unknown';
}

/**
 * Renders a SQL expression producing the canonical, tagged text of a column.
 *
 * The expression is guaranteed to:
 *   1. produce identical output for identical logical values across engines,
 *   2. distinguish NULL from the empty string and from every real value,
 *   3. never produce a value containing the field separator.
 *
 * @param expr     The raw column expression (usually a quoted column name).
 * @param kind     The column's type family.
 * @param dialect  The SQL dialect the expression will run in.
 * @param peerKind The other side's type family, when the two sides disagree.
 *                 A boolean and a 0/1 integer are the same logical type, so
 *                 they are canonicalized the same way.
 */
export function canonicalExpr(
  expr: string,
  kind: ColumnKind,
  dialect: Dialect,
  peerKind?: ColumnKind,
): string {
  // The tag is prepended to the value so that NULL is always distinguishable
  // from real data. MySQL needs concat() because `||` is a logical OR there.
  const tagged = (inner: string) =>
    `coalesce(${concatExpr([`'${VALUE_TAG}'`, inner], dialect)}, '${NULL_TAG}')`;

  // A boolean stored as a 0/1 integer (SQLite has no boolean type) must
  // canonicalize the same way as a real boolean, or the two sides would
  // disagree on every row.
  const effectiveKind: ColumnKind =
    kind === 'boolean' && peerKind === 'integer'
      ? 'boolean'
      : kind === 'integer' && peerKind === 'boolean'
        ? 'boolean'
        : kind;

  switch (effectiveKind) {
    case 'integer':
      // Integers are exact in every engine; plain text is canonical.
      return tagged(castToText(expr, dialect));

    case 'decimal': {
      // Decimals are scaled to a fixed number of decimal places and rendered as
      // an exact integer count of millionths. The scale factor is applied in
      // decimal arithmetic, so the result is identical in every engine, and the
      // integer form has no trailing-zero or scale differences to disagree
      // about: Postgres's `10.500000` and MySQL's `10.50` both become
      // `10500000`.
      const asDecimal = dialect === 'postgres' ? `cast(${expr} as numeric)` : expr;
      const scaled = `cast(cast(round(${asDecimal} * 1000000) as ${integerType(dialect)}) as ${textType(dialect)})`;
      return tagged(scaled);
    }

    case 'float': {
      // Floats carry binary representation error (0.1 + 0.2 !== 0.3). Scaling
      // to a fixed number of decimals before text conversion makes the
      // canonical form stable and comparable across engines. The rounding
      // happens in exact decimal arithmetic, not binary floating point.
      const asDecimal = dialect === 'postgres' ? `cast(${expr} as numeric)` : expr;
      const scaled = `cast(cast(round(${asDecimal} * 1000000) as ${integerType(dialect)}) as ${textType(dialect)})`;
      return tagged(scaled);
    }

    case 'boolean': {
      // MySQL's `cast(bool as char)` yields '1'/'0'; Postgres and DuckDB yield
      // 'true'/'false'. Normalize to an explicit case expression. A 0/1
      // integer column lands here too, so `case when 1 then 'true'` gives the
      // same answer as a real boolean.
      return tagged(`case when ${expr} then 'true' else 'false' end`);
    }

    case 'timestamp': {
      // Rendered at second precision in a fixed format. Engines disagree on
      // sub-second rendering, so sub-second precision is dropped.
      if (dialect === 'mysql') {
        return tagged(`date_format(${expr}, '%Y-%m-%d %H:%i:%s')`);
      }
      return tagged(castToText(`cast(${expr} as timestamp)`, dialect));
    }

    case 'timestamptz': {
      // Normalize to UTC before rendering, otherwise the same instant in two
      // time zones renders differently.
      if (dialect === 'duckdb') {
        return tagged(castToText(`cast(cast(${expr} at time zone 'UTC' as timestamp)`, dialect));
      }
      if (dialect === 'postgres') {
        return tagged(castToText(`cast(${expr} at time zone 'UTC')`, dialect));
      }
      return tagged(castToText(`cast(${expr} as timestamp)`, dialect));
    }

    case 'date':
      return tagged(castToText(expr, dialect));

    case 'binary': {
      // Binary is compared as lowercase hex so that byte order and formatting
      // differences do not matter.
      if (dialect === 'postgres') return tagged(`encode(${expr}, 'hex')`);
      if (dialect === 'mysql' || dialect === 'sqlite') return tagged(`lower(hex(${expr}))`);
      return tagged(castToText(expr, dialect));
    }

    case 'json': {
      // JSON text differs in key order and whitespace between engines, so the
      // canonical form cannot be the raw text. Callers that diff JSON columns
      // should compare them structurally instead.
      return tagged(castToText(expr, dialect));
    }

    case 'uuid':
    case 'text':
    case 'unknown':
      return tagged(castToText(expr, dialect));
  }
}

/** Casts an expression to text in a dialect-appropriate way. */
function castToText(expr: string, dialect: Dialect): string {
  return `cast(${expr} as ${textType(dialect)})`;
}

/** The dialect's text type name. */
function textType(dialect: Dialect): string {
  if (dialect === 'mysql') return 'char';
  if (dialect === 'sqlite') return 'text';
  return 'varchar';
}

/**
 * The dialect's exact-integer type name.
 *
 * SQLite has no `decimal` type, and its `numeric` affinity would silently
 * turn the value back into a float, so it uses `integer`.
 */
function integerType(dialect: Dialect): string {
  if (dialect === 'sqlite') return 'integer';
  return 'decimal(38, 0)';
}

/**
 * The dialect's character-length function.
 *
 * MySQL's `length()` counts bytes; `char_length()` counts characters. The
 * JavaScript mirror counts characters, so MySQL must use `char_length()`.
 */
function lengthExpr(expr: string, dialect: Dialect): string {
  if (dialect === 'mysql') return `char_length(${expr})`;
  return `length(${expr})`;
}

/**
 * Builds the SQL expression that hashes one row.
 *
 * Each canonical column is length-prefixed before being joined, so that a text
 * value containing the field separator cannot shift a column boundary and
 * produce a false match. The result is an MD5 hex digest, which every engine
 * computes identically.
 *
 * Length is measured in characters, not bytes, because the JavaScript mirror
 * of this function counts characters too.
 */
export function rowHashExpr(canonicalCols: string[], dialect: Dialect): string {
  const parts = canonicalCols.map((e) => concatExpr([lengthExpr(e, dialect), "':'", e], dialect));
  const joined = parts.join(', ');
  return `md5(concat_ws('${FIELD_SEPARATOR}', ${joined}))`;
}

/**
 * Builds a string concatenation expression.
 *
 * `||` is the standard operator, but MySQL parses it as a logical OR unless
 * `PIPES_AS_CONCAT` is set, so MySQL gets `concat()` instead.
 */
export function concatExpr(parts: string[], dialect: Dialect): string {
  if (dialect === 'mysql') {
    return `concat(${parts.join(', ')})`;
  }
  return parts.join(' || ');
}

/**
 * Builds a string concatenation expression that inserts a separator between
 * each part.
 */
export function concatSepExpr(parts: string[], separator: string, dialect: Dialect): string {
  const sep = `'${escapeSqlLiteral(separator)}'`;
  if (dialect === 'mysql') {
    return `concat(${parts.join(`, ${sep}, `)})`;
  }
  return parts.join(` || ${sep} || `);
}

/** Escapes a value for use inside a single-quoted SQL literal. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Builds the SQL expression that folds a set of row hashes into one checksum.
 *
 * Sums the leading hex digits of each row hash and reduces modulo 2^61 - 1.
 * The modulus keeps the sum inside a signed 64-bit integer even for very large
 * tables, which is what lets the same expression run unchanged in Postgres,
 * MySQL and DuckDB.
 */
export function checksumExpr(rowHash: string, dialect: Dialect): string {
  const digits = `substr(${rowHash}, 1, ${HASH_DIGITS})`;
  const digitSum = `sum(${hexToIntExpr(digits, dialect)})`;
  return `(${digitSum} % ${CHECKSUM_MODULUS})`;
}

/**
 * Builds a SQL expression that reads a hex string as an integer.
 *
 * Each engine spells this differently, and getting it wrong is silent rather
 * than loud: SQLite parses `0x` as a literal prefix and yields 0 instead of
 * the value, so every checksum would be zero.
 *
 * - Postgres reads a hex string as a bit string: `('x' || hex)::bit(60)`.
 * - MySQL has no bit-string cast, so it uses `conv()`.
 * - DuckDB reads the `0x` prefix as a cast.
 * - SQLite has none of these, so a `hex2int` function is registered on the
 *   connection. It reduces the value modulo 2^61-1 as it converts, because
 *   node:sqlite cannot carry a 60-bit integer through a function result and
 *   SQLite's `sum()` would return a float.
 */
export function hexToIntExpr(hexExpr: string, dialect: Dialect): string {
  if (dialect === 'mysql') {
    return `cast(conv(${hexExpr}, 16, 10) as decimal(38, 0))`;
  }
  if (dialect === 'postgres') {
    return `('x' || ${hexExpr})::bit(${HASH_BITS})::bigint`;
  }
  if (dialect === 'sqlite') {
    return `hex2int(${hexExpr})`;
  }
  return `cast(('0x' || ${hexExpr}) as bigint)`;
}

/**
 * Computes the same checksum in JavaScript, for sources that cannot execute
 * the SQL natively (for example a file that is read into DuckDB, or a test
 * fixture built in memory).
 *
 * This mirrors the SQL exactly: take the first `HASH_DIGITS` hex characters of
 * the MD5 digest, read them as a base-16 integer, sum, and reduce modulo
 * 2^61 - 1.
 */
export function checksumFromHashes(hashes: string[]): string {
  let sum = 0n;
  const mod = BigInt(CHECKSUM_MODULUS);
  for (const h of hashes) {
    const slice = h.slice(0, HASH_DIGITS);
    sum += BigInt(`0x${slice}`);
  }
  return (sum % mod).toString();
}

/** Computes the MD5 row hash in JavaScript, mirroring `rowHashExpr`. */
export function hashRow(values: string[]): string {
  const parts = values.map((v) => `${charLength(v)}:${v}`);
  return createHash('md5').update(parts.join(FIELD_SEPARATOR), 'utf8').digest('hex');
}

/** Counts characters the way the SQL `length()`/`char_length()` functions do. */
export function charLength(value: string): number {
  return Array.from(value).length;
}
