# Runtime seam'leri

> Durum: `accepted`, 2026-09-23 (Dalga 2a). Sahip: `src/harness/contracts/runtime.ts`, `projection.ts`, `paths.ts` (eşleştirici). Sağlayan/tüketen eşlemesi: [uygulama planı §4](../implementation-plan.md#4-entegrasyon-seamleri).

Bu belge iş akışları arasındaki TypeScript arayüzlerini (şema değil, davranış sözleşmesi) özetler. Dalga 1'de modüllerin yerel olarak genişlettiği her arayüz buraya taşındı; bir modül bu arayüzleri yerel tiplerle genişletmez, eksik gördüğünde sözleşme değişiklik isteği açar.

## 1. ContextBuilder (context → core)

- `ContextBuildInput`: `sessionId`, `runId`, `taskId`, **`attemptId`**, `role`, `route`, `policy`, `packet`, `requestId: RequestId`. `attemptId` verildiğinde history başka bir attempt'e bağlı olayları (aynı rol ve görev olsa bile) yabancı sayar.
- `ContextBuildResult` başarısızlığı: `reason` = `stale-sources | context-overflow | compaction-thrash | budget-exceeded`, `stale[]`, `detail?` (insan için; modele gitmez).
- `budget-exceeded` bir **ret sonucudur, istisna değildir**: driver model isteği göndermeden step'i `aborted` kapatır ve turu `budget_exceeded` ile bitirir (`failed` değil).
- `ContextBlockReport.source: ContextBlockSource` = `SYSTEM_BLOCK_SOURCES ∪ {history, tool-result}` (`CONTEXT_BLOCK_SOURCES`); `model/request_prepared.context[].source` ile aynı enum.

## 2. AgentDriver (core)

- `AgentDriverDependencies.credentials: CredentialResolver` **zorunludur**: `(route, signal, options?: ResolveOptions) → ResolvedCredential`. Composition root route'un `(provider_id, auth_method, profile)` üçlüsünü ilgili `AuthProvider.resolve`'a bağlar; başka kimliğe düşmez.
- `oauth-subscription` route'unda sağlayıcı ilk olaydan önce HTTP 401 dönerse driver **bir kez** `credentials(route, signal, { forceRefresh: true })` çağırır ve aynı isteği yeniden gönderir; ikinci ret kesindir. API key route'ları yeniden denenmez.
- `EventStore.quarantinedTail?` (dayanıklı store `openForWrite` sırasında karantinaya aldıysa) recovery tarafından `session/resumed.torn_tail` olarak yazılır.

## 3. Projection ve recovery (core → cli, orchestration)

`SessionProjection`, `Projected*`, `ProjectionIssue(Code)`, `RecoveryReport`, `RecoveredEntity` tipleri sözleşmededir (`projection.ts`). `projectSession`/`recoverSession` fabrikaları core'da kalır; tüketiciler yalnız tipleri contracts'tan alır.

**Attempt başlangıcı:** `attempt/started` attempt'i doğrudan `running` durumunda açar; ayrı bir `queued → running` olayı **yazılmaz** (projection bunu `state-mismatch` sayar). `queued` yalnız `attempt/started` yazılmadan önceki kavramsal durumdur.

## 4. WorkerManager ve IsolationProvider (orchestration → cli)

- `WorkerManager.dispatch(packet, signal, options?: DispatchOptions)`; `DispatchOptions` = `route?: RouteDecision` (çağıranın önceden kaydettiği karar, örn. bağımsız reviewer modeli), `seedArtifact?: Uint8Array` (revise attempt'inin devam ettiği artifact).
- `WorkerManager.dispatchReview(packet, target, signal, options?) → ReviewHandle { attemptId, result: Promise<ReviewOutcome>, cancel }`. `ReviewOutcome` = `review?` (kaydedilmiş review packet) + `verification { decision: accept|revise|block|invalid, problems[] }`. Review yeni session'da, hedefin sabitlenmiş artifact'ı üzerinde, salt okunur çalışır; hedefin transkripti verilmez.
- `IsolationProvider.create(packet, attemptId, signal, options?: IsolationCreateOptions)`; `readRoot?` salt okunur çalışma alanının ana workspace yerine okuduğu köktür (reviewer, incelenen artifact'ın izole kökünü okur).
- `integrate` başarıyla bitince çağıran `task/integrated { task_id, attempt_id, artifact_digest, paths }` yazar; `reviewing → completed` geçişi bu olaydan sonra gelir.

## 5. Yapılandırılmış rapor araçları

`task_report` (explorer, implementer, debugger), `review_report` (reviewer), `plan_propose` (orchestrator) — şemalar `packets.ts` içinde (`taskReportInputSchema`, `reviewReportInputSchema`, `planProposalSchema`; adlar `REPORT_TOOL_NAMES`). Araçlar `control` etkisidir ve gateway'den geçer: girdi şemaya uymazsa model `invalid_arguments` alır ve düzeltebilir. Callback gerekmez; orchestration attempt günlüğündeki **son başarılı** rapor çağrısının argümanlarını okur. Son asistan mesajındaki JSON bloğu yalnız hiç başarılı rapor çağrısı yoksa ve aynı şemayla ayrıştırılarak geri dönüş olarak kabul edilir. Rapor bir iddiadır: kimlik, değişen yollar, artifact digest'i ve tool call id'leri harness tarafından hesaplanır; her kanıt işaretçisi günlüğe karşı doğrulanır.

## 6. Ortak glob eşleştirici

`matchesPathPattern`, `matchesAnyPathPattern`, `isAncestorOfAnyPattern`, `hasReservedSegment` (`paths.ts`) policy, tools ve orchestration'ın kullandığı tek eşleştiricidir: `**` sıfır veya daha çok segment, `*`/`?` tek segment içinde, `[...]` ve `{a,b}` segment başına; glob içermeyen desen kendisini ve altını kapsar. Büyük/küçük harf duyarlılığını çağıran seçer: izin (write scope) duyarlı, ret (forbidden, reserved) duyarsız eşleşir; orchestration gerçek diff'teki yolları Windows'ta duyarsız karşılaştırır.
