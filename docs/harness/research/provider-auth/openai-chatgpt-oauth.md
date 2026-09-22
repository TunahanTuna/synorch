# OpenAI: "Sign in with ChatGPT" (Codex OAuth) teknik şartnamesi

> Statü: araştırma; runtime uygulanmadı. İnceleme: 2026-09-22. Birincil kaynak: `openai/codex` deposu, commit [`d93909a939e40c3c1031f5a713bacad8c0d9afe6`](https://github.com/openai/codex/tree/d93909a939e40c3c1031f5a713bacad8c0d9afe6). Bu belgedeki satır numaraları o commit'e aittir; `main` hareketlidir, uygulama sprintinde yeniden doğrulanmalı.

Etiketler: **[Kod]** = kaynak kodunda görüldü (dış kaynak bulgusu). **[Doküman]** = OpenAI resmi dokümanı. **[Referans]** = üçüncü taraf açık kaynak uygulamada görüldü, OpenAI tarafından belgelenmemiş. **[Çıkarım]** = bizim yorumumuz.

## 1. Politika durumu (özet)

Ayrıntı ve alıntılar [README](./README.md) ve [recommendation.md](./recommendation.md) içindedir. Kısa hali: OpenAI, ChatGPT aboneliğinin üçüncü taraf harness'larda "Sign in with ChatGPT" ile kullanılmasını kamuya açık biçimde destekliyor; ancak **üçüncü taraflar için yazılı bir OAuth istemci kaydı, header sözleşmesi veya kararlı endpoint dokümanı yok**. Kullanılan `client_id` Codex CLI'ın kamuya açık istemci kimliğidir. Açık issue: [openai/codex#36886](https://github.com/openai/codex/issues/36886) ("Is there a documented auth contract for third-party clients…?"). Abonelik paylaşımı/proxy ile API'ye dönüştürme ("sub2api") desteklenmiyor ve fraud sistemlerince işaretleniyor (Tibo Sottiaux, 2026-08-21; ikincil kaynak: [explainx.ai](https://explainx.ai/blog/codex-usage-limits-sub2api-sign-in-chatgpt-august-2026), [cryptopolitan](https://www.cryptopolitan.com/openai-codex-usage-limit-transparency/)).

## 2. Sabitler

| Öğe | Değer | Kaynak |
| --- | --- | --- |
| Issuer | `https://auth.openai.com` | [Kod] `codex-rs/login/src/server.rs:76` |
| Authorize endpoint | `{issuer}/oauth/authorize` | [Kod] `server.rs:603` |
| Token endpoint | `https://auth.openai.com/oauth/token` | [Kod] `server.rs:717`, `auth/manager.rs:212` |
| Revoke endpoint | `https://auth.openai.com/oauth/revoke` | [Kod] `auth/manager.rs:213` |
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI'ın public client'ı; `CODEX_APP_SERVER_LOGIN_CLIENT_ID` ile override edilebilir) | [Kod] `auth/manager.rs:216,1698-1704` |
| Loopback port | `1455`; meşgulse "registered fallback port" `1457` | [Kod] `server.rs:77-79,635-680` |
| Redirect URI | `http://localhost:{port}/auth/callback` (bind adresi `127.0.0.1`) | [Kod] `server.rs:193,636` |
| Scope | `openid profile email offline_access api.connectors.read api.connectors.invoke` | [Kod] `server.rs:606-608` |
| Ek authorize parametreleri | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<istemci adı>`, opsiyonel `allowed_workspace_id` | [Kod] `server.rs:594-601` |
| Varsayılan originator | `codex_cli_rs`; first-party sayılanlar: `codex_cli_rs`, `codex-tui`, `codex_vscode`, `Codex …` önekli | [Kod] `auth/default_client.rs:42,141-146` |
| Inference base URL | `https://chatgpt.com/backend-api/codex` | [Kod] `codex-rs/model-provider-info/src/lib.rs:77` |

Notlar:
- pi-ai ve OpenCode scope olarak yalnız `openid profile email offline_access` kullanıyor; OMP, Codex CLI ile aynı altı scope'u kullanıyor. [Referans] Minimum scope setinin yeterliliği bizim tarafımızda deneyle doğrulanmalı.
- OMP'nin kural dosyası "OpenAI only allowlists this exact URI; a busy port must fail" diyor ([`openai-codex.kdl`](https://github.com/can1357/oh-my-pi/blob/8cd6f8c619e89e935b6c6c5c91f6a4d20f6d7a75/packages/catalog/src/compat/rules/auth/openai-codex.kdl)); Codex CLI ise 1457'yi "registered fallback" olarak kullanıyor. Çelişki: 1457 fallback'i bizim `client_id` kullanımımızda da çalışır mı, deneyle doğrulanmalı. **[Açık karar]**
- `originator` için üçüncü taraflar kendi adını gönderiyor: OpenCode `opencode`, pi `pi`, OMP `omp`, Hermes `hermes-agent`. Hermes yorumu: "OpenAI requires third-party harnesses to identify themselves" ([`agent/codex_headers.py`](https://github.com/NousResearch/hermes-agent/blob/71a2fe399bbd7a219c71f9d9fca2b313b01f2057/agent/codex_headers.py)). Bu şartın OpenAI'daki resmi kaynağı bulunamadı. **Öneri:** `originator=synorch`; `codex_cli_rs` taklidi yapılmaz.

## 3. Tarayıcı akışı (Authorization Code + PKCE)

1. **PKCE** [Kod] `login/src/oauth/pkce.rs`: 64 rastgele bayt → base64url (padding yok) = `code_verifier`; `code_challenge = base64url(SHA256(verifier))`, method `S256`. `state` rastgele üretilir (`server.rs:179`).
2. **Loopback sunucu** `127.0.0.1:1455` üzerinde; `GET /auth/callback?code=…&state=…` beklenir. `state` eşleşmezse reddedilir.
3. **Authorize URL**: `https://auth.openai.com/oauth/authorize?response_type=code&client_id=…&redirect_uri=http://localhost:1455/auth/callback&scope=…&code_challenge=…&code_challenge_method=S256&state=…&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=synorch`
4. **Code exchange** [Kod] `server.rs:709-760`, `oauth/client.rs:55-73`: `POST https://auth.openai.com/oauth/token`, `Content-Type: application/x-www-form-urlencoded`, gövde `grant_type=authorization_code&client_id=…&code=…&redirect_uri=…&code_verifier=…`. Yanıt: `id_token`, `access_token`, `refresh_token` (+ OpenCode'a göre `expires_in`, yoksa 3600 varsayılıyor [Referans]).
5. **Hata sayfası**: `access_denied` + `missing_codex_entitlement` → hesabın Codex hakkı yok (`server.rs` test `render_login_error_page_uses_entitlement_copy`). Kullanıcıya "planınız Codex içermiyor" mesajı verilmeli.
6. **Workspace kısıtı** (opsiyonel): `ensure_workspace_allowed` id_token'daki `chatgpt_account_id` ile kontrol eder.

Codex ayrıca `id_token` ile token-exchange yaparak API-key tarzı token alabiliyor (`obtain_api_key`, `server.rs:1011-1045`, `requested_token=openai-api-key`). **Öneri:** Synorch bunu kullanmaz; abonelik ile Platform API faturalaması karışmamalı.

## 4. Device-code akışı (headless/SSH)

[Kod] `login/src/device_code_auth.rs`:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, JSON `{"client_id": "…"}` → `{device_auth_id, user_code (alias usercode), interval}` (`interval` string olarak gelir).
2. Kullanıcıya `https://auth.openai.com/codex/device` ve `user_code` gösterilir.
3. `POST https://auth.openai.com/api/accounts/deviceauth/token`, JSON `{"device_auth_id", "user_code"}` `interval` saniyede bir yoklanır. OpenCode 403/404'ü "henüz onaylanmadı" olarak ele alıyor [Referans]. Başarıda `{authorization_code, code_challenge, code_verifier}` döner.
4. Normal code exchange: `redirect_uri=https://auth.openai.com/deviceauth/callback`, sunucunun döndürdüğü `code_verifier` ile.
5. pi-ai toplam bekleme için 15 dk timeout kullanıyor [Referans].

## 5. Token dosyası ve saklama (Codex CLI referansı)

[Kod] `auth/storage.rs:39-64`, `token_data.rs`:

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "<JWT>",
    "refresh_token": "<opaque>",
    "account_id": "<chatgpt_account_id>"
  },
  "last_refresh": "2026-09-22T00:00:00Z"
}
```

- Konum `$CODEX_HOME/auth.json` (varsayılan `~/.codex/auth.json`); Unix'te `0o600` ile yazılır (`storage.rs:217`). Alternatif: OS keyring, servis adı `Codex Auth` (`storage.rs:235`).
- JWT claim'leri `https://api.openai.com/auth` namespace'i altında: `chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_user_id`, `chatgpt_account_is_fedramp` (`token_data.rs:77-116`). Hermes/OpenCode ayrıca `chatgpt_data_residency` / `chatgpt_compute_residency` okuyor [Referans].
- **Öneri:** Synorch `~/.codex/auth.json` dosyasını paylaşmaz ve refresh etmez. Refresh token'lar rotasyonlu; iki uygulamanın aynı token'ı yenilemesi birinin oturumunu düşürür (Hermes `hermes_cli/auth_codex.py` başlık yorumu ve OpenClaw "token sink" açıklaması aynı riski yazıyor).

## 6. Refresh

[Kod] `auth/manager.rs:1609-1690`, `2955-2977`, `oauth/client.rs:75-89`:

- `POST https://auth.openai.com/oauth/token`, **JSON gövde** (`TokenEncoding::Json`): `{"grant_type":"refresh_token","client_id":"…","refresh_token":"…"}`. Yanıtta `id_token`, `access_token`, `refresh_token` opsiyonel; gelen alanlar üzerine yazılır, `last_refresh` güncellenir.
- Proaktif refresh: access token `exp` değerine 5 dakikadan az kaldıysa (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`); `exp` okunamazsa `last_refresh` 8 günden eskiyse (`TOKEN_REFRESH_INTERVAL = 8`).
- Kalıcı hatalar (yeniden giriş gerekir): HTTP 401; 400 + `invalid_grant`; `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`. Diğerleri geçici sayılır.
- **Öneri:** Aynı credential için süreçler arası kilit (lock file) + tek uçuşlu refresh (OpenCode `refreshPromise` deseni).

## 7. Inference isteği

**Endpoint** [Kod]: `POST https://chatgpt.com/backend-api/codex/responses` (base + `/responses`, `codex-api/src/endpoint/responses.rs:67`). Model listesi: `GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>` (`codex-api/src/endpoint/models.rs:37-44`, `model-provider/src/models_endpoint.rs:457`). Codex CLI önce WebSocket (`OpenAI-Beta: responses_websockets=2026-02-06`, `core/src/client.rs:172`) dener, SSE'ye düşebilir; openbench spike raporu 405 sonrası SSE fallback'i gözlemledi [Referans]. **Öneri:** İlk sürümde yalnız SSE.

**Header'lar**

| Header | Değer | Kaynak |
| --- | --- | --- |
| `Authorization` | `Bearer <access_token>` | [Kod] `model-provider/src/bearer_auth_provider.rs:36` |
| `ChatGPT-Account-ID` | JWT'deki `chatgpt_account_id` | [Kod] `bearer_auth_provider.rs:41` |
| `X-OpenAI-Fedramp` | `true` (yalnız FedRAMP hesaplarda) | [Kod] `bearer_auth_provider.rs:44` |
| `originator` | istemci adı | [Kod] `auth/default_client.rs:377` |
| `User-Agent` | istemci UA | [Kod] `default_client.rs` |
| `session-id`, `thread-id` | oturum kimlikleri | [Kod] `codex-api/src/requests/headers.rs:5-13` |
| `x-client-request-id` | thread id | [Kod] `endpoint/responses.rs:88` |
| `x-openai-subagent` | `review`, `compact`, `collab_spawn`… (alt ajan kaynağı) | [Kod] `endpoint/responses.rs:92` |
| `accept: text/event-stream`, `OpenAI-Beta: responses=experimental` | SSE | [Referans] pi-ai `openai-codex-responses.ts:1636-1639` |
| `x-openai-internal-codex-residency` | residency claim | [Referans] Hermes, OpenCode (residency zorunlu workspace'lerde yoksa 401 "Workspace is not authorized in this region") |

**Gövde** [Kod] `codex-api/src/common.rs:260-288`, `core/src/client.rs:955-1000`:

```json
{
  "model": "<slug>",
  "instructions": "<sistem talimatı>",
  "input": [ /* ResponseItem[]: message, function_call, function_call_output, reasoning … */ ],
  "tools": [ /* function tool tanımları */ ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<oturum anahtarı>",
  "text": { "verbosity": "medium" }
}
```

- `store` ChatGPT backend'inde `false` olmak zorunda; pi-ai yorumu: `ChatGPT Codex Responses rejects store: true ("Store must be set to false")` [Referans]. Bu yüzden istek **durumsuzdur**: tüm geçmiş her istekte `input` içinde yeniden gönderilir, `previous_response_id`/`item_reference` kullanılmaz, önceki reasoning `encrypted_content` ile taşınır.
- Codex CLI `service_tier`, `client_metadata`, `stream_options` de gönderebiliyor; bunlar opsiyonel.

**SSE olayları** [Kod] `codex-api/src/sse/responses.rs:357-540`: `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.reasoning_summary_text.delta` / `.done`, `response.reasoning_summary_part.added`, `response.reasoning_text.delta`, `response.output_item.done`, `response.completed` (usage burada: `response.usage`), `response.failed`, `response.incomplete`. Public Responses API ile aynı şekil.

**Kullanım/kota header'ları** [Kod] `codex-api/src/rate_limits.rs`: `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at` ve `x-codex-secondary-…` eşleri; ek limit kimlikleri aktif limit header'ıyla seçiliyor. App-server tarafında aynı veri `account/rateLimits/read` ile okunabiliyor ([Doküman](https://developers.openai.com/codex/app-server)).

## 8. Hata sınıflandırması

[Kod] `codex-api/src/api_bridge.rs:115-190`, `sse/responses.rs` testleri:

| Durum | Anlam | Harness davranışı (öneri) |
| --- | --- | --- |
| HTTP 429 + `error.type = usage_limit_reached` (+ `plan_type`, `resets_at`) | Abonelik penceresi doldu | Reset zamanını göster; sessiz API-key fallback **yok** |
| HTTP 429 + `usage_not_included` | Plan bu kullanımı kapsamıyor | Plan uyarısı |
| HTTP 429 + `insufficient_quota` vb. | Kota/kredi bitti | Kullanıcıya bildir |
| HTTP 401 | Token geçersiz | Bir kez refresh, sonra yeniden giriş |
| `response.failed` + `context_length_exceeded` | Bağlam aşıldı | Compaction |
| `response.failed` + `cyber_policy` / bio policy | Güvenlik filtresi | Kullanıcıya göster, retry yok |
| HTTP 500 | Sunucu hatası | Backoff ile retry |
| 403 `invalid or disabled credential` | Gözlenen, sürüm değişiminde ([#33969](https://github.com/openai/codex/issues/33969), issue #36886'dan alıntı) | Yeniden giriş + telemetri |

## 9. Bizim için riskler

1. Endpoint ve header'lar belgelenmemiş iç yüzey; OpenAI değiştirebilir. **Öneri:** adapter'ı izole et, sözleşme testi + canary, hata olunca açık mesaj.
2. `client_id` Codex CLI'a ait; OpenAI yalnız resmi Codex istemcilerine izin verecek şekilde politikayı değiştirebilir. Plan B: [Codex app-server köprüsü](./cli-bridges.md).
3. Kota sonuçları: harness her kullanıcı turunda birden fazla model çağrısı yapar; kullanıcı ChatGPT/Codex penceresini hızlı tüketebilir. Kota header'ları UI'da gösterilmeli.
4. Çok hesap/rotasyon, paylaşım, proxy olarak dışarı açma **yapılmaz** (sub2api riski).
