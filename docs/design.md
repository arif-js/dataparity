# Design

This document records the scope and the key decisions behind dataparity. It is the source of
truth for what the project is and is not.

## The problem

A data team needs to know whether two tables agree. The obvious tools each cover part of it:

- A `SELECT EXCEPT` written by hand compares two tables in one database, and nothing else.
- `datafold/data-diff` compared across databases, but was archived in May 2024 and no longer
  receives new database adapters or fixes. `reladiff` is a maintained fork of it; `namidiff`
  is a fork of that.
- `Recce` is a dbt-native pull-request review UI.
- `Google DVT` validates a migration across 17 warehouse types with YAML configs.
- `datacontract-cli` validates against a contract.

None of them answer the question an analyst actually asks, which is not "did anything
change" but "what changed, and what does it mean". A diff that reports "432 rows differ" is
close to useless. A diff that reports "98.6% of the modified rows are German orders" tells
you the VAT rule landed and that nothing else did.

## What dataparity is

A read-only tool that compares two tables and reports:

1. Row-level differences: added, removed, modified.
2. Column-level differences, when both tables are in the same database.
3. Schema differences.
4. Where the changes concentrate: the segments of data that are over-represented among the
   changed rows.
5. A risk verdict.

It works within one database and across two different ones, and it ships as a CLI, an MCP
server and a library.

## Key decisions

### The canonical row hash is computed in SQL, not in JavaScript

The obvious design is to pull both tables into Node and compare them there. That does not
work across databases at scale: a billion-row table does not fit in memory, and pulling it
across the network costs more than the diff is worth.

Instead, each side computes the hash *inside its own engine* using the same SQL expression,
and only the hashes are compared. The hash expression is generated per dialect from
`src/core/canonical.ts`, so there is one source of truth for the rules and several
renderings of them.

**Consequence:** the canonicalization rules are the whole product. They are the part that
must not drift.

### Values are tagged, not null-sentinelled

The first implementation used a control character as a NULL sentinel. It worked, but it
meant the canonical form of a value was `\x01NULL` for NULL and `abc` for the string `abc`,
and comparing a NULL to a value that happened to contain the sentinel was a question rather
than an answer.

The current design tags every value: `N` for NULL, `V` + text for everything else. NULL and
the empty string are now distinct by construction, and a real value can never be mistaken
for NULL. The tag is stripped for display but kept internally, because the attribution
queries match on the tagged form.

### Floats and decimals are scaled in exact decimal arithmetic

`0.1 + 0.2 !== 0.3` in every floating-point engine, and the two engines do not even agree
on the last bits of `1e15`. Comparing the raw text of a float across engines produces
spurious differences.

The current rule rounds to six decimal places, in decimal arithmetic rather than binary
floating point, and renders the result as an exact integer count of millionths. Postgres
does this with `cast(x as numeric)`, because Postgres's `numeric` is exact decimal while its
`double precision` is not.

Rendering as an integer rather than as a decimal string matters: Postgres renders a
decimal as `10.500000` and MySQL as `10.50`, so the string forms disagree even though the
values do not. The integer form has no trailing zeros or scale to disagree about.

**Limit:** six decimal places is a choice, not a proof. Values that differ below that
resolution compare as equal. The alternative — comparing the exact bit pattern — cannot work
across engines, because the engines store different values in the first place.

### The checksum folds 32-bit slices, not 60-bit ones

The checksum sums the leading hex digits of each row hash and reduces modulo 2^61 - 1. The
slice is eight hex digits, not fifteen, and that is deliberate: SQLite's `sum()` returns a
float once the total exceeds the 64-bit integer range, which silently loses precision. A
32-bit value summed stays exact for billions of rows.

The overall checksum is computed by a separate query rather than by summing the per-bucket
checksums. A bucket's checksum is already reduced modulo 2^61 - 1, and summing reduced
values is not the same as reducing the sum.

### The comparison is bucketed, not row-by-row

A cross-database diff first compares per-bucket aggregates: a count and two independent
checksums over 64 buckets derived from a hash of the canonical key. Only buckets whose
aggregates disagree are expanded to the row level.

This is the same divide-and-conquer idea that `data-diff` and `reladiff` used, applied to
hashes rather than to key ranges. It means a table that differs in a handful of rows
transfers a handful of hashes, not the whole table.

**Limit:** the bucketing is by hash, so the buckets are not contiguous ranges of the key.
A diff of a table whose rows are ordered by key will not produce a contiguous "changed
region" the way a range bisection would.

### The same-database path is a join, not a hash comparison

When both tables are in the same database, there is no reason to hash anything. A single
anti-join plus one outer join classifies every row exactly, inside the database, and yields
column-level detail for free.

The two strategies are selected by comparing the sources' `databaseKey`. Two sources with
the same key are the same database.

### Attribution is descriptive, never causal

For each candidate column, the distribution of that column among the changed rows is
compared to its distribution across the whole table. A value that is much more common among
the changed rows than expected is reported with its share and its over-representation
factor.

The report says "over-represented", never "caused". The scoring follows Adtributor's
approach. A column that is 1.3x over-represented is probably noise, so the default
threshold is higher than that.

### Types are compared by family, not by spelling

`integer` in Postgres and `int` in MySQL are the same logical type. Comparing the raw type
strings would report a schema change on every cross-engine diff. The comparison uses the
canonicalization family instead, and the raw names are still reported so a reader can see
them.

A boolean and a 0/1 integer are also the same logical type. SQLite has no boolean type, so
a boolean there is an integer, and MySQL reports booleans as `tinyint(1)`. Treating that
pair as a type change would make every cross-engine diff of a table with a boolean column
look broken.

### The result contract is public and versioned

`src/core/types.ts` is the shape every interface returns. It is the thing a user writes
against, so changes to it are treated as an API change.

## Out of scope

These are deliberate, not missing features:

- **Writing to a user's database.** The tool is read-only, everywhere, forever.
- **Column-level detail across databases.** The hash comparison does not carry column
  detail. The report says so explicitly rather than pretending.
- **Monitors, alerting and scheduling.** That is a platform, not a library.
- **A lineage graph.** That is a catalog's job, and Datafold's own Data Knowledge Graph is
  closed and in private beta.
- **A UI.** The CLI and the MCP server are the interfaces.
- **Structural JSON comparison.** JSON columns are compared as text, so key order reads as
  a change. Doing this properly means comparing parsed documents, which is a different
  feature.
- **dbt integration.** A dbt manifest would make key selection easier, but the tool works
  without it and does not need it.

## Limitations

- Cross-database diffs report which rows changed but not which columns.
- Floats are compared to six decimal places.
- The `where` clause is a raw SQL fragment. It goes to the user's engine, never to the
  model, but it is trusted input.
- Sub-second timestamps are truncated to seconds.
- Binary columns are compared as lowercase hex.
- The engine set is Postgres, MySQL, SQLite and DuckDB. Other engines would need a dialect
  in `canonical.ts` and a driver.

## The comparison with the alternatives

| Tool | What it does that dataparity does not | What dataparity does that it does not |
| --- | --- | --- |
| `data-diff` / `reladiff` | Cross-database diffing with checksum bisection over key ranges | Maintenance, an MCP server, attribution, a risk verdict |
| `Recce` | A dbt-native pull-request review UI | Engine independence, a library API |
| `Google DVT` | YAML-configured migration validation across 17 warehouses | Attribution, an agent-facing interface |
| `Soda Core` | A declarative check language and a cloud service | Value-level row comparison, no cloud dependency |
| `Great Expectations` | A large expectation library | Cross-engine row comparison, a small dependency surface |
| `Elementary` | dbt-native observability with a report | Engine independence |
| `Datafold` (commercial) | A full platform: lineage, ontology, migrations as a service | Open source, self-hosted, no vendor |

The honest summary: dataparity is the open-source slice of Datafold's data-quality tooling
that can be built without a vendor, plus the one thing that tooling mostly lacks — a
statement about *where* the changes are.
