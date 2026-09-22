# Sağlayıcı kimlik doğrulama: abonelik girişi ve API key

> Statü: araştırma ve öneri; runtime uygulanmadı. İnceleme ve web erişim tarihi: 2026-09-22. Ürün şartı: kullanıcı OpenAI (ChatGPT Plus/Pro) ve Anthropic (Claude Pro/Max) aboneliğiyle giriş yapıp modelleri harness içinde kullanabilmeli; API key yedek yol olmalı.

## Belgeler

| Belge | İçerik |
| --- | --- |
| [openai-chatgpt-oauth.md](./openai-chatgpt-oauth.md) | Codex "Sign in with ChatGPT" teknik şartnamesi: endpoint'ler, PKCE, device-code, token dosyası, refresh, istek/SSE, header'lar, hata kodları |
| [anthropic-claude-oauth.md](./anthropic-claude-oauth.md) | Claude.ai OAuth: politika metinleri (verbatim), enforcement kronolojisi, üçüncü tarafların kullandığı teknik akış (uygulanmayacak) |
| [cli-bridges.md](./cli-bridges.md) | Kullanıcının kendi Claude Code / Codex kurulumunu sürmek: `claude -p` stream-json, Agent SDK, `codex exec --json`, `codex app-server` |
| [reference-implementations.md](./reference-implementations.md) | Hermes, pi-ai, Oh My Pi, OpenCode incelemesi (commit SHA ve dosya yollarıyla) |
| [api-keys.md](./api-keys.md) | Anthropic Messages ve OpenAI Responses API key yolları (kısa) |
| [recommendation.md](./recommendation.md) | `ModelAdapter` katmanı için önerilen mimari, öncelik, saklama, kullanıcı uyarıları, açık sorular |

## Bilgi statüsü etiketleri

Klasördeki belgeler [harness bilgi statüsü](../../README.md#bilgi-statüsü) sistemini kullanır ve dış kaynak bulgularını ayrıca işaretler: **[Kod]** kaynak kodunda görüldü, **[Doküman]** sağlayıcının resmi belgesi/şartnamesi, **[Referans]** üçüncü taraf açık kaynak uygulamada görüldü ama sağlayıcı belgelememiş, **[İkincil]** haber/sosyal medya aktarımı, **[Çıkarım]** bizim yorumumuz. Öneriler ve açık kararlar ayrıca belirtilir.

## Özet tablo

| Sağlayıcı × yöntem | Nasıl çalışır | Resmi olarak izinli mi? | Risk | Öneri |
| --- | --- | --- | --- | --- |
| **OpenAI — abonelik OAuth (doğrudan)** | Synorch kendi PKCE/device-code akışıyla Codex CLI'ın public `client_id`'si ile `auth.openai.com`'dan token alır; `chatgpt.com/backend-api/codex/responses`'a `Authorization` + `ChatGPT-Account-ID` + `originator: synorch` ile istek atar | **Evet (yazılı sözleşme yok).** "Developers should code in the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else" ([Codex for OSS](https://developers.openai.com/community/codex-for-oss)); OpenCode ile iş birliği (2026-01); Tibo Sottiaux 2026-08-21: OSS istemcilerde Sign in with ChatGPT desteklenir, "sub2api" desteklenmez ([ikincil](https://explainx.ai/blog/codex-usage-limits-sub2api-sign-in-chatgpt-august-2026)). Terms: "Automatically or programmatically extract data or Output" yasak ([Terms of Use](https://openai.com/policies/row-terms-of-use/)) — Codex'in kendisi de programatik olduğundan bu madde pratikte bu kullanımı hedeflemiyor [Çıkarım] | Orta: belgelenmemiş iç endpoint, değişebilir; `client_id` Codex'e ait; kota hızlı tükenebilir | **Uygula (P0)** |
| **OpenAI — Codex app-server köprüsü** | Kullanıcının `codex` ikilisi alt süreç; JSON-RPC; giriş Codex'te; Synorch araçları `dynamicTools` ile | **Evet.** "Choose the App Server when you want the full Codex harness exposed as a stable, UI-friendly event stream" ([OpenAI blog](https://openai.com/index/unlocking-the-codex-harness/)); Apache-2.0 | Düşük–orta: `dynamicTools` deneysel; döngü Codex'te | **P2 / Plan B** |
| **OpenAI — `codex exec --json`** | Tek seferlik alt süreç, JSONL olaylar | Evet (resmi doküman) | Düşük; ama araç/izin kontrolü kaba | Basit worker görevleri için opsiyonel |
| **OpenAI — API key** | `api.openai.com/v1/responses` | **Evet** | Düşük | **Uygula (P0)** |
| **Anthropic — abonelik OAuth (doğrudan)** | Claude Code'un public `client_id`'si + `claude.ai/oauth/authorize`; istekte Claude Code kimliği taklidi (beta header, sistem öneki, UA) | **Hayır.** "Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users." ([legal](https://code.claude.com/docs/en/legal-and-compliance)); Consumer Terms otomatik erişim yasağı | Yüksek: sunucu tarafı engelleme (2026-01-09), "extra usage"a yönlendirme (2026-04-04), hesap askıya alma; kimlik taklidi | **Uygulama** |
| **Anthropic — Claude Code köprüsü (`claude -p` / Agent SDK)** | Kullanıcının kendi kurup giriş yaptığı Claude Code alt süreç; Synorch token görmez; yerleşik araçlar kapalı, Synorch araçları MCP ile | **Belirsiz.** Lehte: "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits" ([support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Aleyhte: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)) ve 2026-04 "third-party harness" → extra usage | Orta–yüksek: politika değişkenliği; `--bare` gelecekte `-p` varsayılanı olup OAuth okumayı kapatabilir; kullanım extra usage'a düşebilir | **Deneysel, açık opt-in (P1); yazılı onay iste** |
| **Anthropic — API key** | `api.anthropic.com/v1/messages` (veya Bedrock/Vertex/Foundry) | **Evet** — Anthropic'in üçüncü taraflar için önerdiği yol | Düşük | **Uygula (P0)** |

## Ana bulgular

1. OpenAI tarafında ürün şartı karşılanabilir; en olgun desen OpenCode/pi'nin dürüst `originator` ile kendi OAuth akışıdır.
2. Anthropic tarafında "Hermes gibi" doğrudan OAuth hem yasak hem de Hermes'in kendi dokümanına göre abonelik kotasını değil Max + extra usage'ı tüketiyor. OMP ve pi-ai de Claude Code/Desktop taklidine dayanıyor; OpenCode hukuki talep üzerine bu kodu kaldırdı.
3. Claude aboneliğine en yakın uyumlu yol kullanıcının kendi Claude Code'unu sürmektir; bu da "belirsiz" statüde ve Synorch'un döngü/araç modelini değiştiren ayrı bir adapter ailesi gerektirir.
4. Tüm yollar için: kendi credential store'umuz (keychain + `0600` fallback), başka uygulamaların token deposuna dokunmama, sessiz ücretli fallback yapmama.

Kaynak dizini: [../sources.md](../sources.md).
