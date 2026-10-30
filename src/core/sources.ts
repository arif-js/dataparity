import { type Config, findSource, loadConfig } from '../config/config.js';
import { DuckdbSource } from '../engines/duckdb.js';
import type { Source } from '../engines/source.js';
import { MysqlSource, PostgresSource, SqliteSource } from '../engines/sql.js';

/** Builds a source from a config entry. */
export async function openSource(entry: Config['sources'][number]): Promise<Source> {
  switch (entry.type) {
    case 'postgres': {
      const connectionString =
        entry.connectionString ??
        `postgres://${encodeURIComponent(entry.user ?? '')}:${encodeURIComponent(entry.password ?? '')}@${entry.host ?? 'localhost'}:${entry.port ?? 5432}/${entry.database ?? ''}`;
      return PostgresSource.connect({ connectionString, id: entry.name, label: entry.name });
    }
    case 'mysql': {
      if (entry.connectionString) {
        const parsed = new URL(entry.connectionString);
        return MysqlSource.connect({
          host: parsed.hostname || 'localhost',
          port: parsed.port ? Number(parsed.port) : 3306,
          user: decodeURIComponent(parsed.username || 'root'),
          password: decodeURIComponent(parsed.password || ''),
          database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
          id: entry.name,
          label: entry.name,
        });
      }
      return MysqlSource.connect({
        host: entry.host ?? 'localhost',
        port: entry.port ?? 3306,
        user: entry.user ?? 'root',
        password: entry.password ?? '',
        database: entry.database ?? '',
        id: entry.name,
        label: entry.name,
      });
    }
    case 'sqlite': {
      if (!entry.path) throw new Error(`Source "${entry.name}": sqlite sources need a path.`);
      return SqliteSource.open({ path: entry.path, id: entry.name, label: entry.name });
    }
    case 'duckdb': {
      return DuckdbSource.open({
        path: entry.path,
        id: entry.name,
        label: entry.name,
        files: entry.files,
      });
    }
    default: {
      const exhaustive: never = entry.type;
      throw new Error(`Unsupported source type: ${String(exhaustive)}`);
    }
  }
}

/** Opens a named source from the configuration. */
export async function openNamedSource(name: string, configPath?: string): Promise<Source> {
  const config = loadConfig(configPath);
  return openSource(findSource(config, name));
}
