# Anthropic: Claude Pro/Max abonelik OAuth'u ve politika analizi

> Statü: araştırma; runtime uygulanmadı. İnceleme: 2026-09-22. **Sonuç: Synorch'un Claude.ai OAuth akışını doğrudan uygulaması Anthropic'in mevcut resmi politikasına aykırıdır; bu belge yalnız bağlam ve "neden yapmıyoruz" kaydı içindir.** Uyumlu yol için [cli-bridges.md](./cli-bridges.md) ve [recommendation.md](./recommendation.md).

Etiketler: **[Doküman]** Anthropic resmi belge/şartname. **[Kod]** üçüncü taraf açık kaynak kodda görüldü (Claude Code CLI çekirdeği açık kaynak değil; Anthropic OAuth parametrelerini üçüncü taraflar için belgelemiyor). **[İkincil]** haber/sosyal medya aktarımı. **[Çıkarım]** bizim yorumumuz.

## 1. Resmi politika (verbatim)

### 1.1 Claude Code "Legal and compliance" — Authentication and credential use

Kaynak: <https://code.claude.com/docs/en/legal-and-compliance> (erişim 2026-09-22) [Doküman]

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."

> "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."

> "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Aynı sayfa: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

### 1.2 Agent SDK overview / quickstart

Kaynak: <https://code.claude.com/docs/en/agent-sdk/overview> [Doküman]

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."

### 1.3 Consumer Terms of Service (Free/Pro/Max için geçerli)

Kaynak: <https://www.anthropic.com/legal/consumer-terms>, "Effective October 8, 2025" [Doküman]. Yasaklı kullanımlar arasında:

> "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

### 1.4 Uygulama (enforcement) kronolojisi

| Tarih | Olay | Kaynak |
| --- | --- | --- |
| 2026-01-09 | Anthropic, Claude Code kimliğini taklit eden istekleri sunucu tarafında engelledi. OpenCode kullanıcıları: "This credential is only authorized for use with Claude Code and cannot be used for other API requests." | [OpenCode #7471](https://github.com/anomalyco/opencode/issues/7471) [Kod/issue]; Thariq Shihipar alıntısı: "Third-party harnesses using Claude subscriptions create problems for users and are prohibited by our Terms of Service." ([texxr aktarımı](https://texxr.com/1154696/anthropic-adds-safeguards-against-claude-spoofing)) [İkincil] |
| 2026-02-19 | Legal sayfasına "Authentication and credential use" bölümü eklendi; aynı gün OpenCode tüm Claude OAuth kodunu kaldırdı: commit [`973715f3da1839ef2eba62d4140fe7441d539411`](https://github.com/anomalyco/opencode/commit/973715f3da1839ef2eba62d4140fe7441d539411) ("anthropic legal requests") | [İkincil: shareuhack](https://www.shareuhack.com/en/posts/opencode-anthropic-legal-controversy-2026), commit [Kod] |
| 2026-04-04 | Abonelik limitleri üçüncü taraf harness'larda (önce OpenClaw) kullanılamaz; Claude login ile kullanım "extra usage" (kullandıkça öde) üzerinden. Boris Cherny: "Starting tomorrow at 12pm PT, Claude subscriptions will no longer cover usage on third-party tools like OpenClaw. You can still use these tools with your Claude login via extra usage bundles (now available at a discount), or with a Claude API key." Sözcü: "Using Claude subscriptions with third-party tools isn't permitted under our Terms of Service…" | [The Register](https://www.theregister.com/software/2026/04/06/anthropic-closes-door-on-subscription-use-of-openclaw/5222854), [HN e-posta metni](https://news.ycombinator.com/item?id=47633396) [İkincil] |
| 2026-05-13 → 2026-06-15 | Agent SDK / `claude -p` / "third-party apps that authenticate with your Claude subscription through the Agent SDK" için ayrı aylık kredi duyuruldu; yürürlük günü **durduruldu**. Güncel metin: "For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." | <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan> [Doküman], [The New Stack](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/) [İkincil] |

### 1.5 Yorum

- Doğrudan OAuth (bizim uygulamamızın `claude.ai/oauth/authorize` akışını başlatması, token'ı saklayıp `api.anthropic.com`'a göndermesi) = "offer Claude.ai login" + "route requests through … plan credentials". **İzinli değil.** [Doküman]
- Kullanıcının `~/.claude/.credentials.json` veya macOS Keychain'deki Claude Code token'ını okuyup kendi isteğimizde kullanmak da aynı sınıfa girer ve ayrıca Claude Code'un refresh token rotasyonunu bozar. **İzinli değil.** [Çıkarım, Hermes kodundaki rotasyon notlarıyla destekli]
- Anthropic, istemci parmak izine göre faturalandırma sınıflandırması yapıyor: üçüncü taraf olarak algılanan OAuth trafiği "extra usage"a yönleniyor (Hermes yorumu: HTTP 400 "Third-party apps now draw from extra usage" / "You're out of extra usage"). [Kod: Hermes `agent/anthropic_adapter.py`]
- Destek makalesindeki "third-party apps that authenticate with your Claude subscription through the Agent SDK" ifadesi, Agent SDK üzerinden kullanıcı aboneliğiyle çalışan üçüncü taraf uygulamaların varlığını Anthropic'in tanıdığını gösteriyor; ancak Agent SDK dokümanındaki "Unless previously approved…" cümlesiyle çelişiyor. **Durum: belirsiz; yazılı onay gerekir.** [Çıkarım]

## 2. Teknik akış (yalnız referans — UYGULANMAYACAK)

Aşağıdakiler Claude Code'un public client'ını kullanan üçüncü taraf kodlardan derlenmiştir. Anthropic bu parametreleri üçüncü taraflar için belgelemez; değerler taraf taraf farklıdır.

| Öğe | Gözlenen değer | Kaynak |
| --- | --- | --- |
| `client_id` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code'un client'ı; pi-ai base64 ile gizliyor) | [Kod] Hermes `agent/anthropic_credentials.py:36`, pi-ai `packages/ai/src/auth/oauth/anthropic.ts:29` |
| Authorize | `https://claude.ai/oauth/authorize?code=true&response_type=code&client_id=…&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256&state=…` | [Kod] pi-ai `anthropic.ts:247-256`, Hermes `:752-762` |
| Redirect | pi-ai: `http://localhost:53692/callback`; Hermes: `https://console.anthropic.com/oauth/code/callback` (kullanıcı `code#state` yapıştırır) | [Kod] |
| Token | `https://platform.claude.com/v1/oauth/token` (JSON). Hermes: `console.anthropic.com/v1/oauth/token` artık 404; OMP dokümanı `api.anthropic.com/v1/oauth/token` diyor | [Kod] pi-ai `:31`, Hermes `:37-40`, OMP `docs/provider-quirks.md:167` |
| Scope | pi-ai: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`; Hermes: `org:create_api_key user:profile user:inference` | [Kod] |
| Exchange gövdesi | `{grant_type:"authorization_code", client_id, code, state, redirect_uri, code_verifier}` | [Kod] pi-ai `:200-209` |
| Refresh | `{grant_type:"refresh_token", client_id, refresh_token}`; refresh token tek kullanımlık rotasyonlu | [Kod] pi-ai `:321-327`, Hermes `:448-460,572-605` |
| Access token | `sk-ant-oat…` öneki; `expires_in` saniye | [Kod] pi-ai `anthropic-messages.ts:906-907` |
| Grant ömrü | OMP: mutlak 30 gün, sonra etkileşimli yeniden giriş | [Kod] OMP `docs/provider-quirks.md:167` |
| Claude Code saklama | macOS Keychain; Linux `~/.claude/.credentials.json` (0600); Windows `%USERPROFILE%\.claude\.credentials.json`. Şema: `{"claudeAiOauth":{"accessToken","refreshToken","expiresAt",…}}`; Keychain servis adı `Claude Code-credentials` | [Doküman] <https://code.claude.com/docs/en/authentication>; şema/servis adı [Kod] Hermes `:217-235,49` |
| Uzun ömürlü token | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (CI için) | [Doküman] authentication sayfası |

### İstek şekli (üçüncü tarafların taklit ettiği)

- `Authorization: Bearer sk-ant-oat…`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`. [Kod] pi-ai `anthropic-messages.ts:1017`, Hermes `anthropic_adapter.py:216`
- `system[0] = "You are Claude Code, Anthropic's official CLI for Claude."` zorunlu tutuluyor. [Kod] pi-ai `:1078-1083`, Hermes `:282`
- `user-agent: claude-cli/<sürüm>` veya `claude-code/<sürüm> (external, cli)`, `x-app: cli`; Hermes "Anthropic rejects OAuth requests whose user-agent version is too far behind" notuyla kurulu `claude --version` değerini okuyor. [Kod]
- Tool adlarını Claude Code adlarına eşleme (pi-ai `toClaudeCodeName`), `mcp__` önekine zorlama ve "billing classifier"dan kaçmak için tool takma adları (Hermes `_OAUTH_TOOL_NAME_ALIASES`). [Kod]
- OMP daha ileri gidiyor: Claude Desktop/Cowork parmak izi, cihaz kimliği üretimi, `cch=` "billing attestation" hash'i. [Kod] OMP `docs/provider-quirks.md:153`

**Neden yapmıyoruz:** Bu teknikler kimlik taklidi ve uygulama önlemlerinden kaçınmadır. Consumer Terms'ün otomatik erişim yasağı ve legal sayfadaki açık yasakla çelişir; kullanıcı hesabının askıya alınması riski kullanıcıya yüklenir. Synorch'un [güvenlik ilkeleri](../../design/providers-and-configuration.md) "yalnızca sağlayıcının resmi API key, OAuth/device-code veya kurumsal gateway yöntemi" der; bu akış Anthropic'in Synorch için sunduğu resmi bir OAuth değildir.

## 3. Uyumlu seçenekler

1. **API key** (Claude Console) — tamamen izinli. [api-keys.md](./api-keys.md)
2. **Kullanıcının kendi kurduğu ve kendi giriş yaptığı Claude Code'u sürmek** (`claude -p --output-format stream-json` veya `@anthropic-ai/claude-agent-sdk`). Claude Code kendi kimliğiyle, kendi token'ıyla istek atar; Synorch token görmez. Politika durumu **belirsiz**, ayrıntı [cli-bridges.md](./cli-bridges.md) §1 ve [README](./README.md).
3. **Anthropic'ten yazılı onay** ("Unless previously approved") — satış ekibi: legal sayfası "please contact sales" diyor. Ürün sahibi için açık soru.
4. Kurumsal kullanıcılar için Bedrock / Vertex / Foundry / Claude Platform on AWS — API faturalamalı, izinli.
