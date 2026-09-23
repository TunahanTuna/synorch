# Runtime seam'leri

> Durum: `accepted`, 2026-09-23 (Dalga 2a; §7–§10 canlı çalıştırma sağlamlaştırması W0, ADR-18/19/20). Sahip: `src/harness/contracts/runtime.ts`, `projection.ts`, `paths.ts` (eşleştirici). Sağlayan/tüketen eşlemesi: [uygulama planı §4](../implementation-plan.md#4-entegrasyon-seamleri).

Bu belge iş akışları arasındaki TypeScript arayüzlerini (şema değil, davranış sözleşmesi) özetler. Dalga 1'de modüllerin yerel olarak genişlettiği her arayüz buraya taşındı; bir modül bu arayüzleri yerel tiplerle genişletmez, eksik gördüğünde sözleşme değişiklik isteği açar.

## 1. ContextBuilder (context → core)

- `ContextBuildInput`: `sessionId`, `runId`, `taskId`, **`attemptId`**, `role`, `route`, `policy`, `packet`, `requestId: RequestId`. `attemptId` verildiğinde history başka bir attempt'e bağlı olayları (aynı rol ve görev olsa bile) yabancı sayar.
- `ContextBuildResult` başarısızlığı: `reason` = `stale-sources | context-overflow | compaction-thrash | budget-exceeded`, `stale[]`, `detail?` (insan için; modele gitmez).
- `budget-exceeded` bir **ret sonucudur, istisna değildir**: driver model isteği göndermeden step'i `aborted` kapatır ve turu `budget_exceeded` ile bitirir (`failed` değil).
- `ContextBlockReport.source: ContextBlockSource` = `SYSTEM_BLOCK_SOURCES ∪ {history, tool-result}` (`CONTEXT_BLOCK_SOURCES`); `model/request_prepared.context[].source` ile aynı enum.
- `ContextBuildInput.sources?: WorkspaceDigestReader` (ADR-19): paket kaynaklarının güncel digest'ini paketin hesaplandığı çalışma alanında (attempt kökü) ve paketin şemasıyla okur. Worker manager `TurnInput.sources` ile verir, driver aynen geçirir; yoksa builder kendi yapılandırılmış okuyucusuna düşer (ADR-19 öncesi davranış).
- `ModelRequest.cache?` (ADR-20): builder `key` (session + rol) ve kararlı sistem bloğu sayısını doldurur; kararlı bloklar (harness, anayasa, rol protokolleri, rol, skill kataloğu, birincil skill) önce, değişken bloklar (packet, hafıza, compaction) sonra gelir.

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
- ADR-19 eklemeleri (hepsi opsiyonel; W1b somutlaştırır): `IsolatedWorkspace.digest?: WorkspaceDigestReader` (bu kökte `workspaceDigest`), `reused?`, `fallback?{from: worktree, reason: ISOLATION_FALLBACK_REASONS, detail}`, `overlaid?[]`, `dependencyLinks?[]` (`DEPENDENCY_LINK_DIRECTORIES`), `submodules?[]`; `IsolationCreateOptions.reuse?` (aynı görevin önceki çalışma alanı: sağlayıcı yeni worktree açmaz, tabana sıfırlar; sahiplik ve `dispose` çağıranda, görev sonuçlanınca), `overlay?[]` (ana ağaçta kirli/izlenmeyen okuma girdileri; sahip olunan yollar asla overlay edilmez). Bunlar `attempt/started` v3 `isolation.*` alanlarına yazılır.
- Sıra (ADR-19): izolasyon **önce** açılır, paket `sources`/`known_facts` digest'leri `workspace.digest` ile attempt kökünde hesaplanır (`context.digest_scheme: workspace-raw-v1`), sonra paket yayımlanır ve `attempt/started.packet_digest` bu son pakete bağlanır. Freshness kapısı ve ContextBuilder freshness denetimi paketin şemasıyla ve paketin hesaplandığı kökte okur.
- `integrate`: çakışma `ContentIdentity` ile (ana ağaçtaki dosyanın `git hash-object --path` kimliği = HEAD blob'u veya kaydedilen after-blob'u), yazılan içerik ana ağacın gösterimine çevrilir (worktree'de clean, ana ağaçta smudge/EOL). Overlay edilen yollar integrate edilmez.

## 5. Yapılandırılmış rapor araçları

`task_report` (explorer, implementer, debugger), `review_report` (reviewer), `plan_propose` (orchestrator) — şemalar `packets.ts` içinde (`taskReportInputSchema`, `reviewReportInputSchema`, `planProposalSchema`; adlar `REPORT_TOOL_NAMES`). Araçlar `control` etkisidir ve gateway'den geçer: girdi şemaya uymazsa model `invalid_arguments` alır ve düzeltebilir. Callback gerekmez; orchestration attempt günlüğündeki **son başarılı** rapor çağrısının argümanlarını okur. Son asistan mesajındaki JSON bloğu yalnız hiç başarılı rapor çağrısı yoksa ve aynı şemayla ayrıştırılarak geri dönüş olarak kabul edilir. Rapor bir iddiadır: kimlik, değişen yollar, artifact digest'i ve tool call id'leri harness tarafından hesaplanır; her kanıt işaretçisi günlüğe karşı doğrulanır.

## 6. Ortak glob eşleştirici

`matchesPathPattern`, `matchesAnyPathPattern`, `isAncestorOfAnyPattern`, `hasReservedSegment` (`paths.ts`) policy, tools ve orchestration'ın kullandığı tek eşleştiricidir: `**` sıfır veya daha çok segment, `*`/`?` tek segment içinde, `[...]` ve `{a,b}` segment başına; glob içermeyen desen kendisini ve altını kapsar. Büyük/küçük harf duyarlılığını çağıran seçer: izin (write scope) duyarlı, ret (forbidden, reserved) duyarsız eşleşir; orchestration gerçek diff'teki yolları Windows'ta duyarsız karşılaştırır.

## 7. Kısa ref ve terminal araçlar (tools → core, ADR-18/20)

- Gateway her çağrıya attempt içi (attempt yoksa session içi) sıra verir: `tool/call_proposed.ref` (v2) + `ToolCallOutcome.ref`. Driver model mesajındaki sonucu yalnız `renderToolResultText(outcome.ref, outcome.result)` ile kurar (`modelVisibleText` bunun `ref` yokken aynısıdır). Backend köprüsü (`AgentBackendAdapter`) aynı render'ı kullanır.
- `ToolMetadata.ends_turn` (yalnız `control`): çağrı `succeeded` ve `status: ok` ise gateway `ToolCallOutcome.endsTurn = true` döner. Driver o batch'teki sonraki çağrıları çalıştırmaz (her biri sentetik `turn ended by <tool>` hata sonucu alır) ve turu yeni model isteği göndermeden `completed` bitirir. Reddedilen rapor (`invalid_arguments`) turu bitirmez; model düzeltme turunu aynı session'da kullanır.

## 8. Attempt dosya defteri (tools, ADR-18 D3)

`ToolExecutionContext.files?: AttemptFileLedger` — `lastSeen(path)`, `noteRead(path, digest)`, `noteWrite(path, digest?)`. Gateway attempt başına (attempt yoksa session başına) bir defter tutar; anahtar NFC + platform katlama politikasıdır (`normalizePathUnicode`, `foldPathCase`). `read_file` okuduğu digest'i, `write_file`/`apply_patch` yazdığı yeni digest'i kaydeder; `expected_digest` verilmezse `lastSeen` kullanılır. Resume sonrası defter `tool/result_recorded.result.digest` (v2) kayıtlarından yeniden kurulabilir; kurulamazsa açık digest gerekir. Defter izin vermez.

## 9. Rapor araçlarında kanıt doğrulaması (orchestration + tools, ADR-18 D1)

`task_report`/`review_report` artık bir callback'le kanıtı çağrı içinde çözer (callback orchestration'dadır, composition root'ta `ControlCallbacks.taskReport`/`reviewReport` olarak bağlanır; aktif attempt'i `ToolExecutionContext.attemptId` ile bulur). Sonuç: hepsi çözülürse `ok` (tur biter), aksi halde `invalid_arguments` + `formatEvidenceCorrection` metni; `REPORT_CORRECTION_ROUNDS` (= 1) düzeltmeden sonra rapor olduğu gibi `ok` ile kabul edilir ve çözülmeyenler `evidence_resolution`'a `unresolved` yazılır. Orchestration her zaman "son başarılı rapor çağrısı"nı okur (§5 değişmedi). Çözüm yöntemi ve sırası: [task-packets §8](./task-packets.md#8-harness-kanıtı-çözümleme-ve-onarım-adr-18).

## 10. Yol karşılaştırma politikası (ADR-19)

Tüm yol karşılaştırmaları NFC'dir (`normalizePathUnicode`). Büyük/küçük harf duyarsız platformlar `CASE_INSENSITIVE_PLATFORMS` = `win32`, `darwin`; duyarsız karşılaştırma yalnız `foldPathCase` ile yapılır (NFC + uzunluk koruyan, yerelden bağımsız kod noktası büyük harfe çevirme; Türkçe özel kuralı yok: `ı`→`I`, `İ` yalnız kendisi — NTFS'teki gibi `şehir` ≠ `ŞEHİR`). Paylaşılan eşleştirici (`matchesPathPattern`, `isAncestorOfAnyPattern`, `pathPatternsOverlap`, `isReservedWritePattern`) bu politikayı uygular; policy, tools ve orchestration kendi `toLowerCase` karşılaştırmalarını bırakıp bunu kullanır.
