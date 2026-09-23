# Faz I uygulama planı: iş akışları, dosya sahipliği ve entegrasyon

> Durum: `accepted` plan, 2026-09-22. Taban: `harness` dalı. Önkoşul: Faz 0 çıkış kapısı (bu belgeyle birlikte teslim edilen `src/harness/contracts/**`, [sözleşmeler](./contracts/README.md), [ADR'ler](./decisions/README.md), `tests/harness-contracts.test.ts`, `tests/harness-boundary.test.ts`). İzlenebilirlik: [requirements-traceability.md](./foundation/requirements-traceability.md).

## 1. Çalışma kuralları

1. **Sözleşmeler donmuştur.** `src/harness/contracts/**` ve `docs/harness/contracts/**` yalnız entegrasyon sahibinindir (orchestrator). Bir iş akışı sözleşme değişikliğine ihtiyaç duyarsa kendi kodunda geçici tip uydurmaz; completion packet'ta **sözleşme değişiklik isteği** (alan, gerekçe, etkilenen iş akışları) bildirir. Entegrasyon sahibi değişikliği şema + örnek + test ile tek commit'te yapar, bağımlı iş akışlarına delta packet gönderir.
2. **Tek yazma sahibi.** Aşağıdaki `owned_paths` kümeleri ayrıktır. Başka bir iş akışının dosyasına yazmak yasaktır; okuma serbesttir.
3. **Bağımlılık yönü.** Her modül yalnız `../contracts/index.ts` (ve `src/domain/**`, `zod`, `node:*`) import eder; kardeş modülleri yalnız `cli` birleştirir. `tests/harness-boundary.test.ts` her `pnpm check`'te bunu zorlar.
4. **Yeni runtime bağımlılığı yok**, şu istisnalar dışında: I5 `@earendil-works/pi-tui@0.87.0` (tam pin) ve devDependency `@xterm/headless`; I2 keychain kütüphanesi veya `@anthropic-ai/claude-agent-sdk` ancak ADR-05 alt kararı kapanınca ve entegrasyon sahibinin onayıyla. `package.json`/`pnpm-lock.yaml` I5'e aittir; diğerleri istek bildirir.
5. **Test adlandırma:** her iş akışı yalnız kendi `tests/harness-<ad>-*.test.ts` dosyalarını yazar. Test doubles (in-memory store, scripted adapter) iş akışının kendi test dosyasında veya kendi `src/harness/<modül>/testing.ts` dosyasında yaşar.
6. **Kapı:** her iş akışı teslimden önce `pnpm check` çalıştırır; mevcut testler değişmeden yeşil kalır. Completion packet [task-packets.md](./contracts/task-packets.md) biçimindedir; her kabul ölçütü bir test adına bağlanır.
7. Ürün kodu yorum yoğunluğu mevcut koda uyar: dışa açık arayüzde kısa JSDoc, satır içi yorum yok.

## 2. İş akışları

### I1 — core + store

| | |
| --- | --- |
| **owned_paths** | `src/harness/core/**`, `src/harness/store/**`, `tests/harness-core-*.test.ts`, `tests/harness-store-*.test.ts`, `docs/harness/reference/core-and-store.md` |
| **read_paths** | `src/harness/contracts/**`, `docs/harness/contracts/{identity-and-state,events-and-storage,model-adapter,tools}.md`, `docs/harness/research/tui/pi-agent-patterns.md` |
| **Bağımlılık** | Yalnız contracts |
| **Sağladığı fabrikalar** | `createSessionStore(home): SessionStore`, `createBlobStore(home): BlobStore`, `createAgentDriver(deps: AgentDriverDependencies): AgentDriver`, `projectSession(events): SessionProjection`, `recoverSession(store): Promise<RecoveryReport>` |

Kapsam: segmentli JSONL (`session.json`, `lock.json`, `segments/NNNNNN.jsonl`), `fsync`'li append, 8 MiB rotasyon, torn-tail karantinası, lease (O_EXCL + heartbeat + token), fork (`parent.up_to_seq`), içerik adresli blob store (atomik yazma, okumada digest doğrulama), `parseSessionEvent` tabanlı okuyucu, state projection (her geçişi `validateTransition` ile doğrular), crash recovery (`RECOVERY_STATE`, `session/resumed`, `tool/interrupted`), sabit agent loop (turn/step, ContextBuilder → `model/request_prepared` blob → adapter stream → `message/recorded` → tool çağrılarını `ToolGateway.invoke` ile kaynak sırasıyla → steer kuyruğu → `turn/ended`), iptal (AbortSignal zinciri), `AgentBackendAdapter` turlarının aynı olaylara kaydı.

Kabul ölçütleri:
- AC-1 Append edilen olaylar yoğun `seq` ile geri okunur; ikinci yazıcı `session_locked` alır; süresi dolmuş lease devralınır.
- AC-2 Yarım son satır `torn-tail` olarak raporlanır ve karantinaya alınır; ortadaki bozuk satır `session_corrupt`.
- AC-3 Bilinmeyen tip/sürüm `unsupported` ile oturumu salt okunur açar.
- AC-4 `tool/execution_started` sonrası crash → resume'da `tool/interrupted {outcome: unknown}`, çağrı tekrar edilmez (Faz 1 çıkış kapısı).
- AC-5 Aynı log'dan model isteği envelope'u bayt bayt yeniden kurulur (`envelope_digest` eşleşir).
- AC-6 İptal edilen stream `step/ended {state: aborted}` + `model/response_failed{cancelled}` üretir, asla `settled` değil.
- AC-7 Append reddedilince yeni tool çağrısı başlamaz.
- AC-8 Blob digest uyuşmazlığı veri döndürmez.
- Windows'ta dosya kilidi/rename ve `fsync` davranışı CI matrisinde (`windows-latest`, `ubuntu-latest`, `macos-latest`) geçer.

### I2 — providers + auth (+ `syn login/logout/auth status`)

| | |
| --- | --- |
| **owned_paths** | `src/harness/providers/**`, `src/harness/auth/**`, `tests/harness-providers-*.test.ts`, `tests/harness-auth-*.test.ts`, `tests/fixtures/providers/**`, `docs/harness/reference/providers-and-auth.md` |
| **read_paths** | contracts, `docs/harness/contracts/model-adapter.md`, `docs/harness/research/provider-auth/**`, `docs/harness/decisions/ADR-05-provider-auth.md` |
| **Bağımlılık** | Yalnız contracts |
| **Sağladığı fabrikalar** | `createCredentialStore(home): CredentialStore`, `createAuthProviders(store): readonly AuthProvider[]`, `createModelRouter(config, providers): ModelRouter`, `createScriptedAdapter(script): ModelAdapter` (test/e2e için), `authCommand: CommandHandler` (`login`, `logout`, `auth status`) |

Kapsam (ADR-05 önceliği):
- **P0** `openai-chatgpt` ModelAdapter + `oauth-subscription` AuthProvider: PKCE loopback `localhost:1455`, meşgulse/`--device-code` ile device-code, `originator: synorch`, Responses SSE, `store: false`, tam geçmiş yeniden gönderimi (encrypted reasoning `thinking.opaque`), `x-codex-*` kota header'ları → `quota` olayı, `usage_limit_reached` → `quota_exhausted`, `missing_codex_entitlement` → `entitlement_missing`.
- **P0** `openai-responses` (API key, aynı Responses kodu) ve `anthropic-messages` (API key, Messages SSE).
- **P1** `claude-code` AgentBackendAdapter (`cli-bridge`, deneysel bayrak + tek seferlik `claude-bridge-experimental` bildirimi): önce `claude -p --input-format stream-json --output-format stream-json` (bağımlılıksız); Agent SDK ancak bağımlılık onayıyla. `BRIDGE_STRIPPED_ENV` temizliği, `--tools ""`, `--strict-mcp-config`, Synorch MCP sunucusu (ToolBridge → ToolGateway), `backend_init.tools` doğrulaması, SIGINT → SIGTERM iptali, `apiKeySource` → `auth_source`.
- **P2** `codex-app-server` yalnız arayüz iskeleti (uygulama yok).
- CredentialStore: OS keychain (alt karar: kütüphane veya OS CLI'ları) → yoksa `~/.synorch/credentials.json` `0600` + `plaintext-credential-file` bildirimi; `withRefreshLock` (süreçler arası dosya kilidi + tek uçuş). `FORBIDDEN_CREDENTIAL_SOURCES` hiçbir kod yolunda açılmaz.
- Router: tier → route çözümü (`session > project > workspace > user > provider-default`), capability probe, reviewer için bağımsız model tercihi, **sessiz fallback yok** (fallback yalnız insan onaylı `provider-change` ile).
- `health`/`probe` ücretli istek göndermez (`doctor --runtime`); `--probe-model` ayrı.

Kabul ölçütleri:
- AC-1 Kayıtlı SSE fixture'ları (gerçek hesap yok) her adapter için `ModelStreamEvent` dilbilgisine uyan olay dizisi üretir; stream hiçbir durumda throw etmez.
- AC-2 Abort → `error{cancelled}` + `partial`; 429 `retry_after` → `rate_limited{retry_after_ms}`; 401 refresh sonrası → `auth_expired`.
- AC-3 Süresi dolmuş access token profil kilidi altında bir kez refresh edilir; eşzamanlı iki `resolve` tek refresh yapar; kalıcı hata `login_required`.
- AC-4 `ResolvedCredential` JSON'a `"[redacted]"` olarak serileşir; token hiçbir event/log fixture'ında görünmez (grep testi).
- AC-5 Köprü: `ANTHROPIC_API_KEY` set iken alt süreç env'inde yok; `backend_init.tools` içinde yerleşik araç varsa `protocol_mismatch`; MCP araç çağrısı `ToolBridge.call` üzerinden gateway'e gider (sahte `claude` ikilisiyle fixture testi).
- AC-6 Router kota bitince route değiştirmez; `quota_exhausted` hatası ve `provider-change` onay isteği üretir.
- AC-7 `syn auth status --json` `AuthStatus[]` şemasına uyar ve secret içermez; headless `syn login` exit 7.

### I3 — tools + policy + sandbox

| | |
| --- | --- |
| **owned_paths** | `src/harness/tools/**`, `src/harness/policy/**`, `tests/harness-tools-*.test.ts`, `tests/harness-policy-*.test.ts`, `tests/fixtures/sandbox/**`, `docs/harness/reference/tools-and-policy.md` |
| **read_paths** | contracts, `docs/harness/contracts/{tools,policy-and-approval}.md`, `docs/harness/design/tools-and-security.md`, `src/domain/relative-path.ts`, `src/application/safe-path.ts` |
| **Bağımlılık** | Yalnız contracts (+ `src/domain`) |
| **Sağladığı fabrikalar** | `createPolicyEngine(): PolicyEngine`, `createToolRegistry(): ToolRegistry` (v1 yerleşik araçlarla), `createToolGateway(deps: {events, blobs, registry, policy, approvals, sandbox}): ToolGateway`, `probeSandbox(): Promise<SandboxReport>`, `createSandboxRunner(report): SandboxRunner`, `createHeadlessApprovalBroker(): ApprovalBroker`, `explainPermission(action, policy): PolicyDecision` |

Kapsam: policy kesişimi ve `EffectivePolicy` üretimi; `autonomous`/`ask` matrisi; hard rail'ler ve yıkıcı komut sınıflandırması (veri tablosu, Windows/PowerShell/cmd biçimleri dahil); `NormalizedAction` (realpath + junction + case çözümü, eylem anında); gateway hattı ve `tool/*` olay yazımı; bounded output + blob; redaksiyon (credential `redactionValues` + desen); yerleşik araçlar (`read_file`, `search`, `list_dir`, `git_status`, `git_diff`, `apply_patch`, `write_file`, `exec`, `ask_user`; `task_spawn`/`task_status`/`memory_propose` yalnız tanım + gateway kaydı, davranışı I4/I6 callback'iyle); sandbox backend probe'ları (bubblewrap, sandbox-exec, Windows policy-only), child process yönetimi (argv, pipe stdio, env allowlist, timeout, iptal ağacı).

Kabul ölçütleri:
- AC-1 Symlink, junction (Windows), `..`, mutlak yol, UNC, büyük/küçük harf farkı, hard link ve TOCTOU (kontrol-kullanım arası değiştirme) senaryolarında owned dışı yazım `write-outside-scope` ile reddedilir.
- AC-2 Explorer/reviewer shell veya patch ile yazamaz (policy + gateway).
- AC-3 Yıkıcı komut tablosundaki her örnek `destructive-command` alır; `autonomous` modda bile.
- AC-4 `autonomous` modda allowlist dışı `external-write` deny, `ask` modda ask; headless broker `unavailable` → eylem çalışmaz.
- AC-5 Onay yalnız aynı `action_digest` için geçerli; argüman değişince yeniden karar.
- AC-6 Sandbox `partial` iken `require_full_sandbox` görevi `sandbox_insufficient` alır; rapor olaylara yazılır.
- AC-7 16 KiB üstü çıktı blob'a gider; secret içeren çıktı redakte edilir ve `redactions > 0`.
- AC-8 İptal edilen `exec` child ağacını sonlandırır (Windows dahil) ve `cancelled` sonuç verir.

### I4 — orchestration + context

| | |
| --- | --- |
| **owned_paths** | `src/harness/orchestration/**`, `src/harness/context/**`, `tests/harness-orchestration-*.test.ts`, `tests/harness-context-*.test.ts`, `docs/harness/reference/orchestration-and-context.md` |
| **read_paths** | contracts, `docs/harness/contracts/{task-packets,identity-and-state,policy-and-approval,memory}.md`, `docs/AI-ORCHESTRATION-ARCHITECTURE.md` §6–11 |
| **Bağımlılık** | Yalnız contracts (testlerde kendi in-memory fake'leri) |
| **Sağladığı fabrikalar** | `createCoordinator(deps): Coordinator`, `createWorkerManager(deps): WorkerManager`, `createIsolationProvider(deps): IsolationProvider`, `createContextBuilder(deps): ContextBuilder` |

Kapsam: orchestrator rolü (yalnız plan/packet/delegasyon; ürün dosyası yazmaz — policy ile), plan üretimi ve doğrulama (`planSchema`), `autonomous` modda orchestrator plan onayı (`approval/decided decided_by: orchestrator`), `ask` modda kullanıcı onayı, DAG scheduler (global/provider/workspace eşzamanlılık limiti; kesişen ownership seri), packet derleme ve freshness kapısı, worker attempt yaşam döngüsü, izolasyon (ADR-07: git worktree `~/.synorch/worktrees/<project-id>/<attempt-id>`, çakışan kirli değişiklikte scoped-dir, integrate adımı), completion doğrulaması (changed ⊆ owned, AC → kanıt), bağımsız review görevi (ayrı context, sabit artifact, farklı model tercihi; `trivial` dışı zorunlu), revise → delta packet, retry = yeni attempt, bütçe (ADR-14), final rapor; ContextBuilder (güven sırasıyla bloklar, skill kataloğu, packet, hafıza `untrusted`, history son compaction'dan sonra, token bütçesi, `context` raporu), compaction `summary-v1` ve thrash algısı.

Kabul ölçütleri:
- AC-1 İki worker aynı path'e aynı anda yazamaz (plan reddi + scheduler seri) (Faz 2 çıkış kapısı).
- AC-2 Reviewer implementer transkriptini görmez; `met` hükümleri reviewer kanıtı içerir; `accept` olmadan standart görev `completed` olmaz.
- AC-3 Her kabul ölçütü bir kanıt kimliğine bağlanır; kanıtsız ölçüt `revise`.
- AC-4 Kaynak digest değişince dispatch durur (`context/source_changed`), worker `needs_context` ile döner.
- AC-5 Retry önceki attempt ve kanıtı korur; yeni `AttemptId`.
- AC-6 Bütçe sınırında yeni istek başlamaz; %120'de aktif istek iptal edilir; bütçe artışı insan onayı ister.
- AC-7 Compaction orijinal olayları silmez; özet kanıt yerine sayılmaz; thrash → `compaction-thrash` hatası.
- AC-8 Orchestrator ürün dosyasına yazmaya çalışırsa policy deny (`.ai/tasks/**` dışı).

### I5 — tui + cli (`syn agent/run/runs/show`, `doctor --runtime`, JSONL)

| | |
| --- | --- |
| **owned_paths** | `src/harness/tui/**`, `src/harness/cli/**`, `src/cli.ts`, `package.json`, `pnpm-lock.yaml`, `tests/harness-cli-*.test.ts`, `tests/harness-tui-*.test.ts`, `tests/harness-e2e-*.test.ts`, `tests/cli-legacy-snapshot.test.ts`, `tests/fixtures/cli/**`, `docs/harness/reference/cli.md` |
| **read_paths** | contracts, `docs/harness/contracts/cli-and-jsonl.md`, `docs/harness/research/tui/**`, `docs/harness/design/cli-experience.md` |
| **Bağımlılık** | Aşama A: yalnız contracts. Aşama B: I1, I2, I3, I4, I6 fabrikaları (entegrasyon) |

Aşama A (paralel): `PlainLineRenderer`, `JsonlRenderer` (stdout koruması, LF-only, frame `seq`, tek terminal frame), `PiTuiRenderer` (yalnız `src/harness/tui/pi-tui-renderer.ts` pi-tui import eder; editor, stream markdown, tool kartları, onay diyaloğu, `AuthInteraction`), `selectRendererKind`/`selectColor` kullanımı, terminal geri yükleme, Ctrl+C/Esc iptal semantiği, argüman ayrıştırma ve `src/cli.ts`'e **yalnız** `HARNESS_COMMANDS` için literal dinamik import, legacy snapshot testi.
Aşama B (entegrasyon): `createRuntime()` composition root, `syn agent/run/runs/show`, `doctor --runtime` (I1/I2/I3 probe'larını birleştirir, ücretli istek yok), `authCommand` ve `memoryCommand` bağlama, scripted adapter ile uçtan uca senaryolar.

Kabul ölçütleri:
- AC-1 `syn inspect/init/sync/doctor` çıktıları ve exit code'ları değişmeden kalır (snapshot, `tests/cli-legacy-snapshot.test.ts`); boundary testi yeşil.
- AC-2 Non-TTY/pipe/`TERM=dumb`/`--plain` → plain; `--mode jsonl` → stdout'ta yalnız geçerli frame'ler (`validateFrameSequence` boş).
- AC-3 Headless onay gerektiren durum → `error` frame, exit 3; kullanıcı iptali → 130; kilitli session → 8.
- AC-4 pi-tui renderer `@xterm/headless` sanal terminalde stream + resize + tool kartı render eder; [çapraz platform listesi](./research/tui/cross-platform-checklist.md) P0 maddeleri manuel matriste işaretlenir.
- AC-5 Uçtan uca: scripted adapter ile "trivial belge düzeltmesi" ve "standart kod değişikliği" senaryoları ([verification.md](./delivery/verification.md) Seviye 3) geçer.
- AC-6 `doctor --runtime --json` sandbox enforcement, store sağlığı, auth durumu ve capability'leri ayrı sonuçlarla verir; ağ isteği yapmaz (fake fetch ile doğrulanır).

### I6 — memory (+ `syn memory ...`)

| | |
| --- | --- |
| **owned_paths** | `src/harness/memory/**`, `tests/harness-memory-*.test.ts`, `tests/fixtures/memory/**`, `docs/harness/reference/memory.md` |
| **read_paths** | contracts, `docs/harness/contracts/memory.md`, `docs/harness/obsidian/README.md`, `src/infrastructure/frontmatter.ts` |
| **Bağımlılık** | Yalnız contracts (+ `yaml`) |
| **Sağladığı fabrikalar** | `createMemoryStore(root): MemoryStore`, `resolveMemoryRoot(config, projectId, home): string`, `memoryCommand: CommandHandler` |

Kapsam: kök çözümü (ADR-16), not okuma/yazma (frontmatter doğrulama, atomik yazma, `expectedDigest` çakışması), auto-persist türleri, öneri kuyruğu (`queue/*.yaml`), karar uygulama (kullanıcı/orchestrator, audit olayı için dönen bilgi), tam metin + bağlantı indeksi (`.index/`, yeniden kurulabilir), stale tespiti (`source_digest`), kural tabanlı ilişki/çelişki adayları (aynı id/path), `syn memory status|search|show|related|review|accept|reject|open|reindex` (`open --in obsidian` yalnız URI; Obsidian yoksa CLI gösterir).

Kabul ölçütleri:
- AC-1 Obsidian kurulu değilken yazma/arama/gösterme çalışır.
- AC-2 Kullanıcı notu dışarıdan değiştirirse sonraki yazma çakışma döner, içerik ezilmez.
- AC-3 decision/preference doğrudan yazılamaz; kuyruktan kabulde `reviewed_at` dolar; orchestrator kararı `run_id` taşır.
- AC-4 İndeks silinse de notlardan yeniden kurulur; kırık bağlantılar raporlanır.
- AC-5 Secret içeren içerik yazılmadan redakte edilir; ham tool çıktısı otomatik saklanmaz.
- AC-6 Başka branch kapsamlı not, farklı branch'teki aramada kesin bilgi olarak dönmez.

### Entegrasyon sahibi (orchestrator)

| | |
| --- | --- |
| **owned_paths** | `src/harness/contracts/**`, `docs/harness/contracts/**`, `docs/harness/decisions/**`, `docs/harness/foundation/**`, `docs/harness/implementation-plan.md`, `docs/harness/delivery/**`, `tests/harness-contracts.test.ts`, `tests/harness-boundary.test.ts` |

Sözleşme değişiklik isteklerini uygular, iş akışı dallarını `harness`'a sırayla entegre eder, her entegrasyondan sonra `pnpm check` ve boundary testini koşar, bağımsız review görevlerini dağıtır.

## 3. Sıra ve paralellik

```text
Dalga 1 (paralel):  I1   I2   I3   I4   I6   I5-A
                     \    |    |    |    |    /
Dalga 2:                   I5-B entegrasyon (createRuntime, e2e)
Dalga 3:             çapraz platform matrisi + bağımsız review + Faz 1/2 çıkış kapıları
```

Dalga 1'deki her iş akışı yalnız contracts'a bağlı olduğundan eşzamanlı başlar; kendi testlerinde diğer seam'lerin in-memory fake'lerini kullanır. Önerilen entegrasyon sırası: I1 → I3 → I2 → I6 → I4 → I5-B (her biri ayrı dal/worktree, `codex/harness-i<N>-<konu>`).

## 4. Entegrasyon seam'leri

| Seam (contracts) | Sağlayan | Tüketen |
| --- | --- | --- |
| `EventStore`, `SessionStore`, `BlobStore` | I1 | I3 (gateway olayları), I4, I5-B |
| `AgentDriver` | I1 | I4 (worker/orchestrator turları) |
| `ModelAdapter`, `AgentBackendAdapter`, `ModelRouter` | I2 | I1 (driver), I4 (route kararı) |
| `AuthProvider`, `CredentialStore`, `authCommand` | I2 | I5 (login komutları, `AuthInteraction` UI'ı) |
| `ToolBridge` | I2 (MCP sunucusu) | I3 gateway'e çağrı yönlendirir |
| `ToolRegistry`, `ToolGateway`, `SandboxRunner` | I3 | I1 (driver), I2 (bridge), I4 (izole exec) |
| `PolicyEngine`, `ApprovalBroker` | I3 (+ I5 etkileşimli broker) | I4, I5 |
| `ContextBuilder` | I4 | I1 (driver) |
| `Coordinator`, `WorkerManager`, `IsolationProvider` | I4 | I5-B |
| `MemoryStore`, `memoryCommand` | I6 | I4 (ContextBuilder recall, memory_propose), I5 |
| `TerminalRenderer` (`approvals`, `auth`, `input`) | I5 | I2 (login UI), I3 (ask modu), I4 (olay akışı) |
| `CommandHandler`, `CommandIO` | I2, I6 | I5 |

Her seam için sağlayan iş akışı bir sözleşme testi (arayüz davranışı), tüketen iş akışı bir fake ile birim testi yazar; I5-B uçtan uca testi gerçek implementasyonları birleştirir.

## 5. Faz kapıları ile eşleme

| Kapı ([roadmap](./delivery/roadmap.md)) | Kanıt |
| --- | --- |
| Faz 0 | `tests/harness-contracts.test.ts` (doküman örnekleri, yetki genişletme retleri, geçiş doğrulayıcı), `tests/harness-boundary.test.ts` |
| Faz 1 | I1 AC-4/5/6, I2 AC-1/2, I3 AC-1/7/8, I5 AC-1/2/6 |
| Faz 2 | I4 AC-1…5, I3 AC-2, I5 AC-5 |
| Faz 3 | I2 AC-6 + ikinci sağlayıcı ile A-implement/B-review e2e |
| Faz 4 | I3 platform matrisi, I1 çift resume/crash, I5 çapraz platform |

## 6. Dalga 2a sonucu (sözleşme entegrasyonu, 2026-09-23)

Dalga 1 iş akışlarının bildirdiği 20 sözleşme değişiklik isteği entegrasyon sahibi tarafından tek commit'te işlendi; sözleşmeler yeniden tek doğruluk kaynağıdır ve modüllerdeki yerel geçici çözümler silindi. Ayrıntı: [runtime-seams.md](./contracts/runtime-seams.md) ve her referans belgenin "Sözleşme değişiklik istekleri" bölümü.

| CCR | Karar |
| --- | --- |
| I1-1 `AgentDriverDependencies.credentials` | Kabul: zorunlu `CredentialResolver(route, signal, options?)`; driver `oauth-subscription` 401'inde tek zorunlu refresh + yeniden gönderim yapar. |
| I1-2 `session/resumed.torn_tail` | Kabul: `session/resumed` v2; `EventStore.quarantinedTail?` sözleşmede. |
| I1-3 `SessionProjection`, `RecoveryReport` | Kabul: `contracts/projection.ts`. |
| I1-4 `attempt/started` ⇒ `running` | Kabul (belge): identity-and-state + runtime-seams. |
| I2-5 zorunlu refresh | Uyarlandı: `resolve(signal, { forceRefresh })`; yenileyebilirlik yöntemden (`oauth-subscription`) anlaşılır. |
| I2-6 router kota/onay yöntemleri + config | Kabul: `ModelRouter` + `RouteBlockedFailure`, `ProviderChangeProposal`, `ModelRouterConfig`, `RouteRule`; config ayrıştırma şeması bilinçli olarak eklenmedi (I5-B). |
| I2-7 `BackendTurnInput.requestId: RequestId` | Kabul. |
| I2-8 `os-dpapi` | Kabul: DPAPI deposu doğru raporlanır. |
| I3-9 kaçan yollar ve denetim | Kabul: `NormalizedAction.escapes?`; `tool/policy_decided` v2; her ret kaydedilir. |
| I3-10 `SandboxRunner.run` sonucu | Kabul: `ProcessResult.termination` + `spawnError` (`timedOut` kaldırıldı). |
| I4-11 `ContextBuildInput.attemptId` | Kabul (+ `requestId: RequestId`). |
| I4-12 `budget-exceeded` | Kabul: ret sonucu, istisna değil; tur `budget_exceeded`. |
| I4-13 `dispatch` seçenekleri + `dispatchReview` | Kabul. |
| I4-14 `readRoot` | Kabul: `IsolationCreateOptions`. |
| I4-15 rapor araçları | Uyarlandı: `task_report` + ayrı `review_report` + `plan_propose`; I3 kaydında, I4 günlükten okur; JSON bloğu güvenli geri dönüş olarak kaldı. |
| I4-16 `task/integrated` | Kabul: yeni olay (v1). |
| I4-17 `attempt/started.session_id` | Kabul: `attempt/started` v2. |
| I4-18 `ContextBlockReport.source` enum | Kabul: `CONTEXT_BLOCK_SOURCES`. |
| I6-19 `decide` audit sonucu | Kabul: `decide → MemoryDecisionOutcome`; `decideWithAudit` silindi. |
| I6-20 `MemoryConfig` | Kabul: `memoryConfigSchema`. |
| Glob eşleştirici | Kabul: üç kopya (I3 ×2, I4) yerine `contracts/paths.ts` içindeki saf eşleştirici. |

Olay sürümleme kuralı uygulandı: yeni alanlar opsiyonel, `EVENT_FIELD_VERSIONS` tablosu tip sürümünü yükseltir, eski sürüm olaylar okunmaya devam eder, eski sürümle damgalanmış yeni alan `invalid`'dir. Kapı: `pnpm check` 507 test, 506 geçti, 1 platform atlaması, 0 hata. Sonraki adım I5-B (composition root, e2e); bilmesi gerekenler runtime-seams.md'de: `credentials` resolver'ı auth sağlayıcılarına bağlamak, rapor araçlarının kayıtta hazır olması (callback gerekmez), `MemoryStore.decide` sonucunu olay olarak yazmak, router yapılandırmasını `ModelRouterConfig`'e çevirmek.

## 7. Canlı çalıştırma sağlamlaştırma dalgası

> Durum: `accepted` plan, 2026-09-23. Taban: `harness` dalında W0 commit'i (`docs(harness): ADR-18..20 and contracts for live-run hardening`). Kararlar: [ADR-18](./decisions/ADR-18-harness-computed-evidence.md) (D1 harness'in hesapladığı kanıt, D2 doğru iş atılmaz, D3 model dostu düzenleme araçları), [ADR-19](./decisions/ADR-19-workspace-fidelity.md) (D4 çalışma alanı sadakati), [ADR-20](./decisions/ADR-20-context-efficiency.md) (D5 verimlilik). Kanıt: iki canlı çalıştırmanın denetimleri — Denetim A (F1–F19, model biçimi ve bağlam boyutu) ve Denetim B (B1–B12, Windows/git ortamı). Kabul ölçütleri bulgu kimliklerine bağlıdır.

### 7.1 W0 — sözleşmeler (tamamlandı)

W0 yalnız sözleşme ekledi; davranış değişmedi, yeni alanların hepsi opsiyoneldir. Özet: `contracts/evidence.ts` (kısa ref `[#n]`, `renderToolResultText`, `parseToolRef`, çözüm yöntemleri ve sırası, `evidenceResolutionSchema`, harness doğrulama/diff kanıtı, `REPAIR_KINDS`, `REPORT_CORRECTION_ROUNDS = 1`, `orchestrationBudgetsSchema`, `formatEvidenceCorrection`); `common.ts` (`harness-verification`, `harness-diff`, üretici `harness`); `digest.ts` (`workspaceDigest`, `SOURCE_DIGEST_SCHEMES`, `ContentIdentity`); `paths.ts` (`normalizePathUnicode`, `foldPathCase`, `CASE_INSENSITIVE_PLATFORMS`; paylaşılan eşleştirici artık bu politikayı uygular); `tools.ts` (`ends_turn`, `ToolResult.digest`, `AttemptFileLedger`, `ToolExecutionContext.ref/files`, `ToolCallOutcome.ref/endsTurn`); `model.ts` (`ModelRequest.cache`); `packets.ts` (completion `harness_evidence`/`evidence_resolution`/`repairs`, review `evidence_resolution`/`repairs`, reviewer için harness kanıtı bağımsız, paket `context.digest_scheme`/`inline_sources`); `events.ts` (`attempt/verification_ran`, `attempt/repair_requested`, `tool/call_proposed` v2, `tool/result_recorded` v2, `attempt/started` v3); `runtime.ts` (`IsolatedWorkspace.digest/reused/fallback/overlaid/dependencyLinks/submodules`, `IsolationCreateOptions.reuse/overlay`, `ContextBuildInput.sources`, `TurnInput.sources`, `WorkspaceDigestReader`). Ayrıntı: [task-packets §8](./contracts/task-packets.md#8-harness-kanıtı-çözümleme-ve-onarım-adr-18), [tools](./contracts/tools.md), [events-and-storage](./contracts/events-and-storage.md), [runtime-seams §7–§10](./contracts/runtime-seams.md).

### 7.2 Çalışma kuralları

§1 kuralları geçerlidir: sözleşmeler donmuştur (eksik görülen alan için sözleşme değişiklik isteği, CCR); `owned_paths` kümeleri ayrıktır; modüller yalnız `contracts` import eder; her iş akışı teslimden önce `pnpm check` çalıştırır (0 hata). Yeni runtime bağımlılığı yoktur. Aşağıda adı geçmeyen dosyalar (ör. `src/harness/memory/**`, `src/harness/tui/**`, `src/harness/store/**`) bu dalgada değişmez.

### 7.3 İş akışları

#### W1a — araçlar: düzenleme, kısa ref, dosya defteri (D3 + `[#n]` ataması)

| | |
| --- | --- |
| **owned_paths** | `src/harness/tools/**` (**hariç** `src/harness/tools/builtin/control-tools.ts`), `src/harness/policy/**`, `tests/harness-tools-*.test.ts`, `tests/harness-policy-*.test.ts`, `tests/harness-security-policy.test.ts`, `tests/fixtures/sandbox/**`, `tests/fixtures/tools/**` (yeni), `docs/harness/reference/tools-and-policy.md` |
| **read_paths** | contracts, `docs/harness/contracts/{tools,runtime-seams,task-packets}.md`, ADR-18/19/20, Denetim A/B |
| **Sağladığı seam'ler** | `ToolCallOutcome.ref` + `tool/call_proposed.ref` (v2), `ToolCallOutcome.endsTurn`, `ToolExecutionContext.ref/files`, `ToolResult.digest` (+ `tool/result_recorded` v2) |

Kabul ölçütleri:
- AC-a1 (F1) Gateway her çağrıya attempt içi (attempt yoksa session içi) 1'den başlayan sıra verir, `tool/call_proposed` v2 `ref` yazar ve `ToolCallOutcome.ref` döner; resume sonrası numaralandırma kayıtlı olaylardan devam eder, bir sayı iki çağrıya verilmez.
- AC-a2 (F11 seam) `endsTurn` yalnız `metadata.ends_turn && state === succeeded && result.status === ok` iken `true`'dur.
- AC-a3 (F5, B2) `read_file` başlık satırı `<path> · digest sha256:<hex> · lines <a>-<b> of <n>` ve `ToolResult.digest` = attempt çalışma alanındaki ham baytların `workspaceDigest`'i; okuma deftere yazılır.
- AC-a4 (F5) `write_file`/`apply_patch` `expected_digest`'i opsiyoneldir, varsayılanı `AttemptFileLedger.lastSeen(path)`; bilinmeyen yolda `invalid_arguments` "read the file first"; `stale_precondition` güncel digest'i ve "re-read and retry" içerir; yazma defteri günceller, aynı dosyada ardışık iki düzenleme yeniden okumadan başarılı olur.
- AC-a5 (F6) `apply_patch`, canlı çalıştırmadaki `*** Begin Patch / *** Update File / @@` metnini aynen uygular; `*** Add File` / `*** Delete File` ve sayısız `@@` başlıklı unified diff bağlamdan konumlanır; hata mesajı kabul edilen biçimleri ve 3 satırlık örneği verir.
- AC-a6 (B5, B6, F17) Karışık EOL dosyasında dokunulmayan satırlar bayt bayt aynı kalır; yalnız CR dosyası yamalanır; BOM korunur ve 1. satır hunk'ı eşleşir; `write_file` LF içeriği CRLF dosyaya CRLF olarak yazar (autocrlf=false fikstüründe `git diff --numstat` yalnız gerçek satırları gösterir — Denetim B fikstür 6–7).
- AC-a7 (B4) Geçerli UTF-8 olmayan (cp1254) dosyaya `apply_patch`/`write_file` `invalid_arguments` ile reddedilir; dosya baytları değişmez.
- AC-a8 (F18) `read_file` ve `exec` modele en çok 32 KiB (baş + son) gösterir; tamamı blob'ta, metinde "truncated; use offset/limit" notu.
- AC-a9 (B11) Araç ve policy yol karşılaştırmaları `normalizePathUnicode`/`foldPathCase`/`isCaseInsensitivePlatform` kullanır (kendi `toLowerCase`'leri kalmaz); NFD oluşturulmuş dosya NFC owned path ile yazılabilir; owned `readme.md` ile diskteki `Readme.md` win32/darwin'de `write_file` ve izolasyonda aynı sonucu verir (Denetim B fikstür 10'un araç kısmı).

#### W1b — izolasyon ve git: tek digest, integrate, overlay, dayanıklılık (D4)

| | |
| --- | --- |
| **owned_paths** | `src/harness/orchestration/isolation.ts`, `src/harness/orchestration/git.ts`, `src/harness/orchestration/paths.ts`, `src/harness/orchestration/workspace-digest.ts` (yeni), `tests/harness-orchestration-isolation*.test.ts`, `tests/harness-security-isolation.test.ts`, `tests/fixtures/git/**` (yeni) |
| **read_paths** | contracts, `docs/harness/contracts/{runtime-seams,events-and-storage}.md`, ADR-07, ADR-19, Denetim B (repro betikleri `k1.mjs`, `s2.mjs`…`s8.mjs`) |
| **Sağladığı seam'ler** | `createWorkspaceDigestReader(root): WorkspaceDigestReader` ve `contentIdentity(root, path, signal): Promise<ContentIdentity \| undefined>` (`workspace-digest.ts`); `IsolatedWorkspace.digest/reused/fallback/overlaid/dependencyLinks/submodules`; `IsolationCreateOptions.reuse/overlay` davranışı |

Kabul ölçütleri:
- AC-b1 (B1) Integrate çakışmayı `ContentIdentity` ile saptar ve içeriği ana ağacın EOL/filtre gösterimine çevirir: autocrlf=true + CRLF ana ağaç, autocrlf=input + CRLF dosya, `.gitattributes eol=crlf|lf`, smudge/clean filtresi ve Git LFS (yoksa atlanır) fikstürlerinde kullanıcının dokunmadığı dosya için çakışma yoktur ve ana ağaç EOL'u korunur (Denetim B fikstür 1, 3, 4).
- AC-b2 (K1, B2, F4) `IsolatedWorkspace.digest` her modda vardır ve worktree'de `read_file`'ın bildirdiği digest'le aynıdır; autocrlf=true + LF blob + LF ana ağaç fikstüründe attempt kökünde hesaplanan digest worktree baytlarına eşittir (fikstür 2).
- AC-b3 (B3) `overlay` listesindeki kirli/izlenmeyen yollar worktree'ye kopyalanır, tabanda `ours` olarak işaretlenir, `changedPaths`'e ve integrate'e girmez, `overlaid` raporlanır; ignore edilen ve ana ağaçta var olan `DEPENDENCY_LINK_DIRECTORIES` owned path ile örtüşmüyorsa bağlanır ve `dependencyLinks` raporlanır; owned path asla overlay/bağlantı olmaz (fikstür 5).
- AC-b4 (B7) `worktree add` `core.longpaths=true` ile çalışır, worktree yolu kısalır; oluşturma hatası `HarnessError`'a çevrilir, `high-risk` olmayan görev `scoped-dir`'e düşer ve `fallback{from, reason, detail}` dolar, `high-risk` yazan görev `sandbox_insufficient` alır; hiçbir durumda öksüz worktree veya `<attempt>.owner.json` kalmaz (fikstür 8).
- AC-b5 (B8) Gitlink'ler (mode 160000) `submodules` olarak raporlanır; submodule içindeki owned path `create`'te açık hatayla reddedilir; değişiklik adayları owned path'lerin doğrudan taranmasıyla da toplanır, iş sessizce kaybolmaz (fikstür 9).
- AC-b6 (B9) `reuse` verilince yeni worktree açılmaz: tabana sıfırlanır (`checkout -f --detach` + `clean`), `reused: true`; scoped snapshot owned path dışındaki ignore edilmiş dizinleri gezmez; 20k dosyalı depoda retry'da worktree yeniden kullanımı ve `.venv` atlayan snapshot bir süre sınırı içinde kalır (fikstür 11).
- AC-b7 (B11) `orchestration/paths.ts` `normalizeWorkspacePath` NFC uygular; `findScopeViolations` win32/darwin'de `foldPathCase` ile karşılaştırır (fikstür 10'un izolasyon kısmı).

#### W1c — kanıt, doğrulama ve akış (D1 + D2, D4 sıralaması)

| | |
| --- | --- |
| **owned_paths** | `src/harness/orchestration/{evidence,claims,coordinator,worker-manager,recorder,attempt-log,plan,planner,delegation,budget,scheduler,capabilities,control-plane,approval,index,factories,testing}.ts`, `src/harness/tools/builtin/control-tools.ts`, `src/harness/cli/runtime.ts` (yalnız composition bağlantısı), `tests/harness-orchestration-*.test.ts` (**hariç** `tests/harness-orchestration-isolation*.test.ts`), `tests/harness-e2e-*.test.ts` (entegrasyon tabanından sonra, bkz. §7.5), `tests/fixtures/live/**` (yeni), `docs/harness/reference/orchestration-and-context.md` |
| **read_paths** | contracts, `docs/harness/contracts/{task-packets,runtime-seams,tools,events-and-storage}.md`, ADR-09, ADR-18, ADR-19, Denetim A, iki canlı çalıştırmanın session/blob'ları |
| **Tükettiği seam'ler** | W1a `ref`/`endsTurn`/`digest`, W1b `workspace-digest.ts` + izolasyon eklemeleri, W1d `createSkillLoadCallback` ve `TurnInput.sources` geçişi |

Kabul ölçütleri:
- AC-c1 (F1, F7, F8) `resolveEvidence` `TOOL_EVIDENCE_RESOLUTION_ORDER` sırasıyla çözer (`functions.`/`mcp__synorch__` öneki atılır, argv örtüşmesi, yol sözcüğü `:L…`/`#L…`/` (…)`/`—` ayıklanır) ve `EvidenceResolution` döner; ikinci canlı çalıştırmanın üç işaretçisi ve birinci çalıştırmanın beş işaretçisi çözülür (kayıttan replay testi).
- AC-c2 (F2) `task_report`/`review_report` callback'leri kanıtı çağrı içinde çözer; çözülmeyende `invalid_arguments` + `formatEvidenceCorrection`, aynı session'da tek düzeltme, sonra rapor olduğu gibi kabul ve `evidence_resolution` kaydı; `ends_turn` rapor araçlarında, `task_triage`'da ve yalnız kabul edilen `plan_propose`'da işaretlidir.
- AC-c3 (F7) Worker turundan sonra harness `verification.commands`'ı attempt çalışma alanında `SandboxRunner` + policy `verification_commands` allowlist'iyle koşar, her biri için `attempt/verification_ran` yazar, completion'a `harness_evidence` ekler; `commands_run` günlükteki `exec` çağrılarından kurulur, modelin çıkış kodu yok sayılır; argv'ye çevrilemeyen komut `not-run` + neden.
- AC-c4 (F3) Yalnız kanıt eksik `revise` ve başarısız harness doğrulaması aynı attempt session'ında, aynı `AttemptId` ve çalışma alanıyla onarılır (`attempt/repair_requested`); bütçeler `orchestrationBudgetsSchema`'dan gelir (`maxRetries`/`maxRevisions` yerine); tükenen bütçe `task_triage` danışmasına gider, doğrudan `failed` olmaz. Replay: ikinci çalıştırma `reviewing → completed`'e ulaşır.
- AC-c5 (F9, ADR-09 değişikliği) `verifyReview` `met` için reviewer veya harness kanıtı ister; düzeltme sonrası çözülmeyen reviewer işaretçisi düşer, bağımsız kanıtsız `met` `unverifiable` → `revise`; `invalid` yalnız bağ ihlallerinde.
- AC-c6 (F10) Triyaj istemi ölçütleri `[resolved]` / `[unresolved: neden]` / `[missing]` gösterir.
- AC-c7 (F4, B2, B3; ADR-19 sırası) Önce izolasyon (aynı görevin retry/onarım/revizyonunda `reuse`; `overlay` = read_paths + alıntılanan kaynaklar), sonra paket kaynakları `workspace.digest` ile (`digest_scheme: workspace-raw-v1`), sonra paket ve `attempt/started` v3; `TurnInput.sources` attempt köküne bağlanır; `dependencyLinks` attempt policy'sinde `forbidden`'a eklenir; ana ağaçtaki `createWorkspaceSourceReader` (digestText) paket kaynakları için kullanılmaz.
- AC-c8 (F13) Görev başı `max_steps` = plan bütçesi / dispatch edilen görev sayısı, alt sınır 25.
- AC-c9 (F19, Denetim A §4 madde 6–7) Delta notları `decisions`'a kopyalanmaz; orchestrator'ın ilk mesajındaki plan şablonu kaldırılır; küçük read_paths dosyaları `context.inline_sources` olarak (dosya ≤ 8 KiB, toplam ≤ 32 KiB) pakete girer.
- AC-c10 `cli/runtime.ts`: rapor callback'leri, varsayılan bütçeler ve W1d'nin `createSkillLoadCallback`'i bağlanır; başka composition değişikliği yapılmaz.

#### W1d — verimlilik: tur sonu, render, önbellek, rol kapsamı (D5)

| | |
| --- | --- |
| **owned_paths** | `src/harness/context/**`, `src/harness/core/driver.ts`, `src/harness/core/testing.ts`, `src/harness/providers/responses.ts`, `src/harness/providers/anthropic-messages.ts`, `tests/harness-context-*.test.ts`, `tests/harness-core-driver.test.ts`, `tests/harness-providers-adapters.test.ts`, `tests/fixtures/providers/**` |
| **read_paths** | contracts, `docs/harness/contracts/{model-adapter,runtime-seams,tools}.md`, ADR-20, Denetim A §4 |
| **Sağladığı seam'ler** | `createSkillLoadCallback(deps)` (`src/harness/context/index.ts`), `TurnInput.sources → ContextBuildInput.sources` geçişi, `ModelRequest.cache` |

Kabul ölçütleri:
- AC-d1 (F11) `endsTurn` sonucu gelince driver aynı batch'teki sonraki çağrıları çalıştırmaz (sentetik "turn ended by <tool>" sonucu), turu yeni model isteği olmadan `completed` bitirir; test istek sayısını sayar.
- AC-d2 (F1) Driver tool sonuçlarını hem model hem backend yolunda yalnız `renderToolResultText(outcome.ref, outcome.result)` ile kaydeder.
- AC-d3 (F16) ContextBuilder `cache = {key: <session_id>:<role>, stable_system_blocks}` doldurur; kararlı bloklar önce ve iki ardışık adımda bayt bayt aynıdır (digest testi); `responses.ts` `prompt_cache_key` gönderir; `anthropic-messages.ts` son kararlı bloktan ve araç listesinden sonra `cache_control` koyar (fikstür).
- AC-d4 (F12) Protokoller role göre seçilir (worker'a orkestrasyon, planlama, delegasyon, model yönlendirme, kullanıcı iletişimi, bağlam devri protokolleri gitmez); rol başına araç alt kümesi; `task_report`/`plan_propose` açıklamaları kısalır; implementer sistem istemi Denetim A §4 ölçümüne göre anlamlı küçülür (test karakter sayısını sabitler).
- AC-d5 (F12) `createSkillLoadCallback` bağlamda olan skill için "already in your context" döner, tekrar yüklemeyi içeriksiz yanıtlar; triyaj turuna skill verilmez.
- AC-d6 (F19, Denetim A §4 madde 5) Paketin model görünümü kompakttır (boş diziler, `expected_report`, modele gereksiz kimlik/digest alanları yok; `inline_sources` dosya blokları olarak); skill tetikleyici eşleştirmesi Türkçe güvenli katlama kullanır.
- AC-d7 (B3) Freshness `ContextBuildInput.sources` verildiğinde onu kullanır; driver `TurnInput.sources`'u aynen geçirir.

### 7.4 Seam'ler

| Seam (contracts) | Sağlayan | Tüketen |
| --- | --- | --- |
| `ToolCallOutcome.ref`, `tool/call_proposed.ref` | W1a | W1d (render), W1c (`#n` çözümü) |
| `ToolMetadata.ends_turn` → `ToolCallOutcome.endsTurn` | W1c (metadata, `control-tools.ts`) + W1a (gateway) | W1d (driver) |
| `AttemptFileLedger`, `ToolResult.digest` | W1a | W1a (araçlar), W1c (değişen yol before/after, isteğe bağlı) |
| `workspace-digest.ts`, `IsolatedWorkspace.*`, `IsolationCreateOptions.reuse/overlay` | W1b | W1c |
| `TurnInput.sources` → `ContextBuildInput.sources` | W1d (geçiş + freshness) | W1c (değer verir) |
| `createSkillLoadCallback` | W1d | W1c (`cli/runtime.ts`) |
| `ModelRequest.cache` | W1d (context) | W1d (providers) |
| `renderToolResultText`, `formatEvidenceCorrection`, `evidenceResolutionSchema`, `orchestrationBudgetsSchema` | contracts (W0) | W1c, W1d |

Her sağlayan kendi testinde seam davranışını, her tüketen bir fake ile kendi birim testini yazar.

### 7.5 Sıra ve entegrasyon

```text
Dalga W1 (paralel, W0 tabanından):  W1a   W1b   W1d        W1c (contracts + fake'lerle başlar)
                                      \     |     /            |
Entegrasyon (sırayla):                W1a → W1b → W1d  ──────→ W1c (birleşik tabana rebase, e2e sahibi)
Dalga W2:                             gerçekçilik testleri (D6)
```

- W1a, W1b, W1d W0 commit'inden dallanır ve kendi dallarında `pnpm check` 0 hatayla teslim eder. Entegrasyon sahibi a → b → d sırasıyla birleştirir; sahipsiz testlerde (özellikle `tests/harness-e2e-*.test.ts`, tool sonucu metni `[#n] ` önekini alır) çıkan doğrulama kaymasını birleştirme sırasında o düzeltir.
- W1c tükettiği seam'leri fake'lerle geliştirir, teslimden önce birleşik tabana rebase eder; e2e testleri o andan itibaren W1c'nindir.
- Sözleşme eksikliği CCR ile entegrasyon sahibine gider; hiçbir W1 contracts'a yazmaz.

### 7.6 W2 — gerçekçilik testleri (D6, sonraki dalga)

- Sloppy-model scripted adapter: `functions.<tool> <args>` işaretçileri, `*** Begin Patch` yamaları, digest'siz yazma, gereksiz `load_skill`, terminal araçtan sonra metin.
- İki canlı çalıştırmanın (run_01M35SSARRMK87VYMT770BNM3X, run_01M35VYXAC79ST06QZBAFGWT1S) transkript replay'i: ikisi de düzeltme turuyla veya turu olmadan `completed`'e ulaşır; istek sayısı ve girdi token'ı ölçülür (ADR-20 hedefi ≈ 40–45k).
- Denetim B'nin 11 Windows/git fikstürü uçtan uca (W1a/W1b birim fikstürleri üzerine).

### 7.7 Kapsam dışı

- F14 (rapor girdisinde gevşek ön işleme) ve F15 (JSON bloğu geri dönüşünü sağlamlaştırma): rapor araçları artık birincil kanal ve düzeltme turu var; ihtiyaç ölçülürse sonraki dalga.
- B12 ve hafıza `source_digest`: hafıza `digestText` kullanmaya devam eder (ADR-19'da belgelendi).
- Triyaj için sıkıştırılmış yeni session (Denetim A §4 madde 8).
