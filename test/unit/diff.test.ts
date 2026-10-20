import { describe, expect, it } from 'vitest';
import { classifyType } from '../../src/core/canonical.js';
import { compareSchemas } from '../../src/core/diff.js';
import type { ColumnInfo } from '../../src/engines/source.js';
import { parseArgs } from '../../src/interfaces/cli/index.js';

/** Builds a column for schema comparison tests. */
function col(name: string, dataType: string, nullable = true): ColumnInfo {
  return {
    name,
    dataType,
    kind: classifyType(dataType),
    nullable,
    ordinal: 0,
  };
}

describe('compareSchemas', () => {
  it('reports no differences for identical schemas', () => {
    const columns = [col('id', 'integer', false), col('name', 'text')];
    expect(compareSchemas(columns, columns)).toEqual([]);
  });

  it('reports a column that exists on only one side', () => {
    const differences = compareSchemas(
      [col('id', 'integer'), col('legacy', 'text')],
      [col('id', 'integer')],
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ column: 'legacy', kind: 'removed' });
  });

  it('reports a type change', () => {
    const differences = compareSchemas([col('id', 'integer')], [col('id', 'text')]);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ column: 'id', kind: 'type_changed' });
  });

  it('reports a nullability change', () => {
    const differences = compareSchemas([col('id', 'integer', true)], [col('id', 'integer', false)]);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ column: 'id', kind: 'nullability_changed' });
  });

  it('ignores differences in type spelling across engines', () => {
    // Postgres calls it `integer`, MySQL calls it `int`. They are the same
    // logical type, so a cross-database diff must not report a change.
    const differences = compareSchemas([col('id', 'integer')], [col('id', 'int')]);
    expect(differences).toEqual([]);
  });

  it('ignores differences in type spelling within one engine', () => {
    const differences = compareSchemas([col('id', 'INTEGER')], [col('id', 'integer')]);
    expect(differences).toEqual([]);
  });

  it('reports a genuine type family change', () => {
    const differences = compareSchemas([col('amt', 'double precision')], [col('amt', 'text')]);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ column: 'amt', kind: 'type_changed' });
  });
});

describe('parseArgs', () => {
  it('reads a command, flags and positionals', () => {
    const args = parseArgs(['diff', '--left', 'prod', '--json']);
    expect(args.command).toBe('diff');
    expect(args.flags.get('left')).toBe('prod');
    expect(args.flags.get('json')).toBe(true);
  });

  it('reads --key=value as well as --key value', () => {
    expect(parseArgs(['--key=id,ts']).flags.get('key')).toBe('id,ts');
    expect(parseArgs(['--key', 'id,ts']).flags.get('key')).toBe('id,ts');
  });

  it('does not swallow a following flag as a value', () => {
    const args = parseArgs(['--json', '--left', 'prod']);
    expect(args.flags.get('json')).toBe(true);
    expect(args.flags.get('left')).toBe('prod');
  });
});
