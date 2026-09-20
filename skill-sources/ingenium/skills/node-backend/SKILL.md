---
name: node-backend
description: Node.js backend engineering in TypeScript, current as of September 2026 (Node 24 LTS, NestJS 11, Express 5, Fastify 5) - choosing between NestJS and a plain Express/Fastify layout, a layered structure that survives growth (route, service, repository, no logic in the handler), async error handling that actually catches, validation at the boundary with Zod, config loaded and validated once at boot, graceful shutdown and the single-process realities (event loop blocking, unhandled rejections, memory), plus the tooling layer - pnpm workspaces, tsconfig that matches the runtime, ESM versus CJS, native test runner or Vitest, debugging and profiling. Framework recipes and NestJS specifics live in reference.md. Use when building, reviewing or debugging a Node/TypeScript API, choosing a Node backend framework or project structure, fixing async or performance problems in Node, or setting up Node tooling. Türkçe tetikleyiciler - "node backend yaz", "nestjs projesi", "express api", "fastify servisi", "typescript backend yapısı", "node performans sorunu", "async hata yakalanmıyor", "esm cjs sorunu", "pnpm workspace kur", "node projesini debug et".
---

# Node Backend

You build Node services as boring, layered, typed programs: one process, an event loop you refuse to block, errors that cannot escape silently, and a boundary where every untrusted value is parsed before it reaches your code.

Always communicate with the user in their own language.

## Freshness protocol

Current as of **September 2026**: Node 24 LTS (native TypeScript type stripping, stable `node --test`, built-in `fetch`, `node:sqlite`), NestJS 11, Express 5, Fastify 5, TypeScript 5.x, pnpm as the default package manager. Verify against nodejs.org/en/about/releases and the framework changelogs before locking a version decision — if reality moved past this skill, reality wins and say so.

## Existing codebase protocol

Detect before you write: Node version from `.nvmrc`/`engines`, package manager from the lockfile, `"type"` field and `tsconfig` module settings, framework from the dependencies, and the actual layering from two real route files. Match what exists. A Nest-style decorator module dropped into an Express codebase, or a service layer added to only one route, makes the codebase harder to read, not better.

## Framework choice

| Situation | Pick |
|---|---|
| Team backend, many modules, needs enforced structure and DI, likely to outlive its authors | **NestJS** — the opinionation is the product |
| Small-to-mid service, throughput matters, you want to see every line of the pipeline | **Fastify** — schema-first, fast, sane plugin encapsulation |
| Tiny service, glue, or an existing Express codebase | **Express 5** — universal, minimal, now with async error propagation |
| Full-stack app already in Next.js/Nuxt | Its server layer first; add a separate service only when there is a real reason |

Whatever the framework: the framework is delivery, not architecture. Business logic lives in plain functions and classes that can be tested without starting an HTTP server.

## Structure that survives growth

Organize **by feature**, not by technical role:

```
src/
  orders/        orders.routes.ts  orders.service.ts  orders.repository.ts  orders.schema.ts
  billing/       ...
  shared/        config.ts  db.ts  logger.ts  errors.ts
```

- **The handler does four things**: parse input, call one service function, map the result, return. No queries, no branching business rules, no `if (user.role === ...)` policy checks inline.
- **The service owns the use case** and knows nothing about HTTP — no `req`, no `res`, no status codes crossing into it. That single rule is what makes the logic testable and reusable from a job or a CLI.
- **The repository owns data access.** SQL or ORM calls do not appear in services; swapping Prisma for raw SQL should touch one file per feature.
- **Errors are typed domain values** (`NotFoundError`, `ConflictError`, `ValidationError`), mapped to HTTP status codes in exactly one place. Never `throw new Error("something")` and pattern-match on the message.

## Validation and typing at the boundary

- Every external input — body, query, params, headers, environment, third-party responses — is **parsed with Zod at the edge**, and the parsed type flows inward. `req.body as CreateOrderDto` is a lie the compiler cannot catch.
- Derive TypeScript types from the schema (`z.infer`) so there is one source of truth, not a schema and an interface drifting apart.
- `strict: true` in tsconfig, and no `any` at boundaries. `unknown` plus a parse is the honest alternative.
- Validated config once at boot: parse `process.env` through a schema in `config.ts` and export a typed object. Reading `process.env.FOO` deep inside a module is how a service boots fine and dies on a code path nobody exercised.

## Async and errors

- **`async`/`await` everywhere, with every promise awaited or explicitly handled.** A floating promise is a lost error; enable `no-floating-promises` in ESLint.
- Independent work runs with `Promise.all`; `Promise.allSettled` when partial failure is acceptable. Sequential `await`s for independent calls are latency you chose.
- Express 5 forwards rejected promises from async handlers to the error middleware — but only if the handler is `async` and you did not swallow the rejection. Fastify and Nest handle it natively. One error handler at the end of the pipeline, always registered last.
- Register `process.on('unhandledRejection')` and `uncaughtException` to log with context and exit; do not keep a process running in an unknown state.
- **Add `AbortSignal`/timeouts to every outbound call.** `fetch` without a timeout hangs until the socket dies, and that is how one slow dependency saturates your event loop.
- Retry only idempotent operations, with backoff and a cap.

## Single-process realities

- **Never block the event loop.** Synchronous crypto, big `JSON.parse` on megabyte payloads, `readFileSync` in a request path, and heavy loops all stall every concurrent request. Move CPU work to a `worker_threads` pool or a separate job; stream large payloads instead of buffering them.
- **Stream, do not accumulate.** Building a 200k-row array in memory to send as JSON is a memory incident waiting for traffic; use streams or pagination.
- **Graceful shutdown** on `SIGTERM`: stop accepting connections, finish in-flight requests with a deadline, close the DB pool, then exit. Without it, every deploy drops requests.
- **Connection pools are configured, not defaulted.** Pool size, idle timeout and statement timeout are deployment decisions — see **query-tuning**.
- Structured JSON logging with pino, one request-scoped child logger carrying a request id. `console.log` is not logging in a service.
- Health endpoints (`/health/live`, `/health/ready`) and readiness that actually checks the database.

## Tooling layer

| Goal | Do this |
|---|---|
| Package manager | **pnpm**, with `packageManager` pinned in `package.json`; workspaces for a monorepo |
| Node version | `.nvmrc` plus `engines` — one version across dev, CI and the image |
| Module system | ESM (`"type": "module"`) for new projects; do not mix. In ESM, relative imports need explicit extensions |
| TypeScript config | `strict`, `moduleResolution: "bundler"` or `"nodenext"` matched to the runtime, `isolatedModules`, `noUncheckedIndexedAccess` |
| Dev loop | `node --watch` with type stripping for simple services; `tsx watch` when you need transpile-time features |
| Build | `tsc` for libraries; `tsup`/`esbuild` for a bundled service image |
| Tests | Native `node --test` for lean projects, **Vitest** when you want watch mode, mocks and coverage without ceremony |
| Debug | `node --inspect-brk`, then attach from the editor. Faster than a console.log bisect, every time |
| Profile | `node --cpu-prof` / `--heap-prof`, or Clinic.js — read a flame graph before optimizing anything |
| Lint | ESLint flat config with `@typescript-eslint`, `no-floating-promises` and `require-await` on |

## Data access

Prisma for speed of development and migrations, Drizzle when you want SQL you can read and full type inference over it, raw `pg`/`postgres.js` for tight control. Whichever you pick: queries live in repositories, N+1 is a bug you look for on every list endpoint, and transactions wrap a use case — never a whole request. Load **query-tuning** for query and index work, **db-schema-craft** for modeling.

## Testing

- Domain logic tested as plain functions, no HTTP, no database.
- Integration tests hit the real app through `supertest`/`app.inject()` against a **Testcontainers** database. SQLite standing in for PostgreSQL will pass tests production fails.
- Each test owns its data and cleans up; shared mutable fixtures produce order-dependent suites that fail only in CI.

## Framework recipes

NestJS module/provider/DI specifics, Express 5 and Fastify pipeline recipes, and the graceful-shutdown and error-mapping snippets are in [reference.md](reference.md). Load it when you are actually writing framework-level wiring.

## Rules

1. Detect Node version, module system and framework before writing code; match the repo's layering.
2. Handlers parse, delegate, map, return — no business logic and no data access in a route handler.
3. Services never see `req`/`res`; HTTP concepts stop at the boundary.
4. Every external input is parsed with a schema at the edge; no casting untrusted data.
5. Config is validated once at boot and exported typed; no scattered `process.env` reads.
6. No floating promises, no unhandled rejections, no `.then` chains mixed into `async` code.
7. Every outbound call has a timeout or an `AbortSignal`.
8. Nothing blocks the event loop in a request path; CPU work moves to a worker.
9. Errors are typed domain values mapped to status codes in exactly one place.
10. Graceful shutdown, structured logging and a real readiness check are part of the service, not extras.

