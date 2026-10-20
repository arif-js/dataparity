import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** A configured source. */
export const sourceSchema = z
  .object({
    /** A short name used to refer to this source on the command line. */
    name: z.string().min(1),
    /** The engine type. */
    type: z.enum(['postgres', 'mysql', 'sqlite', 'duckdb']),
    /** For postgres and mysql: a connection string or the fields below. */
    connectionString: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    /** For sqlite and duckdb: the database file path. */
    path: z.string().optional(),
    /** For duckdb: files to expose as tables. */
    files: z.array(z.string()).optional(),
  })
  .refine(
    (s) => s.connectionString || s.path || s.files?.length || (s.host && s.user && s.database),
    {
      message:
        'A source needs a connectionString, a path, files (for duckdb), or host/user/database',
    },
  );

/** The configuration file shape. */
export const configSchema = z.object({
  /** Named sources that tools and the CLI can refer to. */
  sources: z.array(sourceSchema).default([]),
  /** Default key columns, used when a diff does not name any. */
  defaultKeyColumns: z.array(z.string()).default([]),
});

/** The parsed configuration. */
export type Config = z.infer<typeof configSchema>;

/** Where the config file lives by default. */
export function defaultConfigPath(): string {
  return join(homedir(), '.dataparity', 'config.json');
}

/**
 * Loads the configuration.
 *
 * A missing config file is not an error: the tool is usable with explicit
 * connection details alone. Environment variables of the form
 * `DATAPARITY_<SOURCE>_<FIELD>` override the file, so credentials never have to
 * be written to disk.
 */
export function loadConfig(path?: string): Config {
  const configPath = path ?? process.env.DATAPARITY_CONFIG ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    return configSchema.parse({ sources: [] });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse config at ${configPath}: ${(err as Error).message}`);
  }
  const config = configSchema.parse(raw);

  // Environment overrides.
  for (const source of config.sources) {
    const prefix = `DATAPARITY_${source.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const conn = process.env[`${prefix}_CONNECTION_STRING`];
    if (conn) source.connectionString = conn;
    const password = process.env[`${prefix}_PASSWORD`];
    if (password) source.password = password;
  }
  return config;
}

/** Finds a configured source by name. */
export function findSource(config: Config, name: string): z.infer<typeof sourceSchema> {
  const found = config.sources.find((s) => s.name === name);
  if (!found) {
    const available = config.sources.map((s) => s.name).join(', ') || 'none';
    throw new Error(`Unknown source "${name}". Configured sources: ${available}`);
  }
  return found;
}
