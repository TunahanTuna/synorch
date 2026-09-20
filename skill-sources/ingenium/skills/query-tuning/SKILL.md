---
name: query-tuning
description: Diagnosing and fixing slow database access, engine-agnostic with per-engine commands (PostgreSQL, SQL Server, Oracle, MySQL) - measure first and find the actual offending query, read an execution plan and recognize the handful of shapes that matter (seq scan on a filtered table, nested loop over a large set, sort spilling to disk, wrong row estimates), index design that a query can actually use (leftmost prefix, covering indexes, why a function or an implicit cast kills an index), rewriting queries that cannot be indexed out of trouble, keyset instead of OFFSET pagination, and the ORM traps that cause most of it - JPA/Hibernate N+1 and lazy loading, EF Core tracking and cartesian explosion, Prisma/TypeORM includes - plus transaction scope, lock contention, deadlocks and connection pool sizing. Use when a query, endpoint, page or report is slow, when the database CPU is high, when an ORM emits too many queries, or when tuning indexes and transactions. Türkçe tetikleyiciler - "sorgu yavaş", "sayfa geç açılıyor", "n+1 problemi", "index eksik mi", "execution plan oku", "veritabanı cpu yüksek", "deadlock alıyoruz", "sorguyu optimize et", "orm çok sorgu atıyor", "pagination yavaşladı".
---

# Query Tuning

Slow database access is almost never mysterious. It is one of a short list: a query with no usable index, an ORM firing a query per row, a transaction held open too long, or a page fetching far more data than it shows. Find which one — with a measurement, not a hunch — then fix that one.

Always communicate with the user in their own language.

## Phase 1 — Measure, and find the real offender

Do not optimize anything until you can name the query and its cost. Guessing produces indexes nobody uses and rewrites that change nothing.

| Engine | Find the worst queries |
|---|---|
| **PostgreSQL** | `pg_stat_statements` ordered by `total_exec_time`, then `mean_exec_time`; `auto_explain` for slow-query plans; `pg_stat_user_tables` for seq-scan counts |
| **SQL Server** | Query Store (regressed and top-resource-consuming queries); `sys.dm_exec_query_stats`; `sys.dm_db_missing_index_details` as a hint, never as an order |
| **Oracle** | AWR / ASH reports, `V$SQL` by elapsed time, SQL Monitor for a live long-runner |
| **MySQL** | `performance_schema.events_statements_summary_by_digest`, the slow query log with `long_query_time` lowered |

From the application side: count the queries per request (Hibernate statistics, EF Core logging, Prisma `$on('query')`, an APM trace). **A slow endpoint that issues 340 fast queries is not a slow-query problem** — it is an N+1, and no index will save it.

Write down the baseline number before changing anything. "It feels faster" is not a result.

## Phase 2 — Read the plan

Get a real plan with real timings, not an estimate:

- PostgreSQL: `EXPLAIN (ANALYZE, BUFFERS)` — and compare estimated versus actual rows.
- SQL Server: the actual execution plan, plus `SET STATISTICS IO, TIME ON` for logical reads.
- Oracle: `DBMS_XPLAN.DISPLAY_CURSOR` with `ALLSTATS LAST`.
- MySQL: `EXPLAIN ANALYZE`.

Read it outside-in and look for these shapes:

| What you see | What it means | Usual fix |
|---|---|---|
| Sequential/table scan on a large table with a selective filter | No usable index, or the index cannot be used | Add or fix the index; check Phase 3's index killers |
| Estimated rows wildly different from actual | Stale statistics or a bad predicate shape | Refresh statistics; simplify or rewrite the predicate |
| Nested loop driving thousands of iterations | Optimizer expected a small set and got a big one | Fix the estimate; a hash join is usually right for large sets |
| Sort or hash spilling to disk | Work memory too small, or you are sorting far more rows than you need | Index that provides the order; filter earlier; raise work memory |
| A filter applied *after* an expensive join | Predicate not pushed down | Move the condition, or restructure the query |
| High logical reads with few returned rows | Reading a lot to answer a little | Covering index, or better filtering |
| Lookup/bookmark per row after an index seek | The index found rows but not the columns | Include the needed columns in the index |

The number to trust is actual time and rows, not cost. Cost is the optimizer's opinion.

## Phase 3 — Indexes the query can actually use

- **Leftmost prefix rule**: an index on `(tenant_id, status, created_at)` serves filters on `tenant_id`, on `tenant_id + status`, and on all three. It does nothing for a query filtering only on `status`.
- **Column order**: equality predicates first, then the range predicate, then the sort column. Only one range column can be used effectively.
- **Covering indexes**: adding the selected columns (`INCLUDE` in PostgreSQL/SQL Server) lets the query answer from the index alone — the single biggest win for a hot read.
- **Selectivity matters.** An index on a boolean or a two-value status is usually ignored; a *partial/filtered* index (`WHERE status = 'pending'`) on the small hot subset is excellent.

**Index killers — the query will not use your index if:**

- The column is wrapped in a function: `WHERE LOWER(email) = ?` (fix: an expression index, or store normalized).
- There is a date function on the column: `WHERE YEAR(created_at) = 2026` (fix: a range — `>= '2026-01-01' AND < '2027-01-01'`).
- There is an implicit type cast: a `varchar` column compared to a number, or a `bigint` column compared to a string. This one is invisible in the SQL and obvious in the plan.
- The pattern is leading-wildcard: `LIKE '%term'` (fix: full-text search or a trigram index).
- Collation or character set differs between the column and the compared value or the joined column.
- `OR` across different columns — often better as a `UNION ALL` of two indexable branches.
- The predicate is `column != x` or `NOT IN` over a low-selectivity column.

**Before adding an index, check whether one already covers it.** Duplicate and near-duplicate indexes slow down every write. After a release, verify usage (`pg_stat_user_indexes`, `sys.dm_db_index_usage_stats`) and drop what nothing touches. Missing-index recommendations from the engine are input, not decisions — they routinely suggest a wide index per query.

## Phase 4 — Rewrite what indexes cannot fix

- **Select the columns you need.** `SELECT *` blocks covering indexes, moves useless bytes, and breaks when the schema changes.
- **`EXISTS` over `IN (subquery)`** for existence checks; `EXISTS` stops at the first match.
- **Filter and aggregate before joining**, not after. Joining two large tables and then filtering makes the database do work you throw away.
- **`OFFSET` pagination degrades linearly** — page 5,000 reads 100,000 rows to discard them. Use **keyset (seek) pagination**: `WHERE (created_at, id) < (:lastCreatedAt, :lastId) ORDER BY created_at DESC, id DESC LIMIT 20`. It is flat at any depth, and the ordering columns must be indexed together.
- **Do not `COUNT(*)` a huge table for every page.** Show "load more", cap the count, or use an approximate count.
- **Batch instead of looping.** One `WHERE id = ANY(...)`, one multi-row insert, one `MERGE`/upsert — a per-row round trip pays the network latency every time.
- **Push set work into SQL.** Filtering, grouping and joining a hundred thousand rows in application memory is slower and heavier than letting the database do what it was built for.
- **Window functions** replace self-joins and per-row subqueries for ranking, running totals and "latest per group".
- **A materialized view or a maintained summary table** is the right answer for an expensive report read far more often than the data changes — with a stated refresh strategy.

## Phase 5 — The ORM layer (where most of it comes from)

**Universal**: log the generated SQL in development and count the statements per request. Almost every ORM performance bug is visible the first time you actually look at the output.

**JPA / Hibernate**

- N+1 comes from lazy associations touched in a loop. Fix with `JOIN FETCH`, an `@EntityGraph`, or a projection query — not by switching to `EAGER`, which makes every query fetch everything forever.
- Default to `LAZY` on `@ManyToOne` and `@OneToOne`; the JPA default for `@ManyToOne` is `EAGER` and it is wrong for almost every case.
- `JOIN FETCH` more than one collection at once produces a cartesian product — fetch one collection, or use multiple queries / `@BatchSize`.
- Pagination plus `JOIN FETCH` on a collection makes Hibernate fetch everything and paginate in memory (it warns, and people ignore the warning). Paginate ids first, then fetch.
- Prefer DTO projections (`select new`, interface projections) for read endpoints — no entities, no dirty checking, no lazy surprises.
- Turn off `open-in-view`. It hides lazy-loading problems until they reach production.
- Batch writes with `hibernate.jdbc.batch_size` plus ordered inserts, and use `@Version` for optimistic locking rather than long transactions.

**EF Core**

- `AsNoTracking()` on every read-only query. Tracking on a 500-row list is pure overhead.
- Project with `Select` into a DTO instead of loading entities and mapping in memory.
- Multiple `Include`s of collections cause cartesian explosion — `AsSplitQuery()`.
- Client-side evaluation: a `Where` the provider cannot translate can pull the table into memory. Modern EF throws instead, which is a gift — do not silence it with `AsEnumerable()` before the filter.
- Never `await` a query inside a `foreach` over entities — batch it.
- `ExecuteUpdateAsync`/`ExecuteDeleteAsync` for bulk changes rather than loading entities to modify them.

**Prisma / TypeORM / Drizzle**

- Prisma: `include` versus `select` matters — `select` only what the response needs; nested `include` on lists multiplies rows. Use `findMany` with `in` instead of a query per item, and `$transaction` for batches.
- TypeORM: `relations` on a paginated query is a classic cartesian bug; use `QueryBuilder` with explicit joins and `take`/`skip` carefully, or paginate ids first. Eager relations are almost always a mistake.
- Any ORM: repository methods that always fetch every relation "to be safe" are how a detail query becomes twelve.

## Phase 6 — Transactions, locks and pools

- **Transactions wrap a unit of work, not a request.** Never hold one open across an HTTP call, a queue publish, or user think-time.
- Read-only transactions marked as such are cheaper; know your isolation level and why it is what it is.
- **Deadlocks** are usually inconsistent lock ordering across code paths — acquire rows in a deterministic order (for example ascending id), keep transactions short, and retry the loser with backoff.
- Long-running writes on hot rows serialize the system. Prefer optimistic locking (`@Version`, `rowversion`) over `SELECT ... FOR UPDATE` unless contention genuinely demands the pessimistic path.
- Watch for lock waits directly: `pg_locks` plus `pg_stat_activity`, `sys.dm_tran_locks`, `V$LOCK`, `SHOW ENGINE INNODB STATUS`.
- **Connection pool size is not "bigger is better".** More connections than the database has capacity for makes everything slower; a small pool with fast queries beats a large pool with slow ones. Set statement and idle-transaction timeouts so one stuck query cannot exhaust the pool. Check for pool exhaustion before blaming the query — the symptom is "everything is slow", not "this endpoint is slow".

## Phase 7 — Verify and report

Re-run the same measurement from Phase 1 and state the before and after: query time, row counts, statements per request. Confirm the plan actually changed shape — an index that exists but is unused fixed nothing. Check that the change did not slow writes elsewhere, and remove any diagnostic logging you enabled.

Report in one short block: what was slow, why, what changed, measured improvement, and anything left on the table.

## Rules

1. Measure and name the offending query before changing anything; record the baseline.
2. Count the queries per request first — an N+1 is not fixed by an index.
3. Read an actual plan with real timings; trust actual rows and time, never cost.
4. Change one thing at a time and re-measure.
5. Check for an existing index before adding one; every index taxes writes.
6. Never wrap an indexed column in a function, and never compare across mismatched types.
7. `SELECT *` does not belong in application queries.
8. Keyset pagination for anything deeper than a few pages.
9. Transactions stay short and never contain a remote call; lock acquisition order is deterministic.
10. Report before/after numbers, and revert any change that did not measurably help.

