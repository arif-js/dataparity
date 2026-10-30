import type { DiffOptions } from '../core/diff.js';
import type { DiffReport } from '../core/types.js';

/** Renders a diff report as human-readable text. */
export function formatReport(report: DiffReport): string {
  const lines: string[] = [];

  const verdict = report.risk.level.toUpperCase();
  lines.push(`${verdict}  ${report.risk.reason}`);
  lines.push('');

  lines.push(
    `left   ${report.left.source} :: ${report.left.table}  (${report.left.rowCount} rows)`,
  );
  lines.push(
    `right  ${report.right.source} :: ${report.right.table}  (${report.right.rowCount} rows)`,
  );
  lines.push(`strategy  ${report.strategy}   keys  ${report.keyColumns.join(', ')}`);
  lines.push('');

  const { added, removed, modified, unchanged } = report.summary;
  lines.push(`added ${added}   removed ${removed}   modified ${modified}   unchanged ${unchanged}`);
  lines.push('');

  if (report.schemaDifferences.length > 0) {
    lines.push('schema differences:');
    for (const d of report.schemaDifferences) {
      if (d.kind === 'removed') {
        const side = d.leftType ? 'left only' : 'right only';
        lines.push(`  ${d.column}: ${side} (${d.leftType ?? d.rightType})`);
      } else if (d.kind === 'type_changed') {
        lines.push(`  ${d.column}: type changed ${d.leftType} -> ${d.rightType}`);
      } else {
        lines.push(
          `  ${d.column}: nullability changed ${d.leftNullable ? 'nullable' : 'not null'} -> ${d.rightNullable ? 'nullable' : 'not null'}`,
        );
      }
    }
    lines.push('');
  }

  if (report.attributions.length > 0) {
    lines.push('where the changes are concentrated:');
    for (const a of report.attributions) {
      lines.push(
        `  ${a.column} = ${a.value}  ${a.count} change(s)  ${(a.share * 100).toFixed(1)}% of changes  ${a.overRepresentation.toFixed(1)}x over-represented`,
      );
    }
    lines.push('');
  }

  if (report.changes.length > 0) {
    lines.push('sample changes:');
    for (const change of report.changes) {
      const label = change.kind.padEnd(8);
      if (change.kind === 'modified' && change.columns && change.columns.length > 0) {
        const detail = change.columns
          .map((c) =>
            // Cross-database localisation knows which column changed but not its
            // values (no row data crosses the wire), so only the name is shown.
            c.before === undefined && c.after === undefined
              ? c.column
              : `${c.column}: ${formatValue(c.before ?? null)} -> ${formatValue(c.after ?? null)}`,
          )
          .join(', ');
        lines.push(`  ${label} key=${change.key}  ${detail}`);
      } else {
        lines.push(`  ${label} key=${change.key}`);
      }
    }
    if (report.changesTruncated) {
      lines.push(`  ... more changes were found than are shown here`);
    }
    lines.push('');
  }

  if (report.risk.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.risk.signals) {
      lines.push(`  - ${signal}`);
    }
    lines.push('');
  }

  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }

  return lines.join('\n').trimEnd();
}

/** Formats a value for display, distinguishing NULL from the empty string. */
function formatValue(value: string | null): string {
  if (value === null) return 'NULL';
  if (value === '') return "''";
  return value;
}

/** Formats a diff report as JSON. */
export function formatJson(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}

export type { DiffOptions, DiffReport };
