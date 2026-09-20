---
name: db-schema-craft
description: Relational data modeling and schema evolution, engine-agnostic with per-engine notes (PostgreSQL, SQL Server, Oracle, MySQL) - turning a domain into tables, choosing keys (surrogate versus natural, bigint versus UUIDv7), picking exact column types instead of string-for-everything, modeling one-to-many and many-to-many with payload join tables, normalizing to 3NF and denormalizing only with a stated reason, enforcing truth with constraints rather than application code, handling money, time zones, enums, soft deletes and audit history, designing indexes at the same time as the table, partitioning when it is actually warranted, and zero-downtime migrations via expand/contract. Use when designing or reviewing a database schema, adding tables or columns, modeling relationships, deciding key or column types, or planning a risky migration on a live system. Türkçe tetikleyiciler - "veritabanı tasarla", "tablo yapısı kur", "şema tasarımı", "ilişkileri modelle", "many to many nasıl", "primary key seçimi", "uuid mi int mi", "migration nasıl yapılmalı", "kolon tipi ne olmalı", "veritabanını normalize et".
---

# DB Schema Craft

A schema is the longest-lived artifact in the system. Application code gets rewritten; the data outlives three frameworks. Design it so the database itself refuses to hold a wrong row — every rule you leave to application code is a rule that will be violated by a script, a second service, or a future you.

Always communicate with the user in their own language.

## Phase 1 — Understand before drawing tables

Establish, in the user's language, before any DDL:

- **The entities and the language around them.** Use the business's words for tables and columns. A table named `data1` costs the team forever.
- **The cardinalities and their reality**: is one order really one customer, or can it be transferred? Is an email unique per user or per tenant? Ask about the exceptional case — that is what breaks a model.
- **Access patterns**: which queries run per page load, which run nightly, which filter by what. A schema designed without knowing the reads is a guess.
- **Volume and growth**: thousands or hundreds of millions of rows changes key type, index strategy and partitioning.
- **Multi-tenancy**: shared table with a `tenant_id`, schema per tenant, or database per tenant — decide now, because retrofitting is a rewrite.
- **Retention and compliance**: what must be deletable, what must be immutable, what must be auditable.

If the schema already exists, read it first — tables, foreign keys, indexes, and a sample of real rows. The existing conventions (naming, key style, timestamp columns) are the contract you follow; a table styled differently from every other one is a defect even if it is "better".

## Phase 2 — Entities, keys and types

**Keys**

| Choice | When |
|---|---|
| `bigint` identity/sequence | Default. Small, sequential, index-friendly, join-cheap |
| **UUIDv7** | IDs generated client-side or across services, or IDs exposed publicly. Time-ordered, so unlike UUIDv4 it does not shred index locality |
| UUIDv4 | Only when unpredictability matters more than write performance — and then not as the clustered key |
| Natural key as PK | Only for genuinely immutable, universally agreed codes (ISO country code). Anything a human can edit is not a key |
| Composite PK | Correct for pure join tables; annoying everywhere else because every child FK inherits all its columns |

A surrogate primary key does not excuse you from a **unique constraint on the natural key**. Without it, the same customer gets inserted twice with different ids and every report is wrong.

**Types — be exact, not convenient**

| Data | Use | Never |
|---|---|---|
| Money | `numeric(19,4)` / `decimal` plus an explicit currency column | `float`/`double` — rounding errors in money are unrecoverable |
| Timestamps | `timestamptz` (PostgreSQL) / `datetimeoffset` (SQL Server), stored in UTC | Naive local-time columns; a timestamp without a zone is a bug with a delay |
| Dates with no time | `date` | A timestamp at midnight in an unknown zone |
| Enumerated states | A lookup table with an FK, or a native enum plus a `CHECK` | A free-text `varchar` holding `"Active"`, `"active"`, `"ACTIVE"` |
| Text | `text`/`varchar(n)` with a length that reflects a real rule | `varchar(255)` chosen by reflex |
| Flags | `boolean` / `bit` | `char(1)` holding `'Y'`/`'N'`/`'y'`/`null` |
| Structured extras | `jsonb` for genuinely variable attributes | JSON as a way to avoid designing columns you query and filter on |
| Files | A URL or object key | The blob itself in a hot transactional table |

Every table gets `created_at` and `updated_at`. Nullability is a decision, not a default: `NOT NULL` unless "unknown" is a meaningful state, and never a magic sentinel like `''`, `0` or `1900-01-01`.

## Phase 3 — Relationships

- **One-to-many**: the foreign key lives on the many side. Always declare it as a real `FOREIGN KEY` — "we enforce it in the application" is how orphan rows appear.
- **Many-to-many**: a join table named for the relationship (`order_items`, not `order_product`), with its own surrogate key when it carries payload (quantity, price, added_at) and a unique constraint on the pair. A join table with attributes is an entity; treat it like one.
- **One-to-one**: usually a sign the two tables should be one. Legitimate when a rarely-used, wide, or differently-secured block of columns is split off — then the child's PK *is* the parent's PK.
- **Inheritance / polymorphic types**: prefer a shared table with a discriminator plus nullable specifics when the variants are similar; separate tables when they diverge. Avoid the "polymorphic FK" pattern (`owner_type` + `owner_id`) — the database cannot enforce it; use separate nullable FKs with a `CHECK` that exactly one is set.
- **Self-referencing hierarchies**: `parent_id` is fine for shallow trees; for deep trees plan the read strategy up front (recursive CTE, materialized path, or closure table) rather than discovering it under load.
- **`ON DELETE` is a domain decision**: `CASCADE` only where the child is genuinely part of the parent (order lines), `RESTRICT` for anything referenced elsewhere, `SET NULL` only when null is a legal state.

## Phase 4 — Let the database enforce the truth

Every invariant you can express in DDL, express in DDL:

- `NOT NULL` on everything that is required.
- `UNIQUE` on every natural key and on every "can only exist once" rule — including partial/filtered uniques (`WHERE deleted_at IS NULL`) for soft-deleted rows.
- `CHECK` for ranges, state values, and cross-column rules (`ends_at > starts_at`, `discount BETWEEN 0 AND 100`).
- `FOREIGN KEY` on every reference, with an index on the referencing column.
- `DEFAULT` for values the database can supply itself.

**Normalize to 3NF first.** Every fact in one place; a value you can derive is not stored. Then denormalize deliberately, and only with a written reason: a counter or a cached total is acceptable when the read cost is proven and you say how it stays correct (trigger, transactional update, or scheduled reconciliation). Denormalization without a correctness plan is just a future data bug.

**Soft delete** (`deleted_at timestamptz NULL`) is a real decision with a real cost: every query must filter it, unique constraints must become partial, and foreign keys keep pointing at "deleted" rows. Use it when history matters; otherwise delete, and archive elsewhere.

**Audit history**: an append-only `*_history` table (or system-versioned/temporal tables where the engine supports them) beats trying to reconstruct the past from logs. Decide at design time — retrofitting history over existing data is guesswork.

## Phase 5 — Indexes belong to the design

Design indexes with the table, not after the first outage:

- The primary key is indexed automatically; **foreign key columns are not** in most engines and are the single most common missing index.
- Index the columns your known access patterns filter, join and sort on. Composite index column order follows equality → range → sort.
- A unique constraint is also an index; do not duplicate it.
- Every index costs write throughput and storage. An unused index is pure loss — plan to check usage after release.
- Beyond this, sizing, plan reading and fixing a slow query belong to **query-tuning**; this phase is only about not shipping a table with no way to read it.

**Partitioning** is warranted when a table is genuinely large (hundreds of millions of rows) *and* has a natural range key (usually time) *and* you drop or archive whole ranges. Partitioning a five-million-row table adds complexity and buys nothing. Choose the partition key from the query patterns, never from convenience.

## Phase 6 — Migrations that do not take the system down

- **Migrations are versioned, reviewed, forward-only files in the repo** (Flyway, Liquibase, EF Core, Prisma, Alembic, Knex — whatever the project uses). Never change a schema by hand in a shared environment, and never edit a migration that has already run.
- **Read the generated SQL before applying it.** ORM migration generators produce destructive drops with complete confidence.
- **Expand / contract for anything a running version still reads**:
  1. **Expand** — add the new nullable column, table or index; deploy.
  2. **Backfill** in batches, with the application writing to both old and new.
  3. **Switch** reads to the new shape; deploy and observe.
  4. **Contract** — make it `NOT NULL`, drop the old column, in a later release once nothing references it.
- Rename is never in-place under load: it is add, dual-write, backfill, switch, drop.
- **Long locks are the real danger.** Adding an index concurrently, adding a column with a volatile default, or validating a constraint can lock a hot table. Know your engine's behavior, set a `lock_timeout`, and run heavy DDL in a maintenance window if it is not online-safe.
- **Backfill in bounded batches** with commits between them. One `UPDATE` over fifty million rows is a transaction log incident.
- Every migration has a stated rollback plan — a down script, or an explicit "forward-fix only, here is how".
- Test the migration against a restored copy of production-shaped data, not an empty schema.

## Engine notes

| Engine | Worth knowing |
|---|---|
| **PostgreSQL** | `timestamptz`, `jsonb`, partial and expression indexes, `GENERATED ALWAYS AS IDENTITY` over `serial`, `CREATE INDEX CONCURRENTLY`, `ADD CONSTRAINT ... NOT VALID` then `VALIDATE` to avoid long locks |
| **SQL Server** | The clustered index *is* the row order — pick it narrow, static and increasing; `datetimeoffset` over `datetime`; filtered indexes; `ONLINE = ON` rebuilds on supported editions; temporal tables for history |
| **Oracle** | Sequences plus identity columns, `VARCHAR2`, no native boolean before 23ai (use `NUMBER(1)` + `CHECK`), invisible indexes for safe testing, partitioning is mature and license-gated |
| **MySQL / MariaDB** | InnoDB clusters on the PK, so a random UUID PK hurts badly — use UUIDv7 or bigint; `utf8mb4` always; DDL online-ness varies sharply by version and operation |

## Rules

1. Understand the domain, the access patterns and the volume before writing DDL.
2. Follow the existing schema's conventions; a differently-styled table is a defect.
3. Names come from the business vocabulary, and one naming convention applies to the whole schema.
4. Every invariant expressible as a constraint is a constraint — `NOT NULL`, `UNIQUE`, `CHECK`, `FOREIGN KEY`.
5. Exact types: decimal for money, timezone-aware timestamps in UTC, no `varchar(255)` by reflex, no floats for anything counted or paid.
6. Normalize to 3NF; denormalize only with a stated reason and a stated correctness mechanism.
7. Every foreign key column gets an index; every table ships with the indexes its known reads require.
8. Soft delete, history and multi-tenancy are decided at design time, not retrofitted.
9. Migrations are reviewed files, read before applying, batched on backfill, and expand/contract for anything live.
10. No destructive change without a rollback plan and a test against production-shaped data.

