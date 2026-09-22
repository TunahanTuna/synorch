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
