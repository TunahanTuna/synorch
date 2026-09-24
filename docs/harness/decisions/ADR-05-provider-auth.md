# ADR-05: Sağlayıcılar ve kimlik doğrulama

## Status

Accepted

## Date

2026-09-22

## Context

Ürün şartı: kullanıcı OpenAI ChatGPT aboneliği ve Anthropic Claude aboneliği ile giriş yapıp modelleri harness içinde kullanabilmeli; API key yedek yoldur. Araştırma ([provider-auth](../research/provider-auth/README.md)) şunu gösterdi: OpenAI "Sign in with ChatGPT"ın üçüncü taraf istemcilerde kullanımını kamuya açık destekliyor (yazılı sözleşme yok); Anthropic ise üçüncü tarafların Claude.ai girişi sunmasını ve plan kimlik bilgileriyle istek yönlendirmesini açıkça yasaklıyor ([anthropic-claude-oauth](../research/provider-auth/anthropic-claude-oauth.md)). Kullanıcının kendi kurulu Claude Code'unu sürmek "belirsiz" statüdedir ([cli-bridges](../research/provider-auth/cli-bridges.md)). Mevcut `ModelAdapter` taslağı döngüyü Synorch'un yönettiğini varsayar; köprüler için ikinci bir arayüz gerekir ([recommendation](../research/provider-auth/recommendation.md)).

## Decision

**Auth yöntemleri** (`AUTH_METHODS`): `oauth-subscription`, `cli-bridge`, `api-key`. Bir sağlayıcı birden çok yöntem ve profil taşıyabilir; kimlik `(provider, method, profile)` üçlüsüdür.

**İki adapter ailesi**, aynı `ModelStreamEvent` sözleşmesini üretir:

- `ModelAdapter` — döngü Synorch'ta; tek istek → tek stream; stream başladıktan sonra throw etmez.
- `AgentBackendAdapter` — döngü kullanıcının resmi istemcisinde; yerleşik araçlar kapalı, Synorch araçları `ToolBridge` (MCP / dynamic tools) üzerinden verilir ve her çağrı `ToolGateway`'den geçer; policy, olaylar, packet'ler ve audit değişmez. `backend_init.tools` listesinde `mcp__synorch__*` dışında araç varsa tur `protocol_mismatch` ile durdurulur.

**OpenAI**

- P0 `openai-chatgpt` (`oauth-subscription`): Synorch'un kendi PKCE akışı, loopback `localhost:1455`, device-code yedeği, `originator: synorch`, `store:false`, her istekte tam geçmiş yeniden gönderimi.
- P0 `openai-responses` (`api-key`): Responses API.
- P2 Codex app-server köprüsü: yalnız seam (`AgentBackendAdapter`); plan B.

**Anthropic**

- P0 `anthropic-messages` (`api-key`): Messages API; kesin ve desteklenen yol.
- Claude aboneliği yalnızca `cli-bridge` ile: `claude-code` `AgentBackendAdapter`'ı, kullanıcının kurup giriş yaptığı Claude Code'u `@anthropic-ai/claude-agent-sdk` (tercih) veya `claude -p --input-format stream-json --output-format stream-json` ile sürer; `--tools ""`/`tools: []`; Synorch araçları MCP ile. Alt süreç ortamından `BRIDGE_STRIPPED_ENV` (API key/token adları, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex bayrakları ve token'ı) ile her `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` adı silinir; `apiKeySource` abonelik değilse tur, kullanıcı yapılandırmasında açık opt-in yoksa reddedilir (güvenlik incelemesi SEC-M2). Deneysel, açık opt-in; tek seferlik uyarı (`claude-bridge-experimental`): politika statüsü belirsiz, kullanım "extra usage"a düşebilir.

**Açık non-goal'lar (hard rail `foreign-credential-store`):**

- Claude.ai OAuth akışını doğrudan uygulamak.
- `~/.claude`, `~/.codex` veya Claude Code keychain girdisini okumak/yazmak (`FORBIDDEN_CREDENTIAL_SOURCES`).
- Claude Code kimliği, UA veya sistem öneki taklidi; faturalandırma tespitinden kaçınma; hesap havuzu, rotasyon veya aboneliği proxy/API olarak dışarı açma.

**Kimlik bilgisi saklama**

- `CredentialStore` soyutlaması; önce OS keychain (servis `synorch`, hesap `<provider>:<method>:<profile>`).
- Yedek: `~/.synorch/credentials.json`, mod `0600`, dizin `0700`, atomik yazma; kullanıcıya açık `plaintext-credential-file` uyarısı.
- Profil başına süreçler arası refresh kilidi (`withRefreshLock`); yeni token yazılmadan eski silinmez; kalıcı hata → `login_required`.
- `cli-bridge` için secret şeması yoktur; Synorch köprü token'ı görmez.
- Ücretli API key'e sessiz geçiş yok: `provider-change` onayı yalnızca insan tarafından verilebilir ([ADR-08](./ADR-08-approval-policy.md)).
- Yapılandırma güven katmanları (SEC-C1): adapter, `base_url`, route ve profil yalnız kullanıcı yapılandırmasından (`<home>/config.yaml`) ve açık oturum bayraklarından gelir; repo içindeki `.synorch/config.yaml` yalnız policy'yi daraltabilir ve bütçeyi küçültebilir, diğer anahtarları uyarıyla yok sayılır. `base_url` sağlayıcının resmi origin'ine sabitlenir; özel endpoint kullanıcı girdisinde `allow_custom_endpoint: true` ister, ChatGPT OAuth token'ı resmi olmayan host'a hiçbir koşulda gönderilmez ([CLI referansı §11](../reference/cli.md)).
- Keychain native bağımlılığının seçimi I2'ye bırakılan alt karardır.

## Alternatives

- **Hermes/OMP tarzı doğrudan Claude OAuth:** Anthropic legal ve Consumer Terms ile yasak; sunucu tarafı engelleme ve hesap riski. Reddedildi.
- **Yalnız API key:** Ürün şartını karşılamaz. Reddedildi.
- **OpenAI için birincil yol olarak Codex app-server:** Daha resmi yüzey ama döngü Codex'te; P2 yedek olarak tutuldu.
- **Kullanıcının mevcut Codex/Claude token dosyalarını yeniden kullanmak:** Başka uygulamanın deposuna dokunmak; reddedildi.

## Consequences

- OpenAI ChatGPT yolu belgelenmemiş iç endpoint'e bağlı; kırılırsa kullanıcıya açık hata ve API key/app-server seçeneği sunulur.
- Claude köprüsünde transkript çift tutulur; Synorch event log'u denetim kaynağıdır, Claude Code oturumu yalnız resume içindir.
- `--bare`'in gelecekte `-p` varsayılanı olması köprüyü kırabilir; `doctor --runtime` sürüm ve `apiKeySource` raporlar.

## Evidence

- [provider-auth README](../research/provider-auth/README.md), [recommendation](../research/provider-auth/recommendation.md), [openai-chatgpt-oauth](../research/provider-auth/openai-chatgpt-oauth.md), [anthropic-claude-oauth](../research/provider-auth/anthropic-claude-oauth.md), [cli-bridges](../research/provider-auth/cli-bridges.md), [api-keys](../research/provider-auth/api-keys.md), [reference-implementations](../research/provider-auth/reference-implementations.md).
- `src/harness/contracts/auth.ts` (`AUTH_METHODS`, `credentialSecretSchema`, `FORBIDDEN_CREDENTIAL_SOURCES`, `BRIDGE_STRIPPED_ENV`, `AuthProvider`, `CredentialStore`), `model.ts` (`ModelAdapter`, `AgentBackendAdapter`, `providerCapabilitiesSchema`, `ToolBridge`).
- Canlı giriş, refresh ve köprü deneyleri **henüz yapılmadı**; kayıtlı fixture ve kullanıcı hesabıyla manuel smoke I2'de.
- Sözleşme: [model adapter](../contracts/model-adapter.md).

## Verification

- `tests/harness-contracts.test.ts`: capability refinement'ları (agent-backend ⇔ `cli-bridge` ⇔ `loop_owner: backend`, backend `native` araç kanalı reddi), `cli-bridge` secret'ının saklanamaması, route fallback'inin onay gerektirmesi.
- I2: ChatGPT browser + device-code, süresi dolmuş token refresh, 429 `usage_limit_reached`, 1455 meşgulken davranış; Claude köprüsünde env temizliği sonrası `apiKeySource` = abonelik, `system/init.tools` ile yerleşik araç yokluğu, MCP araç çağrısı, `interrupt()`, `Login expired`; yasaklı kaynakların hiç açılmadığını gösteren fs erişim testi.

## Revisit trigger

Anthropic'in köprü veya üçüncü taraf abonelik kullanımı hakkında yeni politika yayımlaması ya da yazılı onay vermesi; OpenAI'nin ChatGPT OAuth endpoint'ini değiştirmesi veya kısıtlaması; `--bare`'in `-p` varsayılanı olması.

## 2026-09-24 owner revision — Claude Code native mode

Ürün sahibi kararı (bağlayıcı): "Claude Code'u altyapı olarak entegre et; onu devre dışı bırakma niyetimiz yok; Claude Code'un her yeteneğini kullan; pahalıya mal olacak şeyi yeniden icat etme."

- `claude-code` adapter'ının iki modu vardır; seçim yalnız **kullanıcı yapılandırmasında** `claude_code.mode: native | restricted` ile yapılır (varsayılan `native`; repo katmanındaki anahtar yok sayılır ve uyarı verir; `syn config set claude_code.mode restricted`).
- **native**: Claude kendi yerleşik araç setinin tamamıyla çalışır (Bash, Read, Edit/Write, Grep, Glob, WebSearch, WebFetch, TodoWrite, Task/alt ajanlar, ...); `--tools ""` verilmez. Synorch MCP sunucusu bağlı kalır (orkestrasyon/rapor/kontrol araçları: `task_report`, `review_report`, `plan_propose`, `ask_user`, `memory_propose`, ...); `ToolBridge` listesi değişmez ve yalnız `mcp__synorch__*` çağrıları Synorch araç çağrısıdır. Yerleşik `tool_use` blokları assembler'a iletilmez; `backend_init` içindeki yerleşik araçlar ve yerleşik `tool_use` artık `protocol_mismatch` değildir (adapter ve driver'daki `rejectForeignBackendTools` yalnız `restricted` için çalışır; adapter `nativeTools: true` bildirir).
- `--setting-sources user`: kullanıcının kendi Claude ayarları (izin kuralları, skill'ler, eklentiler) yüklenir; repo'nun yerleştirebileceği project/local ayarları ve `.mcp.json` yüklenmez (`--strict-mcp-config` kalır). `--add-dir` yalnız oturumun çalışma köküne (worker için attempt worktree'si, oturum için workspace) verilir; `cwd` da odur.
- Abonelik kimliği ve SEC-M2 değişmez: API anahtarı değişkenleri çocuk süreçten silinir, `system/init.apiKeySource` abonelik değilse tur reddedilir. `--bare` hâlâ kullanılmaz.
- **restricted**: bugünkü davranışın aynısı (`--tools ""`, `--setting-sources ""`, init-tools `protocol_mismatch` denetimi). Doğrudan kurulan adapter'ın API varsayılanı `restricted`'dır; runtime yapılandırmadaki modu (varsayılan `native`) geçirir.
- Gözlemlenebilirlik: Claude'un yerleşik `tool_use` / `tool_result` stream-json olayları oturum günlüğüne eklemeli `backend/tool_observed` olayları olarak yazılır (`source: claude-code-native`, `phase started|finished`, araç adı, girdi/sonuç özeti — redaksiyondan geçer) ve TUI'de araç satırı olarak görünür (`✓ Bash pnpm test  12 passed`, `✓ Edit src/x.ts +3 −1`, `✓ Search (Claude) "q"`, `✓ Fetch (Claude) host/path`). Bunlar model konuşma geçmişine araç sonucu olarak **girmez** (çapraz sağlayıcı geçmişi bozulmasın diye). Alt ajan (Task) mesajları (`parent_tool_use_id`) konuşma metnine karışmaz.
- İzin yönlendirmesi ve kalan risk: [ADR-08](./ADR-08-approval-policy.md) 2026-09-24 native mode revizyonu.
