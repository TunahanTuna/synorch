# Model adapter ve kimlik doğrulama sözleşmesi

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/model.ts`, `auth.ts`; uygulama: `src/harness/providers/`, `src/harness/auth/` (I2). Karar: [ADR-05](../decisions/ADR-05-provider-auth.md). Araştırma: [provider-auth](../research/provider-auth/README.md).

## 1. İki adapter ailesi, tek stream sözleşmesi

| Aile | Döngü sahibi | v1 adapter'ları | Auth yöntemi |
| --- | --- | --- | --- |
| `ModelAdapter` (`kind: "model"`) | Synorch (`AgentDriver`) | `openai-chatgpt` (Responses, ChatGPT aboneliği), `openai-responses` (API key), `anthropic-messages` (API key) | `oauth-subscription`, `api-key` |
| `AgentBackendAdapter` (`kind: "agent-backend"`) | Kullanıcının kurulu resmi istemcisi | `claude-code` (Agent SDK tercih, `claude -p` stream-json yedek); P2: `codex-app-server` (yalnız seam) | `cli-bridge` |

Her iki aile de aynı `ModelStreamEvent` birliğini üretir ve aynı event'lere (`model/*`, `message/recorded`, `tool/*`) kaydedilir. Backend döngüsünde de **tool çağrıları Synorch'un ToolGateway'inden geçer**: backend'in yerleşik araçları kapatılır, Synorch araçları `ToolBridge` üzerinden MCP (`mcp__synorch__<ad>`) veya dynamic tools olarak verilir. Böylece policy, audit, packet ve bağımsız review değişmez.

## 2. ModelAdapter

```ts
interface ModelAdapter {
  kind: "model"; adapterId; providerId; authMethod: "oauth-subscription" | "api-key";
  discoverCapabilities(signal): Promise<ProviderCapabilities>;
  prepare(request, capabilities): PrepareResult;          // saf; wire digest veya unsupported hatası
  stream(request, credential, signal): AsyncIterable<ModelStreamEvent>;  // çağrıldıktan sonra asla throw etmez
  health(signal): Promise<ProviderHealth>;               // ücretli model isteği göndermez
}
```

- **İptal** `AbortSignal` ile yapılır; stream `error{code: cancelled}` ile kapanır, kısmi içerik `partial` alanında korunur. İptal edilmiş veya hatalı cevap hiçbir zaman `done` olmaz.
- **Usage** stream içindeki `usage` olayı ve `done.usage` ile gelir; kaynak etiketi zorunludur (`provider-reported | adapter-estimated | unknown`). Abonelik kotası ayrı `quota` olayıdır; token/USD ile karıştırılmaz.
- `prepare` desteklenmeyen özelliği (ör. görsel girdi) istek gönderilmeden `invalid_request`/`model_unavailable` olarak bildirir; **sahte emülasyon yoktur**.
- `ModelRequest` = `request_id`, `route`, `system[]` (her blok `source`, `trust`, `digest`), `messages[]`, `tools[]`, `max_output_tokens?`, `reasoning_effort?`, `cache?`. İstek ContextBuilder tarafından kurulur, gönderilmeden önce blob olarak kaydedilir; `envelope_digest = digestOf(request)`.
- **Prompt cache (ADR-20):** `cache = {key, stable_system_blocks}`. `key` bir session + rol için sabittir (ör. `<session_id>:<role>`, 1–64 `[A-Za-z0-9._:-]`). İlk `stable_system_blocks` sistem bloğu o session'ın her adımında bayt bayt aynıdır (değişken bloklar — packet, hafıza, compaction — sonra gelir). OpenAI Responses adapter'ları (`openai-chatgpt`, `openai-responses`) `prompt_cache_key = key` gönderir; `anthropic-messages` `cache_control: {type: ephemeral}` kırılma noktalarını son kararlı sistem bloğundan ve araç listesinden sonra koyar. Önbelleği desteklemeyen adapter alanı yok sayar; alan modelin gördüğünü asla değiştirmez. Tool sonucu metni `renderToolResultText` çıktısıdır (`[#n] …`, ADR-18) ve adapter'lar onu aynen gönderir.
- `trust: untrusted` bloklar (repo metni, tool çıktısı, hafıza) hiçbir zaman talimat önceliğine yükseltilmez.

### Stream dilbilgisi

```text
start → backend_init? → ( text_delta | thinking_delta | tool_call_start → tool_call_delta* → tool_call_end
                          | usage | quota )*
      → done{stop_reason: stop|length|tool_use, message}
      | error{error, partial?}
```

Kurulum hatası `start` olmadan tek `error` üretebilir. `length` ile kesilen mesajdaki tamamlanmamış tool çağrıları driver tarafından sentetik hata sonucu alır.

## 3. AgentBackendAdapter (cli-bridge)

```ts
interface AgentBackendAdapter {
  kind: "agent-backend"; adapterId; providerId; authMethod: "cli-bridge";
  probe(signal): Promise<BackendProbe>;                 // kurulu mu, sürüm, auth kaynağı, login ipucu
  discoverCapabilities(signal): Promise<ProviderCapabilities>;
  startSession(options, signal): Promise<BackendSession>;
  health(signal): Promise<ProviderHealth>;
}
interface BackendSession {
  runTurn(input, { tools: ToolBridge, approvals: ApprovalBridge }, signal): AsyncIterable<ModelStreamEvent>;
  interrupt(): Promise<void>; close(): Promise<void>;
}
```

Zorunlu invariant'lar (`claude-code`):

1. Kullanıcının **kendi kurduğu ve giriş yaptığı** `claude` kullanılır (`BackendProbe.executable`); Synorch token görmez, saklamaz, okumaz.
2. Alt sürecin ortamından `BRIDGE_STRIPPED_ENV` (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `CODEX_API_KEY`) ve `BRIDGE_STRIPPED_ENV_PREFIXES` (`ANTHROPIC_`, `CLAUDE_CODE_USE_`) ile başlayan her ad büyük/küçük harf duyarsız silinir (`isBridgeStrippedEnvName`); aksi halde abonelik yerine sessizce API key'e, bir bulut hesabına veya yönlendirilmiş bir endpoint'e faturalanır.
2a. `backend_init.auth_source` `subscription` değilse tur `forbidden` ile reddedilir (`backend_init` yayımlanmaz, alt süreç durdurulur); yalnız kullanıcı yapılandırmasındaki `allow_non_subscription_auth: true` bunu kaldırır.
3. Yerleşik araçlar kapalıdır (`--tools ""` / `tools: []`), yalnız Synorch MCP sunucusu yüklenir (`--strict-mcp-config`), kullanıcı/proje ayarları ve hook'ları yüklenmez (`--setting-sources` / `settingSources: []`), `--bare` kullanılmaz (abonelik OAuth'unu kapatır).
4. İlk olay `backend_init`'tir; `tools` listesinde `mcp__synorch__` önekli olmayan tek bir araç varsa oturum `protocol_mismatch` ile hemen kapatılır.
5. `ApprovalBridge.decide` Synorch köprü aracı olmayan her şeyi reddeder; köprü araçları için karar zaten ToolGateway'dedir.
6. İptal: önce `interrupt()` (SDK) / SIGINT, zaman aşımında SIGTERM.
7. `auth_source` UI'da gösterilir ("Claude aboneliği" / "API key"); `Login expired` → `auth_expired` + "`claude /login` çalıştırın".
8. İlk kullanımda `claude-bridge-experimental` bildirimi bir kez onaylanır (politika durumu belirsiz, kullanım "extra usage"a düşebilir, desteklenen kesin yol API key'dir). Köprü deneysel bayrak arkasında, açık opt-in ile sunulur.

Kalıcı non-goal'lar (ADR-05): Claude.ai OAuth akışını doğrudan uygulamak; `FORBIDDEN_CREDENTIAL_SOURCES` (`~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`, Claude Code keychain girdisi) okumak/yazmak; Claude Code kimliği, UA veya sistem öneki taklidi; faturalandırma sınıflandırıcısından kaçınma; hesap havuzu/rotasyon; aboneliği proxy/API olarak dışarı açma.

## 4. Capability

Her kabiliyet `supported | degraded | unsupported | unknown`'dır; bilinmeyen `false` gibi gizlenmez. Sağlayıcı düzeyi alanlar: `adapter_kind`, `auth_method`, `auth_status`, `billing (subscription|metered|unknown)`, `quota_visibility (headers|api|none)`, `loop_owner (synorch|backend)`, `tool_channel (native|mcp|dynamic-tools|none)`, `policy_status (permitted|unclear)`, `source`, `probed_at`. Şema şunları reddeder: backend'i olmayan `loop_owner: backend`, `cli-bridge` olmayan backend, `native` tool kanalıyla backend, Synorch döngüsünde MCP kanalı.

## 5. Hata taksonomisi

| Kod | Model isteği retry güvenli mi? | Kullanıcı eylemi |
| --- | --- | --- |
| `unauthenticated` | Hayır | `syn login` |
| `auth_expired` | Hayır (refresh denenir, sonra hata) | `syn login` / `claude /login` |
| `forbidden` | Hayır | Hesap/izin |
| `entitlement_missing` | Hayır | Plan Codex/model içermiyor |
| `model_unavailable` | Hayır | Route değiştir (onaylı) |
| `rate_limited` | Evet, `retry_after_ms` ile | Bekle |
| `quota_exhausted` | Hayır | Reset zamanı; API key'e geçiş **insan onayı** |
| `context_overflow` | Hayır | Compaction |
| `invalid_request` | Hayır | Hata raporu |
| `timeout` | Evet | — |
| `cancelled` | Hayır | — |
| `stream_interrupted` | Evet | — |
| `provider_internal` | Evet | — |
| `protocol_mismatch` | Hayır | Adapter/CLI sürümü |
| `bridge_unavailable` | Hayır | `claude` kurulumu |

`PROVIDER_ERROR_RETRYABLE` bu tablodur; şema, tabloda `false` olan bir kodu `retryable: true` ile kabul etmez. Model isteğinin retry'si **hiçbir zaman** yan etkili tool çağrısını tekrarlamaz. Başarısız istek sessizce başka provider'a/modele geçmez.

## 6. Yönlendirme ve fallback

`ModelRouter.resolve({tier, role})` → `RouteDecision` (`source`: `session | project | workspace | user | provider-default`, `reason`, `capabilities_probed_at`, `fallback`). `fallback.used: true` ise `from` ve `approval_id` zorunludur; `provider-change` onayı yalnız insan tarafından verilir ([policy-and-approval.md](./policy-and-approval.md)). Reviewer rolü için router mümkünse implementer'dan farklı model/sağlayıcı tercih eder ([ADR-09](../decisions/ADR-09-reviewer-independence.md)).

`ModelRouter` sözleşmesi ayrıca kota ve onay akışını taşır:

- `reportFailure(route, error)`: driver/orchestration sağlayıcı hatasını bildirir; `quota_exhausted` route'u sıfırlanana kadar bloke eder.
- Bloke route'u çözmek `RouteBlockedFailure` (`ProviderFailure` alt sınıfı, `quota_exhausted`; `blocked`, `tier`, `role`, `alternatives`) fırlatır; router kendiliğinden route değiştirmez.
- `proposeProviderChange(failure, {runId, taskId?, to?}) → ProviderChangeProposal {request, from, to}`: insan onayı gereken `provider-change` isteğini kurar.
- `applyProviderChange(decision)`: yalnız tam o öneriye bağlı, izin veren **kullanıcı** kararı fallback'i açar; sonraki `resolve` `fallback {used: true, from, approval_id}` döner.
- `ModelRouterConfig { rules: RouteRule[] }`, `RouteRule {source, tier, role?, route: RouteBinding {provider_id, model_id, adapter_id, profile?}}`: composition root session/project/workspace/user yapılandırmasından kurar; router kayıtlı adapter'larla doğrular.

`BackendTurnInput.requestId` bir `RequestId`'dir (driver'ın `step/started.request_id`'si); köprü `start` olayında aynen kullanır.

## 7. Kimlik doğrulama soyutlaması

| Yöntem | Kim sahip? | Saklanan secret | v1 |
| --- | --- | --- | --- |
| `oauth-subscription` | Synorch | `access_token`, `refresh_token`, `id_token?`, `expires_at`, `account_id?`, `plan_type?`, `originator: synorch` | OpenAI ChatGPT (P0) |
| `api-key` | Synorch | `api_key` | OpenAI, Anthropic (P0) |
| `cli-bridge` | Kullanıcının istemcisi | **Yok** (şemada yer almaz) | Claude Code (P1 deneysel) |

- `AuthProvider`: `status`, `login(interaction)`, `logout`, `resolve(signal, options?) → ResolvedCredential`. `resolve` gerekirse profil kilidi altında refresh eder; başka yönteme/profile **asla** düşmez. `cli-bridge` provider'ı `resolve`'u reddeder. `options.forceRefresh: true`: sağlayıcı yerelde geçerli görünen credential'ı reddettiğinde (HTTP 401) profil kilidi altında refresh eder — başka bir süreç bu süreç en son verdiğinden beri token'ı zaten yenilediyse onu döner. Yalnız `oauth-subscription` yenileyebilir; diğer yöntemler normal çözer, bu yüzden çağıranlar 401 sonrası tek yeniden denemeyi yalnız bu yöntem için yapar.
- `ResolvedCredential`: secret'ı kapalı tutar; yalnız `applyTo(headers)`, `redactionValues()` ve `toJSON() → "[redacted]"` sunar. Log, packet, tool env veya diff'e yazılamaz.
- `CredentialStore`: `backend` doğru raporlanır: `os-keychain` (macOS Keychain / Secret Service; servis `synorch`, hesap `<provider>:<method>:<profile>`) veya `os-dpapi` (Windows: yalnız kullanıcıya bağlı DPAPI şifreli metnin tutulduğu `~/.synorch/credentials.dpapi.json`) öncelikli; yoksa `file-0600` = `~/.synorch/credentials.json` (dosya `0600`, dizin `0700`, Windows'ta kullanıcı profili ACL'i; atomik temp+rename) ve `plaintext-credential-file` bildirimi. `withRefreshLock` süreçler arası profil kilidi + süreç içi tek uçuşlu refresh sağlar; yeni token kalıcı yazılmadan eski silinmez; kalıcı refresh hatası profili `login_required` yapar.
- `AuthInteraction`: tarayıcı açma, device-code gösterme, secret isteme, bildirim onayı. TUI ve plain renderer uygular; headless modda `interactive: false` ve login komutu exit 7 ile biter.
- OpenAI ChatGPT akışı: PKCE loopback `http://localhost:1455/auth/callback` (meşgulse device-code'a geçilir), `originator: synorch`, istekler `store: false` ve her istekte tam geçmiş (encrypted reasoning `thinking.opaque` ile taşınır). Ayrıntılı parametreler [openai-chatgpt-oauth.md](../research/provider-auth/openai-chatgpt-oauth.md); uygulama sprintinde yeniden doğrulanır.

## 8. Örnekler

```yaml example=provider-capabilities
- schema_version: 1
  provider_id: openai
  adapter_id: openai-chatgpt
  adapter_kind: model
  auth_method: oauth-subscription
  auth_status: connected
  billing: subscription
  quota_visibility: headers
  loop_owner: synorch
  tool_channel: native
  policy_status: permitted
  probed_at: "2026-09-22T10:00:00Z"
  source: provider-api
  models:
    - id: gpt-5.6-sol
      context_window: 400000
      max_output_tokens: 128000
      tool_calls: supported
      streaming: supported
      cancellation: supported
      image_input: unknown
      structured_output: supported
      reasoning: supported
      prompt_cache: degraded
      system_message_updates: unsupported
      usage_reporting: exact
- schema_version: 1
  provider_id: anthropic
  adapter_id: claude-code
  adapter_kind: agent-backend
  auth_method: cli-bridge
  auth_status: connected
  billing: unknown
  quota_visibility: none
  loop_owner: backend
  tool_channel: mcp
  policy_status: unclear
  probed_at: "2026-09-22T10:00:00Z"
  source: backend-init
  models:
    - id: opus-5
      context_window: null
      max_output_tokens: null
      tool_calls: supported
      streaming: supported
      cancellation: supported
      image_input: unknown
      structured_output: unknown
      reasoning: supported
      prompt_cache: unknown
      system_message_updates: unsupported
      usage_reporting: estimated
```

```yaml example=provider-capabilities invalid
- schema_version: 1
  provider_id: anthropic
  adapter_id: claude-code
  adapter_kind: agent-backend
  auth_method: cli-bridge
  auth_status: connected
  billing: unknown
  quota_visibility: none
  loop_owner: backend
  tool_channel: native
  policy_status: unclear
  probed_at: "2026-09-22T10:00:00Z"
  source: backend-init
  models: []
- schema_version: 1
  provider_id: anthropic
  adapter_id: anthropic-messages
  adapter_kind: agent-backend
  auth_method: api-key
  auth_status: connected
  billing: metered
  quota_visibility: none
  loop_owner: backend
  tool_channel: mcp
  policy_status: permitted
  probed_at: "2026-09-22T10:00:00Z"
  source: probe
  models: []
```

```yaml example=model-stream-event
- type: start
  request_id: req_01K5T3Q8Z4X9V2M6N7P0R1S2TD
  route: { provider_id: anthropic, model_id: claude-api-model, adapter_id: anthropic-messages, adapter_kind: model, auth_method: api-key, profile: default }
- { type: text_delta, index: 0, text: "Let me check" }
- { type: tool_call_start, index: 1, provider_call_id: toolu_01, name: read_file }
- { type: tool_call_delta, index: 1, provider_call_id: toolu_01, arguments_fragment: "{\"path\":\"src/a" }
- { type: tool_call_end, index: 1, provider_call_id: toolu_01, name: read_file, arguments: { path: src/auth/service.ts } }
- { type: usage, usage: { input_tokens: 5120, output_tokens: 88, source: provider-reported } }
- type: done
  stop_reason: tool_use
  message:
    role: assistant
    content:
      - { type: text, text: "Let me check" }
      - { type: tool_call, provider_call_id: toolu_01, name: read_file, arguments: { path: src/auth/service.ts } }
- type: error
  error: { code: cancelled, message: "request aborted by user", retryable: false }
  partial: { role: assistant, content: [{ type: text, text: "Let me" }] }
- type: backend_init
  backend_session_id: 5b0e8c1e-2f5d-4a8b-9d7e-1c2b3a4d5e6f
  model_id: opus-5
  auth_source: subscription
  tools: [mcp__synorch__read_file, mcp__synorch__apply_patch, mcp__synorch__exec]
- type: quota
  quota: { source: headers, plan_label: plus, windows: [{ name: primary, used_percent: 41.5, resets_at: "2026-09-22T15:00:00Z" }] }
```

```yaml example=provider-error
- { code: rate_limited, message: "429 from provider", retryable: true, retry_after_ms: 20000, http_status: 429 }
- { code: quota_exhausted, message: "usage_limit_reached", retryable: false, http_status: 429, provider_code: usage_limit_reached }
- { code: bridge_unavailable, message: "claude executable not found on PATH", retryable: false }
```

```yaml example=provider-error invalid
- { code: auth_expired, message: "token expired", retryable: true }
- { code: rate_limited, message: "slow down", retryable: true, api_key: sk-leaked }
```

```yaml example=route-decision
tier: complex_worker
role: implementer
route: { provider_id: openai, model_id: gpt-5.6-sol, adapter_id: openai-chatgpt, adapter_kind: model, auth_method: oauth-subscription, profile: default, tier: complex_worker }
source: project
reason: "project profile maps complex_worker to gpt-5.6-sol; capability probe ok"
capabilities_probed_at: "2026-09-22T10:00:00Z"
fallback: { used: false }
```

```yaml example=route-decision invalid
tier: complex_worker
route: { provider_id: openai, model_id: gpt-5.6-sol, adapter_id: openai-responses, adapter_kind: model, auth_method: api-key, profile: default }
source: provider-default
reason: "subscription quota exhausted, switched to API key"
fallback: { used: true, from: { provider_id: openai, model_id: gpt-5.6-sol, adapter_id: openai-chatgpt, adapter_kind: model, auth_method: oauth-subscription, profile: default } }
```

```yaml example=auth-status
- { provider_id: openai, method: oauth-subscription, profile: default, state: connected, account_label: "t***@example.com", plan_label: plus, entitlement: verified, billing: subscription, expires_at: "2026-09-22T11:00:00Z", store_backend: os-keychain }
- { provider_id: anthropic, method: cli-bridge, profile: default, state: connected, entitlement: unknown, billing: unknown, detail: "Claude Code 2.4.1, apiKeySource=oauth" }
- { provider_id: anthropic, method: api-key, profile: work, state: connected, entitlement: unverified, billing: metered, store_backend: file-0600 }
- { provider_id: openai, method: api-key, profile: default, state: connected, entitlement: unverified, billing: metered, store_backend: os-dpapi }
```

```yaml example=credential-secret
- { method: api-key, api_key: "sk-ant-example-not-real", created_at: "2026-09-22T10:00:00Z" }
- method: oauth-subscription
  access_token: example-access
  refresh_token: example-refresh
  expires_at: "2026-09-22T11:00:00Z"
  account_id: acct-example
  plan_type: plus
  originator: synorch
  obtained_at: "2026-09-22T10:00:00Z"
```

`cli-bridge` için secret saklanamaz; başka bir istemcinin kimliğini taklit eden `originator` kabul edilmez:

```yaml example=credential-secret invalid
- { method: cli-bridge, token: copied-from-claude-credentials }
- method: oauth-subscription
  access_token: example-access
  refresh_token: example-refresh
  expires_at: "2026-09-22T11:00:00Z"
  originator: codex_cli_rs
  obtained_at: "2026-09-22T10:00:00Z"
```

Prompt cache ipucu (ADR-20):

```yaml example=prompt-cache
- { key: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4:implementer", stable_system_blocks: 5 }
- { key: "run_01K5T3Q8Z4X9V2M6N7P0R1S2T3.orchestrator", stable_system_blocks: 0 }
```

```yaml example=prompt-cache invalid
- { key: "", stable_system_blocks: 1 }
- { key: "has spaces", stable_system_blocks: 1 }
- { key: "ok", stable_system_blocks: -1 }
```
