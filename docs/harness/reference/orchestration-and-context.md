# Orkestrasyon ve bağlam (I4) referansı

> Durum: I4 teslimi, 2026-09-22. Kod: `src/harness/orchestration/**`, `src/harness/context/**`. Testler: `tests/harness-orchestration-*.test.ts`, `tests/harness-context-*.test.ts`. Sözleşmeler: [task packet'leri](../contracts/task-packets.md), [kimlik ve durum](../contracts/identity-and-state.md), [policy ve onay](../contracts/policy-and-approval.md), [hafıza](../contracts/memory.md). Kararlar: ADR-07, ADR-08, ADR-09, ADR-10, ADR-11, ADR-14.

Bu belge Synorch orkestrasyon modelini zorlayan runtime katmanını anlatır: orchestrator planlar, onaylatır ve delege eder; ürün dosyası yazmaz. Worker'lar (explorer, implementer, debugger, reviewer) yalnız task packet'i görür, kendi izole çalışma alanında çalışır ve completion packet'le döner. Standart ve yüksek riskli işler bağımsız review'dan geçmeden tamamlanmaz. Her şey olay günlüğüne yazılır; iki modül de yalnız `contracts`, `src/domain`, `zod` ve `node:*` import eder.

## 1. Fabrikalar

| Fabrika | Modül | Görev |
| --- | --- | --- |
| `createCoordinator(deps)` | orchestration | Bir run'ı uçtan uca yürütür (`Coordinator`). |
| `createWorkerManager(deps)` | orchestration | Packet'ten attempt başlatır, completion ve review packet'lerini kurar. Sözleşmedeki `WorkerManager` (`dispatch` + `DispatchOptions`, `dispatchReview`) artı coordinator'ın kendi `attempt/verify/integrate/revert/dispose` adımları (`OrchestrationWorkerManager`). |
| `createIsolationProvider(deps)` | orchestration | ADR-07 izolasyonu ve `integrate` (`OrchestrationIsolationProvider extends IsolationProvider`). |
| `createWorkerFactory(shared)` | orchestration | Her run için WorkerManager + IsolationProvider bağlar; composition root için kısayol. |
| `createControlPlaneWriter(deps)` | orchestration | Orchestrator'ın tek yazma yolu (`.ai/tasks/**`). |
| `createBudgetTracker`, `createBudgetGateSlot`, `requestBudgetIncrease` | orchestration | ADR-14 bütçesi. |
| `createModelPlanner(deps)` | orchestration | Orchestrator turunu çalıştırıp planı son başarılı `plan_propose` çağrısından (geri dönüş: son mesajın JSON bloğu) okur. |
| `createContextBuilder(deps)` | context | `ContextBuilder` (I1 driver'ı her adımda çağırır). |
| `createCompactor(deps)` | context | `summary-v1` compaction. |

Test doubles `src/harness/orchestration/testing.ts` içindedir (in-memory session/blob store, sözleşmeye uyan sahte policy engine, scripted router/broker/driver/planner, geçici git deposu, `replayTransitions`). Runtime bu dosyayı import etmez.

Composition root için tipik bağlama:

```ts
const budgetGate = createBudgetGateSlot();
const context = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: registry,
  sources: createSourceReader(root), memory: { store, projectId, branch }, budget: budgetGate,
  compactor: createCompactor({ blobs, writerFor }) });
const createDriver = (events) => createAgentDriver({ events, blobs, router, context, tools: registry, gateway, credentials });
const coordinator = createCoordinator({ sessions, blobs, router, policy, approvals, sandbox, budgetGate,
  planner: createModelPlanner({ createDriver, blobs }),
  createWorkers: createWorkerFactory({ sessions, blobs, router, policy, createDriver, sandbox }) });
```

## 2. Run akışı

1. `run/created` → run `created → running`. Orchestrator için `PolicyEngine.compute` `taskScope.owned = [".ai/tasks/**"]` ile çağrılır ve `policy/snapshot` yazılır; orchestrator route'u `route/decided` ile kaydedilir.
2. **Plan.** `Planner.propose` bir aday döndürür; `validatePlan` = `planSchema` + beklenen `run_id`/`plan_id`/`version`. Geçersiz aday olaya yazılmaz, sorunlar geri besleme olarak ikinci denemeye verilir (`maxPlanAttempts`, varsayılan 2). Geçerli plan `plan/proposed` + `plan/state_changed draft → proposed`.
3. **Onay (ADR-08).** `autonomous`: orchestrator kendi planını onaylar; `approval/requested` ve `approval/decided { decided_by: orchestrator, mode: autonomous }` olayları audit için yazılır, kullanıcıya soru sorulmaz. `ask`: run `waiting_for_approval`'a geçer, `ApprovalBroker` kullanıcıya sorar. Headless broker `unavailable` döner; plan `rejected`, run `cancelled`, exit 3. Broker'dan gelen karar `decisionAnswers` ile doğrulanır: şema, aynı `approval_id`/`subject_digest`/mod ve insan-only konular (`provider-change`, `budget`) için `decided_by: user` şartı.
4. **DAG.** Her plan görevi için `task/created` yazılır ve görevin route'u önceden çözülür (sağlayıcı limiti için). `createDagScheduler` çevrimsizliği doğrular; bir görev yalnız tüm bağımlılıkları `completed` iken, global/sağlayıcı/çalışma alanı limitleri izin veriyorsa ve çalışan hiçbir görevle `owned_paths` kesişmiyorsa başlar. Kesişim testi sözleşmedeki muhafazakâr `pathPatternsOverlap`'tir. Plan şeması zaten bağımsız çakışan yazarları reddeder; scheduler ikinci ve bağımsız bir korumadır. Görevin slotu review ve integrate bitene kadar tutulur.
5. **Görev hattı** (her geçiş `validateTransition` ile denetlenir, `task/state_changed` olarak yazılır):

| Durum | Sonraki adım |
| --- | --- |
| `draft → ready` | Packet derlenir (`compileTaskPacket`): plan varsayımları ve bağımlılık bulguları `decisions`'a, literal owned/read yolları ve bağımlılıkların integrate ettiği yollar `context.sources`'a (digest ile). |
| `ready → running` | `WorkerManager.dispatch`; kaynak değişmişse `stale_packet` → `refreshPacketSources` ile yeniden paketlenir. |
| completion `needs_context` | `running → needs_context → ready`, kaynaklar tazelenir, değişen kaynağa dayanan `known_facts` düşürülüp `open_questions`'a yazılır. |
| completion `blocked` | `running → blocked` (görev biter). |
| completion `failed`/`partial` | `running → failed → retry_pending → ready`, delta packet ile yeni attempt (`maxRetries`). |
| completion `completed` | `running → verifying`, orchestrator doğrulaması (§4). |
| doğrulama geçti, `trivial` | Değişiklik varsa `integrate`, `verifying → completed`. |
| doğrulama geçti, `standard`/`high-risk` | `verifying → reviewing`, bağımsız review (§5). |
| review `accept` | `integrate(pinned artifact)` + `task/integrated`, `reviewing → completed`. |
| review `revise` | `reviewing → changes_requested → ready`; delta packet (bulgular + `review:F-n` kanıt işaretçileri), yeni attempt önceki artifact'tan devam eder (`maxRevisions`). |
| review `block` / geçerli review yok | `reviewing → failed`. |

6. Başarısız görevin bağımlıları `cancelled` olur; başarısız görevin scoped-dir değişiklikleri geri alınır, worktree'ler temizlenir.
7. **Final rapor.** Görev başına durum ve integrate edilen dosyalar `RunOutcome.summary`'dir. Hepsi `completed` → exit 0; bütçe durdurması → 9; diğer başarısızlık → 5; iptal → 130. `ledger: true` ise `plan.json` ve `report.md` `.ai/tasks/<run-id>/` altına control-plane writer ile yazılır.

`Coordinator.onEvent` run günlüğüne eklenen her olayı ve uyarıları beklemeden (`queueMicrotask`) dinleyicilere dağıtır; yavaş bir renderer run'ı yavaşlatmaz. `steer(text)` `steer/queued` yazar ve planlama sürüyorsa bir sonraki plan denemesine geri besleme olur.

## 3. Attempt'ler ve izolasyon (ADR-07)

Her attempt:

- yeni bir `AttemptId` ve **kendi session'ını** alır (`SessionStore.create`). Böylece worker'ın model bağlamı yalnız kendi packet'ini ve turlarını içerir; başka bir attempt'in transkripti fiziksel olarak aynı günlükte değildir. Run günlüğüne `route/decided`, `policy/snapshot`, `task/packet_issued`, `attempt/started` (v2; `session_id` attempt session'ına bağlar; attempt'i `running` sayar, ayrı bir `queued → running` olayı yazılmaz) ve sonunda `attempt/state_changed running → succeeded|failed|cancelled` ile `attempt/completion_recorded` yazılır.
- rolü ve kapsamı için hesaplanan `EffectivePolicy` ile çalışır; `rca-only` debugger ve read-only roller için `taskScope.owned` boştur (ADR-10).
- packet `max_wall_time_seconds` sonunda ve bütçenin `cancel-active` kararıyla iptal edilir.

İzolasyon modları:

| Mod | Ne zaman | Davranış |
| --- | --- | --- |
| `worktree` | Git deposu (çalışma kökü = repo kökü), commit var, kullanıcının commit edilmemiş değişiklikleri `owned_paths` ile kesişmiyor | `~/.synorch/worktrees/<project-id>/<attempt-id>` altında `git worktree add --detach HEAD`. Bu provider'ın daha önce integrate ettiği (henüz commit edilmemiş) dosyalar kullanıcı değişikliği sayılmaz ve yeni worktree'ye kopyalanır. `home` test için enjekte edilir. |
| `scoped-dir` | Git değil, veya kullanıcı değişikliği owned yollarla çakışıyor, veya packet bunu istiyor | Yerinde yazma; attempt öncesi içerik saklanır (git'te HEAD + kirli dosyaların anlık kopyası, git dışında owned dosyaların kopyası + tüm ağacın digest manifest'i) ve `revert()` ile geri alınabilir. Eşzamanlı başka bir scoped-dir attempt'in owned yollarındaki değişiklik bu attempt'e atfedilmez. |
| `shared-read-only` | Explorer, reviewer, `rca-only` debugger | Değişiklik beklenmez; reviewer, incelenen attempt'in kökünü (`readRoot`) okur. |

`high-risk` yazan görev worktree açılamıyorsa `sandbox_insufficient` ile reddedilir; scoped-dir'e düşmez.

**Artifact.** `changeSet()` değişen her yol için `{path, before, after, content}` üretir; `before/after` ham baytların `sha256`'sıdır. Kanonik JSON'un `sha256`'sı artifact digest'idir ve blob olarak saklanır. Değişiklik tespiti git'te `git status --porcelain -z --untracked-files=all --no-renames` (ignore edilen dosyalar hariç) ile, git dışında ağaç manifest'iyle yapılır.

**Integrate** (`IsolationProvider.integrate(workspace, expectedArtifact)`), açık ve tek yoldur:

1. Artifact yeniden hesaplanır; beklenen digest'ten farklıysa `verification_failed` (review'dan sonra değişmiş artifact uygulanmaz).
2. `changed ⊆ owned` ve forbidden/rezerve yol yok; değilse `policy_denied`.
3. Worktree modunda ana çalışma alanındaki her hedefin mevcut digest'i `before` ile eşleşmeli; kullanıcının bu arada yaptığı düzenleme veya aynı yoldaki untracked dosyası çakışma olarak raporlanır ve hiçbir dosya ezilmez. Sonra dosyalar atomik (temp + rename) yazılır veya silinir.
4. Scoped-dir'de değişiklik zaten yerindedir; yalnız doğrulama yapılır.
5. Başarılı integrate sonrası WorkerManager run günlüğüne `task/integrated { task_id, attempt_id, artifact_digest, paths }` yazar; `completed` geçişi bundan sonra gelir.

`seed()` bir revise attempt'ini önceki artifact'tan başlatır; yeni artifact kümülatiftir.

## 4. Completion packet ve orchestrator doğrulaması

Worker attempt'i `task_report` aracıyla bitirir (status, summary, acceptance_evidence, commands_run, decisions_made, skipped_checks, unresolved_risks, recommended_context_updates, root_cause; şema `taskReportInputSchema`). Gateway girdiyi doğrular ve kaydeder; `readClaim` attempt günlüğündeki **son başarılı** `task_report` çağrısının argümanlarını okur. Başarılı rapor çağrısı yoksa son asistan mesajının ` ```json ` bloğu aynı şemayla geri dönüş olarak ayrıştırılır. Bu bir **iddiadır**. Completion packet'i harness kurar: `task_id`, `attempt_id`, `packet_digest`, `changed_paths` ve `artifact_digest` gerçek diff'ten, `tool_call_ids` attempt günlüğünden gelir; worker'ın değişen dosya listesi hiç kullanılmaz. Reviewer'a atfedilen kanıt çıkarılır, kanıtsız `completed` `partial`'a düşer, iddia yoksa veya tur başarısızsa `failed`, onay bekleyen tur `blocked`, çalışma sırasında kaynak değiştiyse iddiadan bağımsız olarak `needs_context` olur. Sonuç `completionPacketSchema` ile doğrulanır.

`verifyCompletion` (orchestrator doğrulaması):

- **reject**: başka task/packet sürümü, `completed` dışı durum, read-only/rca-only attempt'in dosya değiştirmesi, owned dışı/forbidden/rezerve yol (gerçek diff'e göre), raporlanan yolların diff'ten farklı olması, artifact digest uyuşmazlığı.
- **revise**: kanıtı çözülemeyen kabul ölçütü (`unevidenced` listesi), bilinmeyen ölçüte kanıt, çözülemeyen komut kanıtı, packet'teki doğrulama komutunun ne çalıştırılmış ne gerekçeyle atlanmış olması veya sıfır dışı çıkışı, `rca-only`'de `root_cause` eksikliği.

Kanıt çözümü (`resolveEvidence`): `tool-call`/`test-run` bu attempt'in `succeeded` bir tool çağrısı olmalı (test-run için çıkış 0); `artifact` sabitlenmiş artifact olmalı; `file` çalışma alanında var olmalı ve digest verilmişse eşleşmeli; `event` bu session'daki bir olay olmalı; `review` işaretçisi birinci el kanıt değildir. Compaction özeti (olayı veya blob digest'i) hiçbir biçimde kanıt sayılmaz.

## 5. Bağımsız review (ADR-09)

- `standard` ve `high-risk` görevler (`reviewer` rolündeki plan görevleri hariç) review'suz tamamlanamaz; tek kapı `mayComplete(packet, review)`'dur.
- Reviewer taze bir packet alır (`compileReviewerPacket`): read-only, `shared-read-only`, kabul ölçütleri, doğrulama komutları ve `context.project_snapshot = artifact digest`. Plan'da bu göreve bağımlı bir reviewer görevi varsa onun model tier'ı kullanılır. Route `role: reviewer` ile ayrıca çözülür (router farklı model tercih eder).
- Reviewer **ayrı bir session'da** çalışır ve implementer'ın çalışma kökünü salt okur. İlk mesajı completion packet'i, artifact digest'i ve değişen dosyaların içeriğidir; implementer transkripti asla verilmez. ContextBuilder da aynı session'da olsa bile başka rolün asistan/tool mesajlarını düşürür.
- Reviewer hükmünü `review_report` aracıyla verir (geri dönüş: JSON bloğu). Review packet'i harness kurar: kimlikler, `completion_digest`, `reviewed_artifact_digest`, `reviewer_route`, `independence { separate_context: true, same_provider, same_model }`. Şemaya uymayan review (ör. yalnız worker kanıtlı `met`) kaydedilmez ve geçersizdir.
- `verifyReview`: reviewer'ın `produced_by: reviewer` kanıtı yalnız **reviewer'ın kendi** tool çağrılarına çözülür; implementer'ın çağrısını kendi kanıtı gibi göstermek review'u `invalid` yapar. Değerlendirilmemiş, `not_met` veya `unverifiable` ölçüt `revise` demektir. Review sırasında artifact değişirse review geçersizdir. Geçersiz review'da yeni reviewer attempt'i açılır (`maxReviewAttempts`), sonra görev `failed` olur.

## 6. Freshness kapısı

- Dispatch'te packet'in tüm `context.sources`'ı ana çalışma alanında `digestText` ile yeniden özetlenir; fark varsa her yol için `context/source_changed` yazılır, attempt başlamaz ve `stale_packet` hatası döner. Coordinator yeniden paketler.
- Çalışma sırasında: ContextBuilder her adımda aynı kontrolü yapar ve `stale-sources` döner; worker'ın kendi `owned_paths`'indeki kaynaklar bu kontrolün dışındadır (worker'ın onları değiştirmesi beklenir). Tur bitince WorkerManager kontrolü tekrarlar; değişen kaynak varsa completion `needs_context` olur.

## 7. ContextBuilder

Her adımda model girdisi yalnız kalıcı durumdan yeniden kurulur:

1. Packet varsa freshness kapısı (§6).
2. Bütçe kapısı (`RequestBudgetGate.admit`): session'daki `provider/usage` olayları izleyiciye verilir; reddedilirse `{ ok: false, reason: "budget-exceeded", detail }` döner ve istek hazırlanmaz (driver turu `budget_exceeded` bitirir).
3. History: son `context/compacted` olayının `first_kept_seq`'inden sonraki `message/recorded` olayları ve `steer/queued` (kullanıcı mesajı olarak). Yalnız bu rolün ve (verildiyse) bu `attemptId`'nin asistan/tool mesajları alınır; kullanıcı rollü girdi kullanıcıdan veya orchestrator'dan gelebilir. Cevapsız tool çağrısına "sonuç bilinmiyor, tekrarlanmadı" hata sonucu eklenir, eşsiz sonuç düşürülür.
4. Sistem blokları güven sırasıyla: `harness` (Synorch'un rol kuralları) → `project` (anayasa, protokoller, repo rol metni, skill kataloğu, tetiklenen skill'ler, packet) → `untrusted` (compaction özeti, hafıza). Blok digest'i `digestText(text)`'tir.
5. Skill kataloğu her adımda tek satırlık listedir; tam `SKILL.md` yalnız adı veya tetik ifadesi packet hedefinde/kararlarında ya da son kullanıcı mesajında geçen skill için yüklenir.
6. Hafıza (`MemoryStore.search`, proje/branch filtresiyle): her not `source: memory`, `trust: untrusted` bloktur; neden seçildiği yazılır, `stale` not açıkça işaretlenir, `superseded`/`rejected` kararlar atlanır.
7. Token bütçesi (yaklaşık 4 karakter = 1 token): sınır `pencere − max(rezerv 16k, max_output)`. Aşımda önce hafıza, sonra skill, sonra katalog kısaltılır ve raporda `truncated: true` olur. Hâlâ aşıyorsa compaction; olmazsa `context-overflow`.
8. İstek `ModelRequest` olarak kurulur, `envelopeDigest = digestOf(request)`. Aynı günlük ve aynı `requestId` için digest bayt bayt aynıdır (replay). Rapor her blok için kaynak, güven, token tahmini ve kısaltma bilgisini, ayrıca `history` ve `tool-results` satırlarını içerir.

## 8. Compaction `summary-v1` (ADR-11)

- Tetikler: `threshold` (bütçe aşımı), `overflow` (son model isteği `context_overflow` ile başarısız olduysa, eşiğin altında bile), `manual` (compactor doğrudan çağrılabilir).
- Sondan geriye `keepRecentTokens` (varsayılan 20k) kadar mesaj korunur; tool sonucu korunmuş bölgenin başına denk gelmez. Öncesi `Summarizer` ile özetlenir (varsayılan model gerektirmeyen `extractiveSummarizer`; üretimde model tabanlı summarizer enjekte edilir) ve özet `summary-v1` JSON blob'u olarak saklanır (`from_seq`, `to_seq`, `first_kept_seq`, açık işler, kararlar, dosyalar, belirsizlikler, "kanıt değildir" notu).
- Yalnız `context/compacted` olayı eklenir; hiçbir olay silinmez veya değiştirilmez. Sonraki istek `sistem + özet bloğu + first_kept_seq sonrası`dır ve deterministik olarak yeniden kurulur.
- Thrash: son compaction'dan bu yana üçten az `step/started` ve hiç başarılı tool sonucu yokken ikinci compaction gerekiyorsa `compaction-thrash` döner.
- Writer bulunamazsa compaction yapılmaz ve bağlam sessizce kesilmez; `context-overflow` raporlanır.

## 9. Bütçe (ADR-14)

`createBudgetTracker` metrikleri: `cost_usd` (provider usage `cost_usd_estimate`), `wall_time_seconds`, `steps` (kabul edilen model isteği sayısı), `tool_calls`. Run limitleri istek ve plan bütçesinin küçüğüdür; `max_steps` plandan gelir.

- Limitte `admit()` reddeder, adım sayılmaz, `budget/exceeded { action: stop-new-requests }` bir kez yazılır; coordinator yeni attempt başlatmaz, bekleyen görevleri `cancelled` yapar, run exit 9 ile biter.
- Ölçülü limitlerin %120'sinde veya wall-time limitinde `cancel-active` yazılır ve WorkerManager aktif attempt'leri iptal eder.
- Artış yalnız `requestBudgetIncrease` ile ve yalnız bu limitler için `decided_by: user` izinli karar varsa uygulanır; orchestrator, config veya broker kararı ya da headless `unavailable` limiti değiştirmez.
- `BudgetGateSlot` coordinator'ın o anki run izleyicisini ContextBuilder'a bağlar.

## 10. Orchestrator yazma sınırı (AC-8)

`ControlPlaneWriter.write(path, content)` her yazımı `NormalizedAction` (`control_plane_write`, `workspace-write`) olarak `PolicyEngine.evaluate`'e sorar **ve** motordan bağımsız yerel kuralı uygular: yol güvenli ve `.ai/tasks/` altında olmalı, rezerve segment içermemeli, realpath `.ai/tasks` dışına (symlink/junction) çıkmamalı. Motor izin verse bile ürün dosyası yazımı `policy_denied` (exit 6) ile reddedilir. Writer yalnız `role: orchestrator` politikasıyla kurulabilir.

## 11. Kabul ölçütü → test

| AC | Testler |
| --- | --- |
| AC-1 | `harness-orchestration-scheduler`: plan reddi (`two unordered writers`), `the scheduler never starts overlapping owners together…`, limitler, çevrim, `the coordinator rejects an overlapping plan…`, `two dependent writers on the same path run strictly one after the other (Faz 2 gate)` |
| AC-2 | `harness-orchestration-review`: `the reviewer never sees the implementer transcript…`, `a reviewer that only cites worker evidence cannot accept…`, `…passing off the implementer's tool call…`, `mayComplete…`, `revise sends a delta packet…`; `harness-context-builder`: `history keeps only this role's conversation…` |
| AC-3 | `harness-orchestration-review`: `a criterion without resolvable evidence yields revise…`, `changed paths outside the owned scope are rejected…`, `a review that leaves a criterion unassessed…`, `evidence must resolve…`, `an attempt that omits evidence is sent back…` |
| AC-4 | `harness-orchestration-freshness` (dispatch durdurma, eksik kaynak, çalışma sırasında `needs_context`, owned istisnası, yeniden paketleme, coordinator akışı); `harness-context-builder`: `a stale packet source stops the build…` |
| AC-5 | `harness-orchestration-review`: `a retry is a new attempt and the failed attempt and its evidence stay in the log`, `retries stop at the limit…` |
| AC-6 | `harness-orchestration-budget` (limitte durma, %120 iptal, wall-time, insan onayı, ContextBuilder reddi, çalışan attempt'in iptali, run exit 9) |
| AC-7 | `harness-context-compaction` (olay silinmez + replay, thrash, thrash algısı, overflow tetik, özet kanıt değildir, writer yoksa overflow) |
| AC-8 | `harness-orchestration-control-plane` (policy reddi, motordan bağımsız koruma, symlink kaçışı, orchestrator write_scope'u) |
| ADR-07 | `harness-orchestration-isolation` (worktree yolu, yanlış digest reddi, owned dışı reddi, untracked koruma, scoped-dir geri dönüş ve revert, high-risk reddi, read-only, seed) |
| ADR-10 | `harness-orchestration-review`: `an rca-only debugger gets no write scope…` |
| Geçişler | Uçtan uca testlerde `replayTransitions(events)` boş: her `*_state_changed` projeksiyondaki durumdan başlar ve `validateTransition`'dan geçer. |

## 12. Sapmalar ve bilinen sınırlar

- **Rapor kanalı.** Worker/reviewer/planner çıktısı `task_report`/`review_report`/`plan_propose` araç çağrılarından okunur. JSON bloğu yalnız başarılı rapor çağrısı yoksa geri dönüştür; güvenlidir çünkü aynı sözleşme şemasıyla ayrıştırılır ve iddia hiçbir kimlik, diff veya yetki taşımaz, her kanıt işaretçisi günlüğe karşı doğrulanır. Model tarafında araç her zaman görünür olduğu için geri dönüş zamanla kaldırılabilir.
- **Delta packet.** Driver ve ContextBuilder yalnız tam packet alır; delta, yetki alanlarına dokunmadan `applyDelta` ile etkin tam packet'e uygulanır (notlar ve kanıt işaretçileri `decisions`'a). Delta ayrıca `task/packet_issued kind: delta` olarak kaydedilir.
- **Plan reviewer görevleri** read-only worker olarak çalışır ve kendileri review gerektirmez; zorunlu review her `standard`/`high-risk` görev için otomatik açılır.
- **Resume.** `resumeSessionId` verilince yeni run aynı session'a eklenir; günlükten görev durumunu geri yükleyen resume yok.
- **Digest kuralları.** Packet kaynakları `digestText` (LF), artifact ve `file` kanıtı ham `sha256` kullanır.
- **Maliyet.** Git dışı scoped-dir ağacın tamamını (`.git`, `.synorch`, `node_modules` hariç) iki kez okur; büyük depolarda pahalıdır. Worktree oluşturma + kaldırma, bu Windows makinesinde küçük test depolarında yaklaşık 0,3–0,6 s sürdü; büyük depolar ve `node_modules` kurulumu ölçülmedi.
- **Token tahmini** sağlayıcıdan bağımsız kaba bir tahmindir; gerçek kullanım `provider/usage`'dan gelir.

## 13. Sözleşme değişiklik istekleri (Dalga 2a sonucu)

Hepsi kabul edildi ve uygulandı ([runtime-seams.md](../contracts/runtime-seams.md)).

| # | Alan | Karar |
| --- | --- | --- |
| 1 | `ContextBuildInput.attemptId` | **Çözüldü:** zorunlu alan (`AttemptId \| undefined`); history `attempt_id`'si farklı olayları yabancı sayar; `requestId` artık `RequestId`. |
| 2 | `ContextBuildResult.reason: "budget-exceeded"` | **Çözüldü:** ContextBuilder `HarnessError` fırlatmak yerine `{ok: false, reason: "budget-exceeded", detail}` döner; driver turu `budget_exceeded` bitirir. |
| 3 | `WorkerManager.dispatch(…, options?)` ve `dispatchReview` | **Çözüldü:** `DispatchOptions`, `ReviewHandle`, `ReviewOutcome` sözleşmede; yerel `DispatchOptions`/`ReviewResult`/`ReviewHandle` silindi. |
| 4 | `IsolationProvider.create(…, options?: { readRoot })` | **Çözüldü:** `IsolationCreateOptions`; yerel `CreateOptions` silindi. |
| 5 | `task_report` / `plan_propose` araçları | **Çözüldü (uyarlandı):** üç araç — reviewer için ayrı `review_report` (rol başına ayrı şema, JSON Schema `oneOf` gerektirmez). Şemalar `packets.ts`'te, araçlar I3 kaydında (callback opsiyonel), I4 `readClaim`/`latestReport` ile attempt günlüğünden okur. JSON bloğu geri dönüş olarak kaldı (§12). |
| 6 | `task/integrated` olayı | **Çözüldü:** yeni tip (v1); `WorkerManager.integrate` başarıdan sonra yazar. |
| 7 | `attempt/started.session_id` | **Çözüldü:** `attempt/started` v2. |
| 8 | `ContextBlockReport.source` enum | **Çözüldü:** `ContextBlockSource` (`CONTEXT_BLOCK_SOURCES`); I1 cast'i kaldırıldı. |

Ek: I4'ün üçüncü glob eşleştiricisi (`paths.ts` içindeki regex dönüştürücü) sözleşmedeki `matchesPathPattern`'e bağlandı; `src/**` artık `src`'nin kendisini de kapsar ve `[...]`/`{a,b}` desteklenir.
