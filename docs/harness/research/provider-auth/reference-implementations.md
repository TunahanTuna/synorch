# Referans uygulamalar: Hermes, Oh My Pi / pi-ai, OpenCode

> Statü: araştırma. İnceleme: 2026-09-22. Kaynak kodu sığ klonla okundu; commit SHA'ları aşağıda. Bu dosya **tasarım incelemesidir, kod kopyalama izni vermez** ([kaynak kuralları](../sources.md)). Lisanslar kod taşıma kararından önce ayrıca doğrulanmalı.

| Proje | Commit | Tarih |
| --- | --- | --- |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `71a2fe399bbd7a219c71f9d9fca2b313b01f2057` | 2026-09-23 (+05:30) |
| [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (`packages/ai`, npm `@earendil-works/pi-ai`) | `27c072e98f613edb1da4bc6377d939b1c8e03fd1` | 2026-09-22 |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `8cd6f8c619e89e935b6c6c5c91f6a4d20f6d7a75` | 2026-09-22 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) (`dev`) | `2406400f0aeb07b36d0495af4e05aaca49159832` | 2026-09-22 |

## 1. Hermes Agent (Nous Research)

### OpenAI / Codex

- Sabitler: `CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`, `CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"`, `DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`, refresh 120 sn erken (`hermes_cli/auth_constants.py:70-95`).
- Giriş: ChatGPT device-code akışı (`hermes_cli/auth_codex.py`, `auth_device_flow.py`); tarayıcı akışı `auth_codex_browser.py`.
- Saklama: `~/.hermes/auth.json`; bilinçli olarak `~/.codex/` ile paylaşmıyor: "so one app's refresh-token rotation cannot invalidate the other's session" (`auth_codex.py:3-5`). `~/.codex/auth.json` yalnız okunarak içe aktarılabiliyor, yazılmıyor (`_import_codex_cli_tokens`, `:528-548`).
- Kimlik: resmi endpoint'e `User-Agent: HermesAgent/<ver>`, `originator: hermes-agent`; özel proxy'lere `codex_cli_rs` uyumluluk kimliği. `ChatGPT-Account-ID` ve `x-openai-internal-codex-residency` JWT'den türetiliyor (`agent/codex_headers.py`).
- Kendi dokümanı: Codex planı kota semantiği "not currently documented" (`website/docs/integrations/providers.md:143,150`).

### Anthropic

- Kimlik sırası: `ANTHROPIC_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → Hermes'in kendi OAuth grant'ları → **Claude Code'un `~/.claude/.credentials.json` / macOS Keychain kaydı ("borrowed")** (`agent/anthropic_credentials.py:1-9`).
- Kendi PKCE akışı: Claude Code client_id, `https://claude.ai/oauth/authorize`, redirect `https://console.anthropic.com/oauth/code/callback`, kullanıcı kodu yapıştırır; token `platform.claude.com/v1/oauth/token` (`:36-44,752-806`).
- Refresh sonrası Claude Code Keychain kaydını da güncelliyor (#98334), çünkü tek kullanımlık refresh token'lar iki mağaza arasında ayrışıyor (`:572-605`).
- İstek kimliği: `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-code/<kurulu sürüm> (external, cli)`, `x-app: cli`, sistem öneki "You are Claude Code, Anthropic's official CLI for Claude." (`agent/anthropic_adapter.py:215-282,466-473`).
- **Sınıflandırıcıdan kaçınma:** "Anthropic's OAuth billing classifier fingerprints certain Hermes tool schemas/prose as a third-party app and reroutes to the metered extra-usage lane (HTTP 400 "You're out of extra usage" on a valid subscription)" — `session_search`→`chat_history_lookup`, `memory`→`context_notes` takma adları; tüm araçlar `mcp__` önekine zorlanıyor ("single-underscore `mcp_` … third-party-app fingerprint (HTTP 400 "Third-party apps now draw from extra usage")") (`anthropic_adapter.py:284-296,504-530`).
- **Kendi dokümanındaki itiraf:** "The OAuth path routes as Claude Code against your Anthropic account and **only works on a Claude Max plan with purchased extra usage credits** — the base Max allowance is never consumed by Hermes … Claude Pro subscribers cannot use this path" (`website/docs/integrations/providers.md:142-148,174-178`).

**Çıkarım:** "Hermes gibi Claude aboneliğiyle çalışmak" gerçekte abonelik kotasını değil, Max + ücretli extra usage'ı tüketiyor ve Claude Code taklidine dayanıyor. Ürün hedefimizin Anthropic yarısı Hermes modeliyle karşılanamaz.

## 2. pi-mono / pi-ai (`@earendil-works/pi-ai`)

- Codex: `packages/ai/src/auth/oauth/openai-codex.ts:26-39` — client_id `app_EMoamEEZ73f0CkXaXp7hrann`, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, device-code URL'leri, 15 dk device timeout. İstek: `packages/ai/src/api/openai-codex-responses.ts` — base `https://chatgpt.com/backend-api`, yol `/codex/responses` (`:641-646`), header `chatgpt-account-id`, `originator: pi`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`, `session-id`/`x-client-request-id` (`:1610-1645`); `store:false` zorunlu (`:1493` yorumu); SSE/WebSocket/auto transport.
- Anthropic: `packages/ai/src/auth/oauth/anthropic.ts` — Claude Code client_id (base64 gizli, `:29`), authorize `claude.ai`, token `platform.claude.com`, loopback `localhost:53692/callback`, geniş scope (`:29-37`). İstek: `packages/ai/src/api/anthropic-messages.ts` — `sk-ant-oat` tespiti, `user-agent: claude-cli/2.1.280`, `x-app: cli` (`:87,941-960`), beta'lar (`:1017`), zorunlu Claude Code sistem öneki (`:1078-1083`), araç adlarının Claude Code adlarına eşlenmesi (`toClaudeCodeName`, `:115`).
- Saklama: README "Credentials are saved to `auth.json` in the current directory" (`packages/ai/README.md`); `CredentialStore` soyutlaması var.
- ToS notu: README'de Anthropic için uyarı bulunamadı; yalnız "Anthropic (Claude Pro/Max subscription)" listeleniyor.

## 3. Oh My Pi (OMP)

- Kimlik kuralları KDL dosyalarında: `packages/catalog/src/compat/rules/auth/openai-codex.kdl` (Codex CLI ile aynı altı scope, `originator "omp"`, `callback port=1455 … port-fallback=#false` ve "OpenAI only allowlists this exact URI" yorumu), `openai-codex-device.kdl`, `anthropic.kdl`.
- Anthropic (`docs/provider-quirks.md:149-169`): "Claude Code fingerprint" sabitleri (`claude-code-fingerprint.ts`), `User-Agent: claude-cli/2.1.220 (external, claude-desktop)`, Cowork beta bayrakları, cihaz/oturum kimliği üretimi (`generateClaudeCloakingUserId`), `cch=00000` XXHash64 "billing attestation" başlıkları, sistem öneki "You are a Claude agent, built on Anthropic's Claude Agent SDK.", OAuth grant mutlak TTL 30 gün, kota için `https://api.anthropic.com/api/oauth/usage` yoklaması ve hesap rotasyonu.
- Kredi SQLite'ta (`packages/ai/src/auth/sqlite-credential-store.ts`), bir `auth-broker` süreci refresh'i yönetiyor.

**Çıkarım:** OMP'nin Anthropic yolu açık bir "cloaking" uygulamasıdır; Synorch için örnek alınmamalı. Codex yolu (dürüst `originator`, deklaratif kural) iyi bir desen.

## 4. OpenCode (sst → anomalyco)

- Codex desteği: PR [#7537](https://github.com/anomalyco/opencode/pull/7537), 2026-01-09 birleşti (merge `172bbdaced3e87d747f637ec988970ae820a614f`); Dax Raad: "We are working with OpenAI to allow Codex users to benefit from their subscription directly within OpenCode" ([ikincil](https://www.besthub.dev/articles/anthropic-s-model-lockdown-vs-openai-s-opencode-integration-what-it-means-for-developers-74830a2c24d8)).
- Güncel kod: [`packages/opencode/src/plugin/openai/codex.ts`](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/opencode/src/plugin/openai/codex.ts): `CLIENT_ID`, `ISSUER = https://auth.openai.com`, `CODEX_API_ENDPOINT = https://chatgpt.com/backend-api/codex/responses`, `OAUTH_PORT = 1455`, scope `openid profile email offline_access`, `originator: opencode`. `fetch` sarmalayıcısı: `Authorization` değiştirilir, `ChatGPT-Account-Id` eklenir, `/v1/responses` ve `/chat/completions` Codex endpoint'ine yeniden yazılır, residency header'ı eklenir; tek uçuşlu refresh (`refreshPromise`). OAuth ile modeller `cost: 0` gösterilir; izinli model listesi sabit (`ALLOWED_MODELS`, `gpt-5.5-pro` hariç). Yöntemler: "ChatGPT Pro/Plus (browser)", "ChatGPT Pro/Plus (headless)" (device-code), "Manually enter API Key".
- Anthropic: 2026-01-09 engelleme sonrası uyarı eklendi ([#10595](https://github.com/anomalyco/opencode/pull/10595): "Pro/Max subscriptions are not officially supported by Anthropic"); 2026-02-19 commit [`973715f`](https://github.com/anomalyco/opencode/commit/973715f3da1839ef2eba62d4140fe7441d539411) ("anthropic legal requests") ile `claude-code-20250219` header'ı, yerleşik Anthropic auth plugin'i ve Anthropic'e özel prompt dosyası kaldırıldı (değişen dosyalar: `cli/cmd/auth.ts`, `plugin/index.ts`, `provider/provider.ts`, `session/llm.ts`, `session/prompt/anthropic-20250930.txt`, `web/…/providers.mdx`).
- Üçüncü taraf OpenCode Codex plugin'lerinin ortak uyarısı: "This project is for personal development use with your own ChatGPT Plus/Pro subscription … not intended for commercial resale, shared multi-user access, or production services … For production/commercial workloads, use the OpenAI Platform API" ([ndycode/oc-codex-multi-auth](https://github.com/ndycode/oc-codex-multi-auth)).

## 5. Karşılaştırma

| | OpenAI aboneliği | Anthropic aboneliği | Token saklama | Kimlik dürüstlüğü |
| --- | --- | --- | --- | --- |
| Hermes | Kendi OAuth (browser + device), ayrı store | Claude Code taklidi + borrowed creds + sınıflandırıcı kaçınma; yalnız Max + extra usage | `~/.hermes/auth.json` | OpenAI: dürüst; Anthropic: taklit |
| pi-ai | Kendi OAuth, `originator: pi` | Claude Code taklidi | `auth.json` (cwd) / store | OpenAI: dürüst; Anthropic: taklit |
| OMP | Kendi OAuth, `originator: omp` | Claude Desktop/Cowork cloaking | SQLite + broker | OpenAI: dürüst; Anthropic: taklit |
| OpenCode | Kendi OAuth, `originator: opencode`, OpenAI ile iş birliği | Kaldırıldı (hukuki talep) | OpenCode `auth.json` | Dürüst |
| OpenClaw (not) | Codex OAuth + app-server runtime | Kullanıcının Claude CLI'ı / `claude -p` + setup-token | SQLite | Claude CLI'ı sürüyor |

**Synorch için çıkan desen:** OpenAI için OpenCode/pi deseni (kendi OAuth, dürüst originator, ayrı token store, tek uçuşlu refresh). Anthropic için hiçbir referansın doğrudan OAuth yolu örnek alınmamalı; en yakın uyumlu desen OpenClaw'ın "kullanıcının Claude CLI'ını sür" yaklaşımıdır ([cli-bridges.md](./cli-bridges.md)).
