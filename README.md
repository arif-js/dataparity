<div align="center">

<img src="https://raw.githubusercontent.com/arif-js/dataparity/main/assets/logo.svg" alt="Dataparity Logo" width="120" height="120" />

# Dataparity

**Cross-database data diff and reconciliation for AI agents, with a portable row hash.**

Compare two tables — in the same database or in two different ones — and get back what
changed, which columns changed, and which slice of your data the changes concentrate in.
Runs as a CLI, an MCP server, and a library. MIT licensed.

[![npm](https://img.shields.io/npm/v/dataparity)](https://www.npmjs.com/package/dataparity)
[![CI](https://github.com/arif-js/dataparity/actions/workflows/ci.yml/badge.svg)](https://github.com/arif-js/dataparity/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](https://modelcontextprotocol.io)
[![Glama](https://glama.ai/mcp/servers/arif-js/dataparity/badges/score.svg)](https://glama.ai/mcp/servers/arif-js/dataparity)
[![Node](https://img.shields.io/badge/node-%3E%3D22.16.0-brightgreen)](https://nodejs.org)

[What it does](#what-it-does) · [Why the hash is portable](#why-the-hash-is-portable) · [Install](#install) · [CLI](#cli) · [MCP](#mcp) · [Library](#library) · [How it works](#how-it-works) · [Status](#status)

</div>

---

## What it does

Give it two tables and a key, and it tells you what changed:

```
HIGH  3 difference(s) found across 5 row(s) (60.00% of the left side).

left   pg :: public.orders_prod  (5 rows)
right  mysql :: analytics.orders_staging  (5 rows)
strategy  checksum   keys  id

added 1   removed 1   modified 1   unchanged 3

where the changes are concentrated:
  country = DE  4 change(s)  80.0% of changes  6.7x over-represented

sample changes:
  removed  key=2
  modified key=3  amount
  added    key=6

signals:
  - 1 row(s) exist only on the left
  - 1 row(s) exist only on the right
  - 1 row(s) differ in at least one column
```

Three things make it different from a `SELECT EXCEPT` you write yourself:

1. **It works across two different databases.** Postgres ↔ MySQL, Postgres ↔ DuckDB,
   Parquet ↔ Postgres. Both sides compute the same canonical row hash *inside their own
   engine*, so only hashes cross the wire — never row data.

2. **It says where the changes are, not just that there are changes.** A diff that reports
   "432 rows differ" is nearly useless. A diff that reports "98.6% of the modified rows are
   German orders" tells you the VAT rule landed and nothing else did.

3. **It is built for agents.** An MCP server with four read-only tools, a stable JSON result
   contract, and a risk verdict (`none` / `low` / `medium` / `high` / `critical`) that a
   coding agent can act on.

## Why the hash is portable

Comparing rows across engines means agreeing on what a value *is*. `0.1` in Postgres and
`0.1` in MySQL are both the double closest to one tenth, and `0.1 + 0.2` is not `0.3`.
A boolean is `true` in Postgres and `1` in MySQL. A timestamp has microsecond precision in
one engine and second precision in another. A NULL is not an empty string.

Dataparity solves this with two rules, applied identically in every engine:

- **Every value is tagged.** NULL renders as `N`; every other value renders as `V` followed
  by its normalized text. NULL and `''` can never be confused, and a real value can never be
  mistaken for NULL.
- **Every value is length-prefixed** before it is joined into a row hash. A text value
  containing the field separator cannot shift a column boundary and forge a match.

Floats are scaled to a fixed number of decimals *in exact decimal arithmetic* before they
are rendered, so `0.1 + 0.2` and `0.3` agree. Timestamps are normalized to UTC and truncated
to seconds. Booleans render as `true`/`false` everywhere.

The result is an MD5 row hash that is byte-identical across engines. This is not a claim in a
README — it is asserted by `test/integration/canonical.test.ts`, which writes the same
awkward values into Postgres, MySQL and DuckDB and requires the hashes to match:

```bash
docker run -d --name pgdiff -e POSTGRES_PASSWORD=test -e POSTGRES_DB=difftest -p 55432:5432 postgres:16-alpine
docker run -d --name mydiff -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=difftest -p 53306:3306 mysql:8
npm run test:integration
```

Those tests need the databases. When one is unreachable they report themselves as
*skipped* rather than passed, so a green run never means "nothing was tested" — and CI
fails the job if anything was skipped.

## Install

```bash
npm install -g dataparity
```

Or run it without installing:

```bash
npx dataparity --help
```

Requires Node.js 22.16 or newer.

## CLI

Configure your sources once, in `~/.dataparity/config.json` (or point `DATAPARITY_CONFIG` at another path):

```json
{
  "sources": [
    { "name": "prod",    "type": "postgres", "connectionString": "postgres://..." },
    { "name": "staging", "type": "postgres", "connectionString": "postgres://..." },
    { "name": "mysql",   "type": "mysql", "host": "127.0.0.1", "port": 3306,
                         "user": "readonly", "password": "...", "database": "analytics" },
    { "name": "local",   "type": "sqlite", "path": "data/app.db" },
    { "name": "files",   "type": "duckdb", "files": ["data/orders.parquet"] }
  ]
}
```

Then diff:

```bash
# Two tables in the same database
dataparity diff \
  --left prod --right staging \
  --left-table public.orders_prod --right-table public.orders_staging \
  --key id

# Two tables in two different databases
dataparity diff \
  --left prod --right mysql \
  --left-table public.orders_prod --right-table orders_staging \
  --key id --json

# Explore first
dataparity tables --source prod
dataparity describe --source prod --table public.orders_prod
```

Exit codes follow the GNU diff convention: `0` identical, `1` differences found, `2` error.
That makes it drop straight into a CI check.

| Option | Meaning |
| --- | --- |
| `--left`, `--right` | Source names from the config file |
| `--left-table`, `--right-table` | Tables to compare |
| `--key` | Comma-separated key columns used to match rows |
| `--columns` | Columns to compare (default: every shared column) |
| `--where` | A WHERE expression applied to both sides |
| `--max-changes` | Maximum row changes to report (default 100) |
| `--max-attributions` | Maximum attribution segments to report (default 5) |
| `--sample` | Compare only a sample; the result is marked as sampled |
| `--sample-limit` | Maximum rows to sample per side (default 100000) |
| `--bucket-count` | Explicit bucket count for cross-database diffs |
| `--json` | Machine-readable output |

Credentials can come from the environment instead of the file, so they never have to be
written to disk:

```bash
export DATAPARITY_PROD_CONNECTION_STRING='postgres://...'
export DATAPARITY_MYSQL_PASSWORD='...'
```

## MCP

```bash
claude mcp add --scope user dataparity -- npx -y dataparity mcp
```

Or in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dataparity": { "command": "npx", "args": ["-y", "dataparity", "mcp"] }
  }
}
```

Four read-only tools:

| Tool | What it does |
| --- | --- |
| `dataparity_list_sources` | The configured sources and their engine types |
| `dataparity_list_tables` | Tables in a source, with their columns |
| `dataparity_describe_table` | One table's columns, types and nullability |
| `dataparity_diff` | Compare two tables and report what changed |

Tools take source *names*, never connection strings — credentials never pass through the
model. Every tool is read-only; dataparity never writes to your database.

## Library

```ts
import { diffTables, PostgresSource, MysqlSource } from 'dataparity';

const prod = await PostgresSource.connect({ connectionString: process.env.PROD_URL! });
const staging = await MysqlSource.connect({
  host: '127.0.0.1', port: 3306, user: 'ro', password: '...', database: 'analytics',
});

const report = await diffTables(prod, 'public.orders', staging, 'orders_staging', {
  keyColumns: ['id'],
});

if (report.risk.level === 'critical') {
  console.error(report.risk.signals.join('\n'));
  process.exit(1);
}
```

## How it works

**Same database → a single in-database join.** The three-way classification (added, removed,
modified) is one anti-join plus one outer join, entirely inside the database. Row data never
leaves it, and the result is exact.

**Different databases → canonical hashes, compared in buckets.** Each side computes a
per-bucket count and two independent checksums inside its own engine. Only buckets whose
aggregates disagree are expanded down to the row level, so a billion-row table that differs in
a few rows transfers a few hashes, not a billion rows.

**Attribution.** For each candidate column, the distribution of that column among the changed
rows is compared to its distribution across the whole table. A value that is much more common
among the changed rows than expected points at the affected slice. The score is descriptive
("over-represented"), never causal.

**Risk.** The verdict weighs the size of the change against the schema difference. A removed
or retyped column alongside added or removed rows is `critical`; a small percentage of
changed rows with no schema change is `low`.

### Supported engines

| Engine | Same-db | Cross-db | Notes |
| --- | --- | --- | --- |
| PostgreSQL | yes | yes | |
| MySQL | yes | yes | |
| SQLite | yes | yes | Via `node:sqlite`, read-only by default |
| DuckDB | yes | yes | Reads Parquet, CSV and JSON directly |
| Parquet / CSV / JSON | — | yes | Through DuckDB |

A boolean and a 0/1 integer are treated as the same logical type, so a boolean
column in Postgres compares correctly against the integer column SQLite has no
choice but to use.

## Status

Early. The core is solid and tested against live Postgres, MySQL and DuckDB, but the surface
is small and the edges are sharp.

**What works today**

- Same-database diffs with exact column-level detail
- Cross-database diffs between Postgres, MySQL, SQLite and DuckDB
- Schema comparison, change attribution, risk verdicts
- CLI, MCP server and a typed library API
- Read-only by construction; credentials never reach the model
- Cross-database diffs localise *which columns* changed, by comparing a per-column hash
  computed inside each engine — so the column detail survives the hash comparison without any
  value crossing the wire

**Known limits**

- Cross-database diffs report *which columns* changed, but not the before/after *values*: only
  hashes cross the wire, so the value itself never leaves either engine. A same-database diff
  carries the values too.
- JSON columns are compared as text, so key order differences read as changes. Compare them
  structurally instead.
- Floats and decimals are compared to six decimal places. Beyond that, two engines may
  disagree on the last bits.
- The `where` clause is a raw SQL fragment. It is passed to your engine, not to the model,
  but treat it as trusted input.
- No monitors, no lineage graph, no dbt integration, no UI.

## Contributing

`docs/design.md` is the source of truth for the scope and the key decisions behind
them. Read it before changing behaviour — it records the reasoning, not just the
outcome.

The workflow is:

```bash
npm ci
npm test                   # unit tests
npm run test:integration   # needs live Postgres + MySQL; skips if absent
npm run test:audit         # every engine x every option x every error path
npm run lint
npm run typecheck
npm run build
```

The integration suite needs Postgres 16 on `:55432` and MySQL 8 on `:53306`:

```bash
docker run -d --name pgdiff -e POSTGRES_PASSWORD=test -e POSTGRES_DB=difftest -p 55432:5432 postgres:16-alpine
docker run -d --name mydiff -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=difftest -p 53306:3306 mysql:8
```

## License

MIT. See [LICENSE](LICENSE).

