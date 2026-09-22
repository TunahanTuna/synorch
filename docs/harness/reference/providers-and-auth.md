# Sağlayıcılar ve kimlik doğrulama (I2) — başvuru

> Durum: `implemented` (Faz I, I2), 2026-09-22. Sahip: `src/harness/providers/**`, `src/harness/auth/**`. Sözleşmeler: [model-adapter.md](../contracts/model-adapter.md), `src/harness/contracts/{model,auth}.ts`. Karar: [ADR-05](../decisions/ADR-05-provider-auth.md). Teknik dayanak: [research/provider-auth](../research/provider-auth/README.md).

Bu belge I2'nin gerçekte ne yaptığını, hangi varsayımlara dayandığını ve neyin gerçek hesapla henüz doğrulanmadığını anlatır. Kod yalnız `contracts`, `src/domain`, `zod` ve `node:*` import eder; yeni runtime bağımlılığı yoktur (sağlayıcı SDK'sı, keychain kütüphanesi veya MCP SDK'sı kullanılmaz). Ağ erişimi yalnız global `fetch` (Node 24) ile yapılır ve her adapter'a `fetch` enjekte edilebilir.

## 1. Modül haritası

| Dosya | Sorumluluk |
| --- | --- |
| `providers/sse.ts` | Artımlı SSE çözücü (LF/CR/CRLF, çok satırlı `data`, yorum, parçalı UTF-8) |
| `providers/assembler.ts` | Delta'lardan asistan mesajı kurar; `partial()` tamamlanmamış tool çağrısını dışarıda bırakır |
| `providers/http-stream.ts` | Ortak HTTP+SSE hattı: throw etmez, her olayı şemaya karşı doğrular, iptali okuyucuyu keserek uygular |
| `providers/errors.ts` | HTTP ve stream hatalarının `PROVIDER_ERROR_CODES`'a eşlenmesi, `retry-after` ayrıştırma |
| `providers/responses.ts` | `openai-chatgpt` ve `openai-responses` (aynı durumsuz Responses kodu) |
| `providers/anthropic-messages.ts` | `anthropic-messages`; `MessagesMapper` köprüde de kullanılır |
| `providers/authenticated-stream.ts` | `streamAuthenticated`: credential çözümü + 401'de tek zorunlu refresh |
| `providers/router.ts` | `createModelRouter`: tier → route, reviewer bağımsızlığı, kota bloğu, `provider-change` |
| `providers/claude-code/*` | `claude-code` köprüsü: süreç yönetimi, MCP sunucusu, stdio relay |
| `providers/codex-app-server.ts` | P2 iskelet (uygulama yok) |
| `providers/scripted.ts`, `grammar.ts`, `testing.ts` | Scripted adapter, stream dilbilgisi denetçisi, test doubles |
| `auth/credential-store.ts`, `keychain.ts`, `json-file.ts`, `locks.ts` | CredentialStore, OS CLI kasaları, atomik JSON, süreçler arası kilit |
| `auth/openai-chatgpt.ts` | ChatGPT aboneliği OAuth (PKCE loopback + device-code + refresh) |
| `auth/api-key.ts`, `auth/claude-bridge.ts` | API key ve `cli-bridge` AuthProvider'ları |
| `auth/profile-state.ts` | Secret içermeyen durum: `login_required` işareti, tek seferlik bildirim onayları |
| `auth/command.ts` | `syn login`, `syn logout`, `syn auth status` (`CommandHandler`) |

## 2. Sağlanan fabrikalar

| Fabrika | Not |
| --- | --- |
| `createCredentialStore(home, options?)` | `home` = Synorch kökü (`~/.synorch` veya `$SYNORCH_HOME`). Senkron; keychain yoklaması oluşturma anında bir kez yapılır. |
| `createAuthProviders(store, options?)` | `default` profil (+ `options.profiles`) için desteklenen tüm (sağlayıcı, yöntem) çiftleri. Tekil kimlik için `authProviderFor(store, ref)`. |
| `createModelRouter(config, providers)` | `config.rules: RouteRule[]` (`source`, `tier`, `role?`, `route`); `providers` = adapter listesi. Dönen tip `SynorchModelRouter` (sözleşmedeki `ModelRouter` + kota/onay yöntemleri). |
| `createScriptedAdapter(script)` | Test ve e2e için; ağ yok, aynı iptal/never-throw kuralları. |
| `authCommand` / `createAuthCommand(deps)` | `args[0]` komut adıdır: `login`, `logout`, `auth`. |
| `createOpenAIChatGPTAdapter`, `createOpenAIResponsesAdapter`, `createAnthropicMessagesAdapter`, `createClaudeCodeAdapter`, `createCodexAppServerAdapter` | Adapter'lar; model listesi `options.models` ile statik verilir (keşif ücretli istek atmaz). |

## 3. Doğrudan adapter'lar (`ModelAdapter`)

### 3.1 Ortak davranış

- `stream` asla throw etmez. Kurulum hatası (`fetch` reddi, HTTP 4xx/5xx, `prepare` hatası) `start` olmadan tek `error` üretir; stream sırasındaki hata `error` + `partial` ile biter. Kesilen stream `stream_interrupted`, iptal `cancelled` olur; iptal edilmiş istek hiçbir zaman `done` üretmez.
- Her çıkan olay `modelStreamEventSchema` ile doğrulanır; geçersiz olay `protocol_mismatch` hatasına çevrilir. `checkStreamGrammar` sözleşmedeki dilbilgisini test eder.
- İptal: `AbortSignal` hem `fetch`'e verilir hem de gövde okuyucusu `reader.cancel()` ile kesilir; böylece sahte veya gerçek `fetch` fark etmez.
- `trust: untrusted` sistem blokları (repo metni, hafıza, tool çıktısı) talimat alanına (`instructions` / `system`) **girmez**; `<untrusted-data source=… id=…>` ile sınırlanmış kullanıcı tarafı veri olarak gönderilir.
- `health` ve `discoverCapabilities` ağ isteği göndermez (`health.state = unknown`, `source = static-config`).
- Görsel/dosya (`blob`) girdisi `prepare` aşamasında `invalid_request` ile reddedilir; emülasyon yoktur. `prepare` saftır, `wireDigest = digestOf(body)`.

### 3.2 `openai-chatgpt` ve `openai-responses`

| | `openai-chatgpt` | `openai-responses` |
| --- | --- | --- |
| Uç nokta | `https://chatgpt.com/backend-api/codex/responses` | `https://api.openai.com/v1/responses` |
| Kimlik | `Authorization: Bearer <access>`, `chatgpt-account-id` | `Authorization: Bearer <api key>` |
| Ek header | `originator: synorch`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream` | `accept: text/event-stream` |
| Faturalama / kota | `subscription` / `x-codex-*` header'ları → `quota` olayı | `metered` / yok |
| `max_output_tokens` | Gönderilmez (uyarı) | Gönderilir |

Gövde her iki varyantta durumsuzdur: `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, `tool_choice: "auto"`, `parallel_tool_calls: true`; `previous_response_id` kullanılmaz, tüm geçmiş her istekte `input` içinde yeniden gönderilir. Eşleme: kullanıcı metni → `input_text` mesajı; asistan metni → `output_text` mesajı; `thinking.opaque` → `{type: "reasoning", encrypted_content, summary}`; `tool_call` → `function_call`; `tool_result` → `function_call_output`.

SSE eşlemesi: `response.output_item.added(function_call)` → `tool_call_start`; `response.output_text.delta` → `text_delta`; `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` → `thinking_delta`; `response.function_call_arguments.delta/.done` → `tool_call_delta/end`; `response.output_item.done(reasoning)` → `thinking.opaque = encrypted_content`; `response.completed` → `usage` + `done` (tool çağrısı varsa `tool_use`); `response.incomplete(max_output_tokens)` → `done{length}`; `response.failed` / `error` → `error`.

Kota: `x-codex-{primary,secondary}-used-percent` ve `-reset-at` (epoch saniye/ms veya ISO) → `quota{source: headers, windows[]}`; token/USD ile karıştırılmaz.

### 3.3 `anthropic-messages`

`POST https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`. `max_tokens` zorunlu olduğundan istek belirtmezse 8192 kullanılır (uyarı). `reasoning_effort` → `thinking.budget_tokens` (low 1024, medium 4096, high 16384; bütçe `max_tokens`'tan küçük değilse devre dışı + uyarı). Ardışık aynı rollü mesajlar birleştirilir; `tool_result` kullanıcı turunda gider. İmzalı thinking `opaque = {"signature": …}`, redacted thinking `{"redacted": …}` olarak saklanır ve değiştirilmeden geri gönderilir; imzasız thinking gönderilmez.

### 3.4 Hata eşlemesi

| Durum | Kod |
| --- | --- |
| `missing_codex_entitlement`, `usage_not_included` | `entitlement_missing` |
| 429 + `usage_limit_reached` / `insufficient_quota` | `quota_exhausted` (`resets_at`/`resets_in_seconds` → `retry_after_ms`, retry yok) |
| 429 (diğer) | `rate_limited` (`retry-after-ms` / `retry-after` saniye veya HTTP tarihi → `retry_after_ms`) |
| `context_length_exceeded`, "prompt is too long" | `context_overflow` |
| 401 | abonelik: `auth_expired`; API key: `unauthenticated` |
| 403 / 404 / 408, 504 / ≥500, 529 | `forbidden` / `model_unavailable` / `timeout` / `provider_internal` |
| Stream içi `overloaded_error`, `api_error` | `provider_internal` (retry güvenli) |

`retryable` her zaman `PROVIDER_ERROR_RETRYABLE` tablosundan gelir.

### 3.5 401 ve zorunlu refresh (`streamAuthenticated`)

Credential `AuthProvider.resolve` ile alınır (süresi dolmak üzereyse refresh orada yapılır). İlk yanıt çıktı üretmeden HTTP 401 ile dönerse ve auth sağlayıcısı `forceRefresh` sunuyorsa **tek** refresh ve aynı isteğin **tek** yeniden gönderimi yapılır; ikinci 401 `auth_expired` ile biter. Başka yönteme, profile veya sağlayıcıya asla geçilmez. `forceRefresh`, profil kilidi altında depodaki token'ın reddedilen token'dan farklı olup olmadığına bakar; başka süreç zaten yenilediyse ağ çağrısı yapmaz.

## 4. `claude-code` köprüsü (`AgentBackendAdapter`, deneysel)

- **Opt-in:** `createClaudeCodeAdapter({ experimental: true })` olmadan `startSession` `bridge_unavailable` fırlatır. Kullanıcı tarafı opt-in `syn login anthropic --method cli-bridge` ile `claude-bridge-experimental` bildiriminin bir kez onaylanmasıdır (profil başına, `auth-state.json`).
- **Komut:** `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools "" --mcp-config <tmp>/mcp.json --strict-mcp-config --allowedTools "mcp__synorch__*" --permission-prompt-tool mcp__synorch__approve --setting-sources "" --system-prompt-file <tmp> --model <id> (--session-id <uuid> | --resume <id>) --max-turns <n>`. `--bare` kullanılmaz (abonelik girişini kapatır).
- **Ortam:** Alt süreç ortamı `BackendSessionOptions.env`'dir; `BRIDGE_STRIPPED_ENV` adları (Windows'ta büyük/küçük harf duyarsız) her zaman silinir.
- **MCP mimarisi:** `claude`, `--mcp-config`'teki stdio sunucusu olarak `mcp-relay` betiğini (`process.execPath` ile) başlatır. Relay yalnız bayt aktarır: yerel sokete bağlanır (POSIX: `0700` geçici dizinde Unix soketi; Windows: rastgele adlı named pipe), önce 32 baytlık oturum token'ını gönderir (sabit zamanlı karşılaştırma). Asıl MCP sunucusu (`McpToolServer`: JSON-RPC 2.0, `initialize`, `ping`, `tools/list`, `tools/call`) Synorch sürecinde çalışır; her `tools/call` etkin turun `ToolBridge.call`'una, oradan ToolGateway'e gider. Bilinmeyen yöntem `-32601`, bozuk JSON `-32700`.
- **Araç kimliği eşlemesi:** MCP `tools/call` `tool_use` kimliği taşımaz. stdout satırları geldiği anda (tüketiciyi beklemeden) `tool_use` kimlikleri araç adına göre FIFO kuyruğa alınır; çağrı geldiğinde en fazla 500 ms beklenir, kimlik yoksa `mcp_<rpc id>` kullanılır.
- **İzin:** `approve` iç aracı, `mcp__synorch__` önekli ve etkin köprü listesinde olmayan her şeyi reddeder (`{"behavior":"deny"}`); köprü araçları için karar `ApprovalBridge.decide`'a sorulur.
- **Olay eşlemesi:** `system/init` → `backend_init` (`apiKeySource: oauth` → `subscription`; `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key` → `api-key`). `tools` listesinde önekli olmayan tek araç bile varsa oturum `protocol_mismatch` ile durdurulur. `stream_event` → `MessagesMapper` (araç adları öneksiz; model çağrıları arasında indeks kaydırılır); kısmi olay yoksa `assistant` mesajından sentezlenir; `result` → `usage` (+ `total_cost_usd` → `cost_usd_estimate`) ve `done{stop}` (`error_max_turns` → `done{length}`); `Login expired` / `/login` → `auth_expired` + "`claude /login`" yönlendirmesi.
- **Süreç ömrü:** Süreç ilk `runTurn`'de başlar (araç listesi o anda bilinir) ve oturum boyunca yaşar; süreç ölürse sonraki tur `--resume` ile yeniden başlar.
- **İptal:** POSIX'te önce SIGINT, `interruptGraceMs` sonra SIGTERM. Windows'ta sinyal olmadığı ve `.cmd` shim'i öldürmek node alt sürecini bırakacağı için ağaç `taskkill /T /F` ile sonlandırılır (zarif kesme yoktur). İptal edilen tur `error{cancelled}` + `partial` ile biter.
- **Windows `.cmd` shim:** Node `.cmd`'yi doğrudan çalıştırmadığı için `cmd.exe /d /s /c` üzerinden, her argüman çift tırnakla çalıştırılır; `"`, `%` veya satır sonu içeren argüman reddedilir. Boş `--tools ""` argümanının bozulmadan geçtiği test edilmiştir.
- Synorch Claude token'ı görmez, okumaz, saklamaz; `~/.claude*` hiçbir kod yolunda açılmaz (statik tarama testi).

## 5. Yönlendirme (`createModelRouter`)

- Sıra: `session > project > workspace > user > provider-default`; aynı kaynakta role özel kural genel kuraldan önce gelir.
- Reviewer: implementer'ın (aynı tier) sağlayıcı+modelinden farklı ilk aday seçilir; yoksa gerekçe "reviewer shares the implementer model" olarak kaydedilir.
- Capability yoklaması adapter'ın statik keşfiyle yapılır (önbellek 5 dk); adapter model listesi boş değilse ve model listede yoksa `model_unavailable` (sessiz değişiklik yok).
- Kota: `reportFailure(route, error)` yalnız `quota_exhausted` için route'u `retry_after_ms` sonuna kadar (yoksa süresiz) bloklar. Bloklu route'a çözümleme `RouteBlockedFailure` (`quota_exhausted`, `alternatives[]`) fırlatır. `proposeProviderChange` insan onayı gerektiren `provider-change` `ApprovalRequest`'i üretir (`subject_digest = digestOf({from, to, tier, role})`). `applyProviderChange` yalnız `decided_by: "user"` ve izin veren sonuçla, aynı onay kimliği ve digest için fallback'i açar; sonraki kararlar `fallback{used: true, from, approval_id}` taşır. Orkestratör, reddedilmiş veya digest'i değiştirilmiş karar reddedilir.

## 6. Kimlik doğrulama

### 6.1 ChatGPT aboneliği (`openai` / `oauth-subscription`)

- **Tarayıcı akışı:** 64 bayt verifier → `S256` challenge, 32 bayt `state`; `127.0.0.1:1455` üzerinde geçici HTTP sunucusu; `redirect_uri=http://localhost:1455/auth/callback`; authorize parametreleri: `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, `scope=openid profile email offline_access api.connectors.read api.connectors.invoke`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=synorch`. `state` uyuşmayan geri çağrı 400 alır ve takas edilmez. `missing_codex_entitlement` → `entitlement_missing`. Tarayıcı açılamazsa URL `notify` ile gösterilir. Zaman aşımı 10 dk.
- **Port meşgulse** (veya `--device-code`): `POST /api/accounts/deviceauth/usercode` → `showDeviceCode(https://auth.openai.com/codex/device, user_code)` → `interval` saniyede `POST /api/accounts/deviceauth/token` (403/404 = bekliyor) → `redirect_uri=https://auth.openai.com/deviceauth/callback` ve sunucunun `code_verifier`'ı ile takas. Zaman aşımı 15 dk. 1457 yedek portu kullanılmaz (araştırmada açık karar).
- **Saklama:** `access_token`, `refresh_token`, `id_token`, `expires_at` (`expires_in` → JWT `exp` → 3600 sn), `account_id`/`plan_type` (id_token `https://api.openai.com/auth` claim'leri), `originator: synorch`. `auth status` e-postayı maskeler (`t***@example.com`).
- **Refresh:** bitişe 5 dk'dan az kaldığında, `withRefreshLock` altında ve süreç içi tek uçuşla; kilit içinde token yeniden okunur, başka süreç yenilediyse ağ çağrısı yapılmaz. JSON gövde `{grant_type: refresh_token, client_id, refresh_token}`; gelmeyen alanlar korunur. Kalıcı hata (401, `invalid_grant`, `refresh_token_expired|reused|invalidated`) profili `login_required` işaretler, secret silinmez, sonraki `resolve` ağa çıkmadan `auth_expired` döner. Geçici hata (ağ, 5xx) işaret koymaz.
- **Logout:** Yerel secret ve işaret silinir. Revoke uç noktası araştırmada adıyla geçer ama gövde biçimi doğrulanmadığından çağrılmaz.

### 6.2 API key (`openai`, `anthropic` / `api-key`)

Etkileşimli `promptSecret` ile alınır, depoya yazılır; `api-key-billing` bildirimi gösterilir. `default` profilde depo boşsa `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` yalnız okunur (diske yazılmaz; `auth status` yalnız değişken adını gösterir).

### 6.3 Claude aboneliği (`anthropic` / `cli-bridge`)

Secret yoktur. `login` = kurulu `claude`'u `claude --version` ile yoklama + deneysel bildirimin onayı; Claude girişi `claude` içinde `/login` ile yapılır. `resolve` her zaman `invalid_request` ile reddeder. `status`: kurulu değil → `disconnected`; opt-in yok → `login_required`; opt-in var → `unknown` (giriş durumu ilk turda `apiKeySource` ile görülür). `logout` yalnız opt-in'i geri alır.

### 6.4 CredentialStore

- **Seçim:** `auto` (varsayılan) → OS kasası yoklaması → yoksa dosya. `SYNORCH_CREDENTIAL_STORE=file|keychain|auto` veya `options.backend` ile zorlanır; `keychain` istenip yoksa `config_invalid`.
- **macOS:** `security`; yazma `security -i` ile **stdin** üzerinden (`add-generic-password -U -a <hesap> -s synorch -w <base64>`), okuma `find-generic-password -w`, silme `delete-generic-password` (çıkış 44 = yok).
- **Linux:** `secret-tool store/lookup/clear service synorch account <hesap>`; değer stdin ile. Yoklama: D-Bus hatası (stderr) varsa kasa yok sayılır.
- **Windows:** PowerShell `ConvertTo-SecureString`/`ConvertFrom-SecureString` ile DPAPI (geçerli Windows kullanıcısına bağlı) şifreleme; düz metin stdin'den girer, yalnız şifreli hex `credentials.dpapi.json`'a yazılır. Bu backend sözleşmede `os-keychain` etiketiyle raporlanır (Credential Manager değildir; bkz. §9).
- Hesap anahtarı `<provider>:<method>:<profile>`, değer `base64(JSON{ref, secret})`; `list()` için kasada `synorch:index` kaydı tutulur. Secret hiçbir zaman argv'ye girmez (test edilir). Kasa okumaları süreç içinde önbelleğe alınır; `withRefreshLock` önbelleği o profil için temizler.
- **Dosya yedeği:** `<home>/credentials.json`, `credentialFileSchema`, geçici dosya (`0600`) + fsync + rename, dizin `0700`; Windows'ta mod bitleri yok sayılır ve kullanıcı profili ACL'i geçerlidir. `plaintext-credential-file` bildirimi `syn login` sırasında gösterilir. Bozuk dosya okunamaz ve üzerine yazılmaz (`config_invalid`).
- **Kilitler:** `<home>/locks/credentials.lock` (yazma) ve `<home>/locks/refresh-<sha256(hesap)[0:16]>.lock` (refresh); `O_EXCL` dosyası (pid + token), sahibi ölmüş veya 60 sn'den eski kilit devralınır; süreç içinde anahtar başına mutex.
- **Secret'sız durum:** `<home>/auth-state.json` (`login_required`, bildirim onayları).

### 6.5 `ResolvedCredential` ve redaksiyon

Secret nesne üzerinde değil kapanışta tutulur; `toJSON`, `util.inspect`, `String()` → `"[redacted]"`. `redactionValues()` access/refresh/id token veya API key'i verir. Hata mesajları ve `AuthStatus` alanları token içermez.

## 7. `syn login` / `syn logout` / `syn auth status`

| Komut | Davranış |
| --- | --- |
| `syn login <openai\|anthropic> [--method m] [--profile p] [--device-code]` | Varsayılan yöntem: openai → `oauth-subscription`, anthropic → `api-key`. Etkileşimsiz renderer (`auth.interactive=false`) → exit 7. Kullanım hatası → exit 2. |
| `syn logout <provider> [--method m] [--profile p]` | `--method` yoksa sağlayıcının tüm yöntemleri. |
| `syn auth status [--json]` | `default` profiller + depodaki diğer profiller; her kayıt `authStatusSchema` ile doğrulanır; `--json` çıktısı `AuthStatus[]`. |

Çıkış kodları: `HarnessError` → `exitCodeFor`; `ProviderFailure` `unauthenticated|auth_expired|entitlement_missing|forbidden` → 7, `cancelled` → 130, diğerleri → 4.

## 8. Kabul ölçütü → test

| AC | Test(ler) |
| --- | --- |
| AC-1 | `harness-providers-adapters`: "AC-1 openai-chatgpt fixture…", "AC-1 anthropic-messages fixture…", "AC-1 truncated, failed, incomplete and overloaded fixtures…", "AC-1 negative: garbage bodies…"; `harness-providers-bridge`: "AC-5 bridge…" (köprü de dilbilgisine uyar) |
| AC-2 | `harness-providers-adapters`: "AC-2 abort mid-stream…", "AC-2 HTTP 429 maps retry-after…"; `harness-auth-oauth`: "AC-2 a 401 triggers exactly one forced refresh…" |
| AC-3 | `harness-auth-oauth`: "AC-3 an expired token is refreshed once…", "AC-3 two processes sharing one home…", "AC-3 a permanent refresh failure…", "AC-3 negative: transient refresh failures…"; `harness-auth-store`: "withRefreshLock waits for a lock held by another process…" |
| AC-4 | `harness-auth-redaction`: "AC-4 ResolvedCredential serializes…", "AC-4 tokens never appear…", "AC-4 recorded provider fixtures contain no credential material (grep)" |
| AC-5 | `harness-providers-bridge`: "AC-5 bridge: API keys are stripped, MCP tool calls go through ToolBridge.call…", "AC-5 negative: built-in tools in backend_init…" |
| AC-6 | `harness-providers-router`: "AC-6 quota exhaustion never reroutes silently…", "AC-6 negative: orchestrator, rejected or mismatched decisions…" |
| AC-7 | `harness-auth-command`: "AC-7 `syn auth status --json` is an AuthStatus[]…", "AC-7 headless `syn login` exits 7…" |

Ek: yasaklı kimlik kaynaklarına referans olmadığını gösteren statik tarama (`harness-auth-redaction`), gerçek PowerShell ile DPAPI gidiş-dönüşü (yalnız Windows), gerçek `cmd.exe` üzerinden `.cmd` shim oturumu (yalnız Windows).

## 9. Doğrulanmamış varsayımlar ve gerçek hesap gerektirenler

Hiçbir test ağa veya gerçek hesaba çıkmaz; aşağıdakiler kullanıcının kendi hesabıyla manuel smoke gerektirir:

1. ChatGPT OAuth uç noktaları, `client_id`, scope ve authorize parametreleri `openai/codex@d93909a` kaynağından derlendi; OpenAI'nin gerçek yanıtları (özellikle `expires_in` varlığı, device-code alan adları, refresh hata gövdeleri) doğrulanmadı.
2. `chatgpt.com/backend-api/codex/responses` için SSE'nin yeterli olduğu ve `x-codex-*-reset-at` biçimi varsayımdır; `max_output_tokens` bilinçli olarak gönderilmez. Reasoning öğeleri `id` olmadan (`encrypted_content` ile) geri gönderilir — `store:false` altında kabul edildiği doğrulanmalı.
3. `claude` bayrakları: `--setting-sources ""` boş değerinin kabulü, `--allowedTools "mcp__synorch__*"` joker biçimi, `--permission-prompt-tool` dönüş biçimi (`{"behavior":"allow","updatedInput"}` / `{"behavior":"deny","message"}`), `--include-partial-messages` ile olay sırası, `result.is_error` + `Login expired` metni ve `apiKeySource` değerleri resmi dokümandan/araştırmadan alındı; gerçek `claude` ile denenmedi. `CLAUDE_CODE_MINIMUM_VERSION = 2.0.0` tahmindir.
4. Stream-json girdi modunda SIGINT'in yalnız turu mu yoksa süreci mi bitirdiği doğrulanmadı; uygulama her iki durumda süreci atıp sonraki turda `--resume` kullanır.
5. macOS `security -i` ve Linux `secret-tool` davranışı sahte runner ile test edildi; gerçek macOS/Linux makinede CI matrisi gerekir.
6. Anthropic Messages eşlemesi resmi şemaya göre yazıldı, kayıtlı fixture ile test edildi; canlı API ile denenmedi.

## 10. Sözleşme değişiklik istekleri

1. **`AuthProvider.resolve` zorunlu refresh:** 401 sonrası refresh için sözleşmede yol yok; `streamAuthenticated` isteğe bağlı `forceRefresh(signal)` yöntemini yapısal olarak arar. Öneri: `resolve(signal, options?: { forceRefresh?: boolean })`. Etkilenen: I1 (driver), I5.
2. **`ModelRouter` kota/onay yöntemleri:** `reportFailure`, `proposeProviderChange`, `applyProviderChange` sözleşmede yok (`SynorchModelRouter` olarak eklendi). Öneri: sözleşmeye taşınması; `ModelRouterConfig`/`RouteRule` tipinin de `contracts`'a alınması (I5 composition root'u yapılandırmayı kurar). Etkilenen: I1, I4, I5.
3. **`BackendTurnInput.requestId: string`:** `start.request_id` `RequestId` markası ister; köprü geçersiz kimliği `invalid_request` ile reddeder. Öneri: `requestId: RequestId`. Etkilenen: I1.
4. **`CREDENTIAL_STORE_BACKENDS`:** Windows DPAPI dosyası `os-keychain` olarak raporlanıyor. Öneri: ya `os-dpapi` değeri eklenmesi ya da `AuthStatus.detail`'de açıklanmasının kabulü. Etkilenen: I5 (`doctor --runtime`).
