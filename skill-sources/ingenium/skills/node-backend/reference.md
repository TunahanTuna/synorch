# Node Backend — Framework Recipes

Load this when writing framework-level wiring. Everything here assumes the rules in SKILL.md still hold: handlers stay thin, services never see `req`/`res`, inputs are parsed at the edge.

## NestJS 11

### Module boundaries

One module per feature, exporting only what other modules legitimately need. A module that exports every provider is a namespace, not a boundary.

```ts
@Module({
  imports: [TypeOrmModule.forFeature([Order]), BillingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
```

- Circular imports between modules mean the boundary is wrong. `forwardRef` is a patch for a design problem — fix the direction, extract a shared module, or move the shared concept down.
- `@Global()` is almost always a mistake; the exception is a genuinely cross-cutting infrastructure module (config, logger) registered once at the root.

### Providers and scope

- Default provider scope is **singleton**. `Scope.REQUEST` propagates up the whole injection chain and destroys performance — use it only when you truly need per-request state, and prefer `AsyncLocalStorage` (via `nestjs-cls`) for request context instead.
- Inject by class token wherever possible; string tokens are for dynamic and third-party wiring, and they lose type safety.
- Custom providers (`useFactory`, `useClass`, `useValue`) are how you swap implementations per environment — not `if (process.env.NODE_ENV)` inside the service.

### The pipeline, in order

`Middleware → Guards → Interceptors (before) → Pipes → Handler → Interceptors (after) → Exception filters`

| Concern | Belongs in |
|---|---|
| Is this caller allowed | **Guard** (`CanActivate`) |
| Parse and validate the payload | **Pipe** (`ZodValidationPipe` or `ValidationPipe`) |
| Timing, logging, response envelope, caching | **Interceptor** |
| Turning a domain error into an HTTP response | **Exception filter**, registered once globally |
| Raw request concerns (correlation id, body capture) | **Middleware** |

Register the validation pipe and the exception filter globally in `main.ts`, never per-controller by copy-paste.

```ts
app.useGlobalPipes(new ZodValidationPipe());
app.useGlobalFilters(new DomainExceptionFilter());
app.enableShutdownHooks();
```

### Validation with Zod

Define the schema next to the feature and derive the DTO type from it; do not maintain a `class-validator` DTO *and* a schema.

```ts
export const createOrderSchema = z.object({
  customerId: z.uuid(),
  lines: z.array(z.object({ sku: z.string().min(1), qty: z.int().positive() })).min(1),
});
export type CreateOrder = z.infer<typeof createOrderSchema>;
```

If the project already standardizes on `class-validator`, stay with it — consistency wins.

### Configuration

`ConfigModule.forRoot({ validate, isGlobal: true, cache: true })` with a schema-based `validate` function, then inject a typed config service. Never read `process.env` inside a provider.

### Testing

- Unit: instantiate the service directly with fakes. `Test.createTestingModule` for one class is ceremony.
- Integration: build the real module graph, override only the boundary providers, hit it with `supertest`. Use Testcontainers for the database.
- `app.close()` in `afterAll`, or the suite leaks handles and hangs CI.

### Common Nest mistakes

Business logic in controllers; request-scoped providers used casually; `forwardRef` instead of fixing a boundary; entities returned straight from controllers; `@Global()` on feature modules; catching errors in the service to return `null`, which erases the reason the operation failed.

## Fastify 5

- **Schema-first**: attach JSON Schema for body, querystring, params and response. Response schemas are not documentation — Fastify uses them to serialize, which is both faster and a guarantee you never leak an internal field.
- Use `fastify-type-provider-zod` (or the TypeBox provider) so one schema gives you validation, serialization and inference.
- **Plugins encapsulate.** Anything registered inside a plugin is invisible outside it; to share a decorator or hook, wrap with `fastify-plugin`. Most "my decorator is undefined" bugs are this rule working as designed.
- Hooks map cleanly to concerns: `onRequest` for auth, `preValidation` for shaping input, `preHandler` for authorization, `onSend` for response mutation, `onError` for logging.
- `setErrorHandler` once, at the root, mapping domain errors to status codes.
- Fastify ships pino: use `request.log`, which already carries the request id.

```ts
app.get('/orders/:id', { schema: { params: idParams, response: { 200: orderResponse } } },
  async (req) => toResponse(await orders.byId(req.params.id)));
```

## Express 5

- Async handlers that reject now reach the error middleware — no `express-async-handler` wrapper needed. Non-promise callbacks still do not; call `next(err)`.
- The error handler is the **last** `app.use`, takes four arguments, and is the only place that turns a domain error into a status code.
- Path matching changed in 5: no bare `*` wildcards (`/*` becomes `/*splat`), and optional-parameter syntax is stricter. This is the most common Express 4→5 upgrade break.
- Order is behavior: security headers (`helmet`) → cors → body parsers with an explicit `limit` → routes → 404 handler → error handler.
- `express.json({ limit: '1mb' })` — an unbounded body parser is a denial-of-service surface.
- Router per feature (`ordersRouter`), mounted at one path. A 600-line `app.ts` is the failure mode Express invites.

## Error mapping (any framework)

```ts
export class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}
export class NotFoundError extends DomainError {
  constructor(what: string) { super(`${what} not found`, 'not_found', 404); }
}
```

One mapper at the boundary turns these into an RFC 9457 body:

```json
{ "type": "about:blank", "title": "not_found", "status": 404, "detail": "Order not found", "instance": "/orders/42" }
```

Unknown errors become a 500 with a correlation id in the body and the full stack in the log — never the stack in the response.

## Graceful shutdown

```ts
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 10_000).unref();
  try { await app.close(); await db.end(); clearTimeout(timer); process.exit(0); }
  catch (err) { logger.error({ err }, 'shutdown failed'); process.exit(1); }
};
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => void shutdown(s));
```

The hard-exit timer matters: without it a hung connection makes the pod hang until the orchestrator kills it, which looks exactly like a crash.

## Monorepo layout (pnpm workspaces)

```
pnpm-workspace.yaml
apps/api/          the service
packages/contracts/  Zod schemas + inferred types shared with the frontend
packages/config/     tsconfig + eslint bases
```

`packages/contracts` is the highest-leverage package in a full-stack repo: the API validates with the same schema the frontend's client types are inferred from, so a contract change breaks the build instead of production. Use `workspace:*` for internal dependencies and keep a single TypeScript base config.

