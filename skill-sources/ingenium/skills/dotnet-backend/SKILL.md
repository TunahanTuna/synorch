---
name: dotnet-backend
description: Modern .NET backend engineering, current as of September 2026 (.NET 10 LTS, C# 14, ASP.NET Core 10, EF Core 10) - Minimal API versus controllers and when each wins, request pipeline and middleware ordering, dependency injection lifetimes and the captive-dependency trap, typed configuration and options validation, EF Core done right (change tracking, AsNoTracking, split queries, compiled models, safe migrations), async/await and cancellation discipline, resilient HttpClient through IHttpClientFactory, structured logging and OpenTelemetry, plus the dotnet CLI commands and test strategy (xUnit, WebApplicationFactory, Testcontainers) that make the loop fast. Carries an existing-codebase protocol - detect the target framework and paradigm before writing code. Use when writing, reviewing, upgrading or debugging ASP.NET Core services or EF Core data access, structuring a .NET solution, or asking how to work efficiently in a C# backend. Türkçe tetikleyiciler - "dotnet projesinde çalış", "asp.net core api yaz", "entity framework sorunu", "ef core migration", "c# best practice", "dotnet komutları", "minimal api mi controller mı", "dependency injection hatası", "dotnet sürüm yükseltme", "async await sorunu".
---

# .NET Backend

You write ASP.NET Core the way it is in 2026: a small, explicit host, endpoints that validate and delegate, EF Core used as a mapper you actually control rather than a magic box, and async all the way down with cancellation honored.

Always communicate with the user in their own language.

## Freshness protocol

Current as of **September 2026**: .NET 10 (LTS, Nov 2025) with C# 14, ASP.NET Core 10 and EF Core 10; .NET 8 is the previous LTS and still widespread. Before locking a target framework or upgrade decision, verify at learn.microsoft.com/dotnet and the .NET release notes — if reality moved past this skill, reality wins and say so.

## Existing codebase protocol (read before touching an old project)

- **Detect reality first**: `TargetFramework` from the `.csproj`, `Nullable` and `ImplicitUsings` flags, whether the app uses `Program.cs` top-level statements or the old `Startup.cs`, controllers or Minimal API, and the EF Core major version from the package reference.
- **Match the repo's paradigm.** A Minimal API island in a controller-based solution, or a MediatR-free vertical slice inside a CQRS codebase, costs more than the style it saves.
- **Feature-gate by target framework**: no `required` members or raw string literals below C# 11, no primary constructors or collection expressions below C# 12, no `field` keyword or extension members below C# 14, no EF Core 10 APIs on an EF Core 8 package.
- **Framework upgrades are proposed, scoped work** — never a quiet side effect of a feature.

## Minimal API or controllers

| Situation | Pick |
|---|---|
| Focused service, few dozen endpoints, performance-sensitive | **Minimal API** with endpoint groups (`MapGroup`) and one static class per feature |
| Large surface, heavy model binding, filters/conventions, OData-ish needs | **Controllers** — the convention machinery earns its weight |
| Existing solution | Whatever it already uses |

With Minimal API, do not let `Program.cs` become a thousand-line wall: one `MapXEndpoints()` extension per feature, registered from the host. Use `TypedResults` so the return type documents itself and tests can assert on it.

## Host and pipeline

- Middleware order is behavior, not style: exception handling → HSTS/HTTPS redirect → static files → routing → CORS → authentication → authorization → endpoints. Authorization before authentication is a security bug, not a warning.
- Use `IExceptionHandler` (or `UseExceptionHandler` with a problem-details writer) plus `AddProblemDetails` so every failure returns one RFC 9457 shape. Never let a stack trace reach a client.
- Health checks (`/health/live`, `/health/ready`) are part of the deliverable, not an extra.
- Bind configuration to records with `AddOptions<T>().Bind(...).ValidateDataAnnotations().ValidateOnStart()` — a bad config should fail at boot, not at 3 a.m. on the first request that reads it. Secrets come from user-secrets locally and the environment or a vault in production.

## Dependency injection

- **Lifetimes**: `Singleton` for stateless and thread-safe services, `Scoped` for anything per-request (a `DbContext` is always scoped), `Transient` for cheap stateless helpers.
- **The captive dependency trap**: injecting a scoped service into a singleton silently freezes one scope forever. A hosted service or singleton that needs a `DbContext` creates a scope per unit of work with `IServiceScopeFactory`.
- Register against interfaces the consumer needs; do not resolve from `IServiceProvider` inside business code — that is a service locator, and it hides dependencies from the constructor and from tests.

## EF Core, used deliberately

- **`AsNoTracking()` on every read-only query.** Change tracking on a list endpoint is pure waste, and it is the most common easy win in a .NET codebase.
- **Project, do not load.** `Select` into a DTO so the SQL fetches the columns you need; loading full entities to map three fields is bandwidth and memory you pay for on every request.
- **N+1 comes from lazy loading and from `Include` misuse.** Prefer explicit projection; when you do `Include` multiple collections, use `AsSplitQuery()` to avoid the cartesian explosion. For diagnosis and index work, load **query-tuning**.
- **Never call an async DB method inside a loop** over entities — batch it, or reshape the query.
- **`SaveChangesAsync` once per unit of work.** The `DbContext` is a unit of work and it is not thread-safe; never share one across parallel tasks or register it as a singleton.
- **Concurrency**: add a `rowversion`/`xmin` concurrency token on anything two users can edit, and handle `DbUpdateConcurrencyException` deliberately.
- **Migrations**: review the generated migration before applying it — EF will happily generate a destructive column drop. Never call `EnsureCreated` in a real app, never auto-`Migrate()` on startup in a multi-instance deployment, and follow the expand/contract sequence from **db-schema-craft** for anything a running version still reads.
- Log parameterized SQL in development (`EnableSensitiveDataLogging` in dev only) so you can see what EF actually sends.

## Async and cancellation

- Async all the way down. `.Result` and `.Wait()` are deadlock and thread-starvation generators — remove them, do not work around them.
- **Flow `CancellationToken` into every async call** — endpoint parameter, service method, `ToListAsync(ct)`. A canceled request that keeps hammering the database is wasted capacity.
- `async void` only for event handlers; anywhere else it makes exceptions uncatchable and crashes the process.
- Use `IAsyncEnumerable` for streaming large result sets instead of materializing a giant list.
- `ConfigureAwait(false)` matters in libraries, not in ASP.NET Core application code.

## HTTP clients and resilience

- Always `IHttpClientFactory` — typed clients (`AddHttpClient<IPricingClient, PricingClient>()`). Never `new HttpClient()` in a request path (socket exhaustion) and never a static one that never picks up DNS changes.
- Add `AddStandardResilienceHandler()` (Polly-backed: timeout, retry, circuit breaker) and set a real request timeout. Retry only idempotent operations, and never retry a POST that lacks an idempotency key.

## Observability

- Structured logging with message templates: `logger.LogInformation("Order {OrderId} rejected: {Reason}", id, reason)` — never string interpolation into the template, or you lose every structured field.
- Use log levels honestly: `Information` for business events, `Warning` for handled degradation, `Error` for failures needing attention. Never log secrets, tokens, or personal data.
- OpenTelemetry for traces and metrics, with correlation IDs propagated across service boundaries so one request is one trace.

## CLI commands that matter

| Goal | Command |
|---|---|
| Build fast, no restore | `dotnet build --no-restore` |
| Run one test | `dotnet test --filter "FullyQualifiedName~OrderServiceTests.Rejects"` |
| Watch loop | `dotnet watch run` |
| Add and apply a migration | `dotnet ef migrations add <Name>` / `dotnet ef database update` |
| See the SQL a migration will run | `dotnet ef migrations script <from> <to>` |
| Undo the last unapplied migration | `dotnet ef migrations remove` |
| Why is this package here | `dotnet list package --include-transitive` |
| Outdated or vulnerable packages | `dotnet list package --outdated` / `--vulnerable` |
| Consistent formatting | `dotnet format` |

Centralize versions in `Directory.Packages.props` with central package management, and put shared build settings in `Directory.Build.props`. Turn on `<Nullable>enable</Nullable>` and treat warnings as errors in CI.

## Testing

- **Unit tests** for domain logic with no framework in sight; xUnit plus `[Theory]` for cases.
- **Integration tests** with `WebApplicationFactory<Program>`, overriding only the dependencies that must be faked, and **Testcontainers** for the real database engine. In-memory EF providers do not enforce relational constraints — tests pass, production fails.
- Assert on HTTP status plus body shape at the boundary, and on behavior in the domain. Do not assert on which repository method was called.

## Rules

1. Detect the target framework and the repo's paradigm before writing code; never emit syntax the compiler cannot accept.
2. Async all the way down, with `CancellationToken` flowed through every call. No `.Result`, no `.Wait()`, no `async void`.
3. `DbContext` is scoped, never shared across threads, and `SaveChangesAsync` is called once per unit of work.
4. Read-only queries use `AsNoTracking` and project into DTOs; entities never become HTTP responses.
5. Every outbound HTTP call goes through `IHttpClientFactory` with a timeout and a resilience handler.
6. Configuration is bound to validated options and fails at startup, not at first use.
7. One exception-to-`ProblemDetails` mapping for the whole API; no stack traces to clients.
8. Structured logging with message templates; no secrets or personal data in logs.
9. Every generated migration is read before it is applied, and destructive schema changes follow expand/contract.
10. Integration tests run against the real database engine via Testcontainers, not an in-memory provider.

