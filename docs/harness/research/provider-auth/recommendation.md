# Öneri: `ModelAdapter` katmanı için kimlik doğrulama mimarisi

> Statü: öneri; uygulanmadı, ADR ile kapanmalı. İnceleme: 2026-09-22. Dayanak: bu klasördeki araştırma belgeleri. [Sağlayıcı tasarımı](../../design/providers-and-configuration.md) ve [açık kararlar](../../delivery/decisions.md) ile birlikte okunmalı.

## 1. Kısa hüküm

| Hedef | Yapılabilir mi? | Nasıl |
| --- | --- | --- |
| ChatGPT Plus/Pro ile giriş, harness içinde OpenAI modellerini çalıştırma | **Evet** (OpenAI kamuya açık destekliyor; sözleşme yazılı değil) | Synorch'un kendi Codex OAuth akışı → `chatgpt.com/backend-api/codex/responses`, `originator: synorch` |
| Claude Pro/Max ile giriş, harness içinde Claude modellerini çalıştırma | **Doğrudan: hayır** (resmi yasak). **Köprüyle: belirsiz** | Kullanıcının kendi Claude Code kurulumunu Agent SDK / `claude -p` ile sürmek; açık opt-in + uyarı; Anthropic'ten yazılı onay istenmeli |
| API key fallback | **Evet** | Anthropic Messages + OpenAI Responses adapter'ları |

Ürün sahibinin "Hermes gibi" beklentisi Anthropic tarafında karşılanamaz: Hermes'in kendi dokümanı OAuth yolunun abonelik kotasını değil, Max + satın alınmış "extra usage"ı tükettiğini ve Claude Code taklidine dayandığını söylüyor ([reference-implementations.md](./reference-implementations.md) §1).

## 2. Adapter aileleri

Mevcut tasarımdaki `ModelAdapter` (`discoverCapabilities`, `prepareRequest`, `stream`, `cancel`, `usage`, `health` — [orchestration-contracts](../../design/orchestration-contracts.md)) istek bazlıdır ve döngüyü Synorch'un yönettiğini varsayar. Köprüler için ikinci bir arayüz gerekir.

```text
AuthProvider (kimlik)            ModelAdapter (Synorch döngüsü)        AgentBackendAdapter (backend döngüsü)
- openai-chatgpt-oauth    ──────▶ openai-chatgpt   (Responses/SSE)
- openai-api-key          ──────▶ openai-responses (Responses/SSE)
- anthropic-api-key       ──────▶ anthropic-messages
- (yok: Synorch token görmez) ──────────────────────────────────────▶ claude-code (Agent SDK | claude -p)
- codex-managed (Codex kendi login'i) ─────────────────────────────▶ codex-app-server
```

- **`AuthProvider`**: `login(interaction)`, `refresh(credential, signal)`, `status()`, `logout()`, `toRequestAuth()`; yalnız Synorch'un sahip olduğu kimlikler için. Köprülerde auth, backend'e aittir; Synorch yalnız durum okur (`apiKeySource`, `account/read`).
- **`ModelAdapter`**: mevcut sözleşme. `openai-chatgpt` ve `openai-responses` aynı Responses kodunu paylaşır; fark base URL, header seti, `store:false` zorunluluğu, kota header'ları ve model listesi kaynağıdır.
- **`AgentBackendAdapter`** (yeni, öneri): `startSession(opts)`, `runTurn(input, toolBridge, approvalBridge) → event stream`, `interrupt()`, `resume(sessionId)`, `usage()`, `health()`. Synorch araçları `toolBridge` üzerinden verilir (Claude: süreç içi MCP; Codex: `dynamicTools`), yerleşik araçlar kapatılır. Rol/izin kararı yine Synorch'tadır; backend yalnız "model + döngü" sağlar.

Capability çıktısına eklenecek alanlar: `auth_method: subscription-oauth | api-key | backend-managed`, `billing: subscription | metered | unknown`, `quota_visibility: headers | api | none`, `loop_owner: synorch | backend`, `policy_status: permitted | unclear`.

## 3. Uygulama önceliği

| Öncelik | Adapter | Gerekçe |
| --- | --- | --- |
| P0 | `anthropic-messages` (API key) | İzinli, kararlı; Claude için kesin çalışan tek yol |
| P0 | `openai-responses` (API key) | İzinli, kararlı; `openai-chatgpt` ile kod paylaşımı |
| P0 | `openai-chatgpt` (Codex OAuth, browser + device-code) | Ürün şartının OpenAI yarısı; OpenAI kamuya açık destekliyor. [Şartname](./openai-chatgpt-oauth.md) |
| P1 | `claude-code` köprüsü (Agent SDK tercih, `claude -p` yedek) | Ürün şartının Anthropic yarısına en yakın uyumlu yol; **deneysel bayrak + açık opt-in**; Anthropic onayı beklenirken |
| P2 | `codex-app-server` köprüsü | `openai-chatgpt` endpoint'i kırılırsa/kısıtlanırsa Plan B; OpenAI'nin belgelenmiş entegrasyon yüzeyi |
| Asla | Claude.ai OAuth'u doğrudan uygulamak, `~/.claude/.credentials.json`/Keychain okumak, Claude Code kimliği/UA/sistem öneki taklidi, faturalandırma sınıflandırıcısından kaçınma, hesap havuzu/rotasyon, aboneliği proxy/API olarak dışarı açma | Anthropic legal + Consumer Terms; OpenAI "sub2api" uyarısı |

## 4. Kimlik bilgisi saklama

1. **Birincil: OS keychain** — macOS Keychain, Windows Credential Manager, Linux Secret Service (libsecret). Servis adı `synorch`, hesap anahtarı `<provider>:<profile>`. Node ≥24 için native keyring kütüphanesi seçimi ayrı bağımlılık kararıdır **[Açık karar]** (lisans, prebuilt binary, Windows desteği).
2. **Fallback: dosya** — `~/.synorch/credentials.json` (veya `$SYNORCH_HOME`), atomik yazma (temp + rename), Unix `0600`, dizin `0700`; Windows'ta kullanıcı profili ACL'i (Claude Code'un Windows davranışıyla aynı). Keychain yoksa kullanıcıya açıkça "düz dosyaya yazılıyor" uyarısı.
3. Şema (öneri): `{ version, profiles: { "<id>": { provider, method: "chatgpt-oauth"|"api-key", access, refresh, expires_at, account_id, plan_type, originator, created_at, last_refresh } } }`. ChatGPT için `account_id` ve `plan_type` JWT'den türetilip önbelleklenir.
4. **Refresh güvenliği:** profil başına süreçler arası kilit + süreç içi tek uçuşlu refresh; refresh yanıtı gelmeden eski token silinmez; kalıcı hata (`refresh_token_reused/expired/invalidated`, `invalid_grant`, 401) → profil "yeniden giriş gerekli" durumuna.
5. **Başka uygulamaların deposu okunmaz/yazılmaz** (`~/.codex/auth.json`, `~/.claude/.credentials.json`). İstisna önerisi yok; kullanıcı Codex'i zaten kullanıyorsa bile Synorch kendi girişini yapar.
6. Secret'lar log, task packet, tool env, diff ve audit'e yazılmaz; audit yalnız `profile_id`, `provider`, `method`, `plan_type` taşır. Worker alt süreçlerine (ve köprü alt süreçlerine) `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` sızdırılmaz — köprüde bunlar bilinçli olarak env'den silinir.

## 5. Kullanıcıya gösterilecekler

**ChatGPT girişi (ilk bağlantı):**
> "ChatGPT hesabınızla giriş yapıyorsunuz. Synorch istekleri OpenAI'nin Codex altyapısına sizin planınızın kullanım limitleriyle gönderir; API faturası oluşmaz. Bu erişim OpenAI'nin yazılı bir üçüncü taraf sözleşmesine değil, kamuya açık desteğine dayanır ve değişebilir. Hesabınızı paylaşmayın; Synorch'u başkalarına hizmet olarak açmayın."

Ayrıca: bağlı hesap/workspace etiketi ve plan türü; `x-codex-primary/secondary-*` header'larından kota yüzdesi ve sıfırlanma zamanı; `usage_limit_reached` durumunda reset zamanı ve "API key'e geçilsin mi?" onayı (sessiz geçiş yok).

**Claude köprüsü (opt-in):**
> "Deneysel: Synorch, bilgisayarınızda kurulu ve sizin giriş yaptığınız Claude Code'u çalıştırır. Synorch Claude kimlik bilgilerinizi görmez. Anthropic, üçüncü taraf ürünlerin Claude aboneliği kullanımını kısıtlıyor; bu kullanım aboneliğiniz yerine ek ücretli 'extra usage'dan düşebilir veya Anthropic tarafından engellenebilir. Kesin ve desteklenen yol Claude API anahtarıdır."

Ayrıca: `apiKeySource` değerini göster ("Claude aboneliği" / "API key"); `Login expired` için "`claude /login` çalıştırın" yönlendirmesi; Claude Code sürümü ve bulunamazsa kurulum bağlantısı.

**API key:** maliyetin kullanıcının API hesabına yazılacağı; key'in keychain'e kaydedileceği.

## 6. Doğrulama ölçütleri (uygulama sprinti için)

- ChatGPT: browser + device-code giriş, refresh (süresi dolmuş access token), iptal (stream abort), 429 `usage_limit_reached` simülasyonu, `store:false` + encrypted reasoning ile çok turlu araç çağrısı, residency header'lı hesap, 1455 meşgulken davranış.
- Claude köprüsü: `ANTHROPIC_API_KEY` set iken env temizliği sonrası `apiKeySource` = abonelik; `--tools ""` ile yerleşik araç olmadığının `system/init.tools` ile kanıtı; MCP araç çağrısı + izin; `interrupt()`; resume; `Login expired` hatası.
- Sözleşme testleri kayıtlı fixture ile (gerçek hesap CI'da kullanılmaz); canlı smoke testi manuel ve kullanıcının kendi hesabıyla.

## 7. Ürün sahibine açık sorular

1. **Anthropic onayı:** Anthropic'e (satış/partner) "Synorch, kullanıcının kendi Claude Code kurulumunu Agent SDK ile sürüyor; abonelik limitleriyle kullanım izinli mi?" diye yazılı başvuru yapılacak mı? Onay gelene kadar Claude köprüsü varsayılan kapalı + deneysel kalabilir mi?
2. Claude köprüsünde kullanım "extra usage"a düşerse (kullanıcıya ek maliyet) bu kabul edilebilir mi, yoksa köprü o durumda devre dışı mı bırakılmalı?
3. Synorch dağıtımı ücretli/ticari olacak mı? (OpenAI plugin'lerinin ortak uyarısı ve Anthropic'in "products or services" dili ticari dağıtımda riski artırır.)
4. OpenAI'ye `clientInfo.name`/`originator` = `synorch` için "known clients" kaydı başvurusu yapılacak mı (kurumsal Compliance Logs için)?
5. Kurumsal kullanıcılar için Bedrock/Vertex/Foundry (Claude) ve Azure OpenAI yolları ilk sürümde gerekli mi?
6. Kullanıcı ChatGPT kotası dolunca API key'e geçiş: her seferinde onay mı, oturum başına bir kez mi, hiç mi?
7. Claude köprüsünde Synorch'un kendi transkripti ile Claude Code transkripti çift tutulacak; hangi taraf "kaynak doğruluk" olacak? (Resume stratejisi.)
8. Keychain bağımlılığı (native modül) kabul edilebilir mi, yoksa yalnız `0600` dosya ile başlanıp keychain sonra mı eklenecek?
9. Codex app-server köprüsü P2 mi, yoksa `openai-chatgpt` doğrudan yolu yerine birincil mi olmalı (daha resmi yüzey, ama döngü Codex'te)?

## 8. Karar kaydı önerisi

[`delivery/decisions.md`](../../delivery/decisions.md) madde 2 ("İlk sağlayıcı/model erişim yolu… abonelik erişimi otomatik varsayılmayacak") bu araştırmayla şu ADR adaylarına ayrılabilir: **ADR-auth-1** OpenAI ChatGPT OAuth doğrudan adapter; **ADR-auth-2** Anthropic yalnız API key + deneysel Claude Code köprüsü; **ADR-auth-3** credential store (keychain + 0600 fallback); **ADR-auth-4** `AgentBackendAdapter` arayüzü.
