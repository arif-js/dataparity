import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TableFingerprint } from '../core/diff.js';
import type { DiffReport } from '../core/types.js';

/** A saved run's searchable metadata. */
export interface DiffRunSummary {
  id: string;
  createdAt: string;
  leftSource: string;
  leftTable: string;
  rightSource: string;
  rightTable: string;
  identical: boolean;
  summary: DiffReport['summary'];
}

/** A saved run and its complete report. */
export interface SavedDiffRun extends DiffRunSummary {
  report: DiffReport;
}

/** A saved baseline and its fingerprint. */
export interface SavedBaseline {
  name: string;
  createdAt: string;
  source: string;
  table: string;
  fingerprint: TableFingerprint;
}

/** Persistent local history for diff reports and table baselines. */
export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(path = defaultHistoryPath()) {
    if (path === ':memory:') {
      this.db = new DatabaseSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
    }

    this.db.exec(`
      create table if not exists diff_runs (
        id text primary key,
        created_at text not null,
        left_source text not null,
        left_table text not null,
        right_source text not null,
        right_table text not null,
        identical integer not null,
        summary_json text not null,
        report_json text not null
      );
      create index if not exists diff_runs_created_at on diff_runs(created_at desc);
      create table if not exists baselines (
        name text primary key,
        created_at text not null,
        source text not null,
        table_name text not null,
        fingerprint_json text not null
      );
      create index if not exists baselines_source on baselines(source);
    `);
  }

  saveDiffRun(report: DiffReport): DiffRunSummary {
    const saved: SavedDiffRun = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      leftSource: report.left.source,
      leftTable: report.left.table,
      rightSource: report.right.source,
      rightTable: report.right.table,
      identical: report.identical,
      summary: report.summary,
      report,
    };
    this.db
      .prepare(
        `insert into diff_runs
          (id, created_at, left_source, left_table, right_source, right_table,
           identical, summary_json, report_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        saved.id,
        saved.createdAt,
        saved.leftSource,
        saved.leftTable,
        saved.rightSource,
        saved.rightTable,
        saved.identical ? 1 : 0,
        JSON.stringify(saved.summary),
        JSON.stringify(report),
      );
    return this.toSummary(saved);
  }

  listDiffRuns(limit = 20): DiffRunSummary[] {
    const rows = this.db
      .prepare(
        `select id, created_at, left_source, left_table, right_source, right_table,
                identical, summary_json
           from diff_runs
          order by created_at desc, id desc
          limit ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
      leftSource: String(row.left_source),
      leftTable: String(row.left_table),
      rightSource: String(row.right_source),
      rightTable: String(row.right_table),
      identical: Number(row.identical) === 1,
      summary: JSON.parse(String(row.summary_json)) as DiffReport['summary'],
    }));
  }

  getDiffRun(id: string): SavedDiffRun | undefined {
    const row = this.db
      .prepare(
        `select id, created_at, left_source, left_table, right_source, right_table,
                identical, summary_json, report_json
           from diff_runs where id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      leftSource: String(row.left_source),
      leftTable: String(row.left_table),
      rightSource: String(row.right_source),
      rightTable: String(row.right_table),
      identical: Number(row.identical) === 1,
      summary: JSON.parse(String(row.summary_json)) as DiffReport['summary'],
      report: JSON.parse(String(row.report_json)) as DiffReport,
    };
  }

  deleteDiffRun(id: string): boolean {
    return this.db.prepare('delete from diff_runs where id = ?').run(id).changes > 0;
  }

  saveBaseline(name: string, source: string, fingerprint: TableFingerprint): SavedBaseline {
    const baseline: SavedBaseline = {
      name,
      createdAt: new Date().toISOString(),
      source,
      table: fingerprint.table,
      fingerprint,
    };
    this.db
      .prepare(
        `insert into baselines (name, created_at, source, table_name, fingerprint_json)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        baseline.name,
        baseline.createdAt,
        baseline.source,
        baseline.table,
        JSON.stringify(baseline.fingerprint),
      );
    return baseline;
  }

  listBaselines(source?: string): Array<Omit<SavedBaseline, 'fingerprint'>> {
    const rows = source
      ? (this.db
          .prepare(
            `select name, created_at, source, table_name
               from baselines where source = ? order by created_at desc, name`,
          )
          .all(source) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `select name, created_at, source, table_name
               from baselines order by created_at desc, name`,
          )
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      name: String(row.name),
      createdAt: String(row.created_at),
      source: String(row.source),
      table: String(row.table_name),
    }));
  }

  getBaseline(name: string): SavedBaseline | undefined {
    const row = this.db
      .prepare(
        `select name, created_at, source, table_name, fingerprint_json
           from baselines where name = ?`,
      )
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      name: String(row.name),
      createdAt: String(row.created_at),
      source: String(row.source),
      table: String(row.table_name),
      fingerprint: JSON.parse(String(row.fingerprint_json)) as TableFingerprint,
    };
  }

  deleteBaseline(name: string): boolean {
    return this.db.prepare('delete from baselines where name = ?').run(name).changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private toSummary(saved: SavedDiffRun): DiffRunSummary {
    const { report: _report, ...summary } = saved;
    return summary;
  }
}

/** Where persistent run history is stored by default. */
export function defaultHistoryPath(): string {
  return process.env.DATAPARITY_HISTORY_PATH ?? join(homedir(), '.dataparity', 'history.sqlite');
}
