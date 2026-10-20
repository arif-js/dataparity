import { describe, expect, it } from 'vitest';
import {
  canonicalExpr,
  charLength,
  checksumExpr,
  checksumFromHashes,
  classifyType,
  FIELD_SEPARATOR,
  HASH_BITS,
  HASH_DIGITS,
  hashRow,
  NULL_TAG,
  rowHashExpr,
  VALUE_TAG,
} from '../../src/core/canonical.js';

describe('classifyType', () => {
  it('maps engine type names to canonicalization families', () => {
    expect(classifyType('integer')).toBe('integer');
    expect(classifyType('bigint')).toBe('integer');
    expect(classifyType('numeric(10,2)')).toBe('decimal');
    expect(classifyType('double precision')).toBe('float');
    expect(classifyType('float8')).toBe('float');
    expect(classifyType('boolean')).toBe('boolean');
    expect(classifyType('tinyint(1)')).toBe('boolean');
    expect(classifyType('character varying(255)')).toBe('text');
    expect(classifyType('text')).toBe('text');
    expect(classifyType('timestamp without time zone')).toBe('timestamp');
    expect(classifyType('datetime')).toBe('timestamp');
    expect(classifyType('timestamp with time zone')).toBe('timestamptz');
    expect(classifyType('date')).toBe('date');
    expect(classifyType('bytea')).toBe('binary');
    expect(classifyType('blob')).toBe('binary');
    expect(classifyType('jsonb')).toBe('json');
    expect(classifyType('uuid')).toBe('uuid');
  });

  it('falls back to unknown for types it does not recognise', () => {
    expect(classifyType('geometry')).toBe('unknown');
    expect(classifyType('')).toBe('unknown');
  });
});

describe('canonicalExpr', () => {
  it('tags every value so NULL can never collide with real data', () => {
    for (const dialect of ['duckdb', 'postgres', 'mysql', 'sqlite'] as const) {
      const expr = canonicalExpr('col', 'text', dialect);
      expect(expr).toContain(`'${VALUE_TAG}'`);
      expect(expr).toContain(`'${NULL_TAG}'`);
      expect(expr.startsWith('coalesce(')).toBe(true);
    }
  });

  it('renders booleans the same way in every dialect', () => {
    for (const dialect of ['duckdb', 'postgres', 'mysql', 'sqlite'] as const) {
      const expr = canonicalExpr('flag', 'boolean', dialect);
      expect(expr).toContain("then 'true' else 'false'");
    }
  });

  it('scales floats through an exact decimal so binary error is erased', () => {
    const expr = canonicalExpr('amt', 'float', 'duckdb');
    expect(expr).toContain('1000000');
    expect(expr).toContain('decimal(38, 0)');
  });

  it('uses the right text type per dialect', () => {
    expect(canonicalExpr('c', 'text', 'mysql')).toContain('as char');
    expect(canonicalExpr('c', 'text', 'sqlite')).toContain('as text');
    expect(canonicalExpr('c', 'text', 'postgres')).toContain('as varchar');
    expect(canonicalExpr('c', 'text', 'duckdb')).toContain('as varchar');
  });

  it('normalizes timestamps to UTC when the column is timezone-aware', () => {
    expect(canonicalExpr('ts', 'timestamptz', 'postgres')).toContain('at time zone');
    expect(canonicalExpr('ts', 'timestamptz', 'duckdb')).toContain('at time zone');
  });
});

describe('rowHashExpr', () => {
  it('length-prefixes each column so a separator in the data cannot shift a boundary', () => {
    const expr = rowHashExpr(['a', 'b'], 'duckdb');
    expect(expr).toContain(`md5(concat_ws('${FIELD_SEPARATOR}'`);
    expect(expr).toContain("length(a) || ':' || a");
  });

  it('counts characters rather than bytes for MySQL', () => {
    const expr = rowHashExpr(['a'], 'mysql');
    expect(expr).toContain('char_length(a)');
    // The plain byte-counting length() must not be used.
    expect(expr).not.toMatch(/\blength\(/);
  });
});

describe('hashRow', () => {
  it('is stable for the same values', () => {
    const a = hashRow(['V1', 'Vhello']);
    const b = hashRow(['V1', 'Vhello']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes when any value changes', () => {
    expect(hashRow(['V1', 'Va'])).not.toBe(hashRow(['V1', 'Vb']));
  });

  it('does not confuse a value boundary shift with an equal value', () => {
    // Without length prefixing, these two would hash identically.
    expect(hashRow(['Va', 'Vb'])).not.toBe(hashRow(['VaV', 'b']));
  });

  it('distinguishes NULL from the empty string', () => {
    expect(hashRow([NULL_TAG])).not.toBe(hashRow([`${VALUE_TAG}`]));
  });

  it('counts characters the same way SQL length() does', () => {
    // An emoji is one character but several bytes.
    expect(charLength('😀')).toBe(1);
    expect(hashRow(['😀'])).toBe(hashRow(['😀']));
  });
});

describe('checksum', () => {
  it('sums the leading hex digits and reduces modulo 2^61 - 1', () => {
    const hashes = ['ffffffff000000000000000000000000', '11111111000000000000000000000000'];
    const expected = (
      (BigInt(`0x${hashes[0]?.slice(0, HASH_DIGITS)}`) +
        BigInt(`0x${hashes[1]?.slice(0, HASH_DIGITS)}`)) %
      2305843009213693951n
    ).toString();
    expect(checksumFromHashes(hashes)).toBe(expected);
  });

  it('is order-independent, because it is a sum', () => {
    const a = checksumFromHashes([
      'abc1230000000000000000000000000',
      'def4560000000000000000000000000',
    ]);
    const b = checksumFromHashes([
      'def4560000000000000000000000000',
      'abc1230000000000000000000000000',
    ]);
    expect(a).toBe(b);
  });

  it('builds a dialect-appropriate checksum expression', () => {
    expect(checksumExpr('h', 'postgres')).toContain('::bit(32)::bigint');
    expect(checksumExpr('h', 'mysql')).toContain('conv(');
    expect(checksumExpr('h', 'duckdb')).toContain("'0x'");
    expect(checksumExpr('h', 'sqlite')).toContain('hex2int(');
  });

  it('uses 32-bit slices so the sum stays exact in every engine', () => {
    // A 60-bit slice summed over enough rows overflows the 64-bit integer
    // range, and SQLite's sum() would silently switch to a float.
    expect(HASH_DIGITS).toBe(8);
    expect(HASH_BITS).toBe(32);
  });
});
