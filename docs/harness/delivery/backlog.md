# Harness geliştirme planı ve hatırlatıcılar

> Durum: yaşayan plan (ürün sahibi + orchestrator). Son güncelleme: 2026-09-24. Bu dosya "ne yapacağız, hangi sırayla, neden" sorusunun tek listesidir. Ayrıntılı tasarım: [ürün gereksinimleri](../foundation/product-requirements.md), [ADR-21](../decisions/ADR-21-conversation-first-runtime.md), [TUI deneyimi](../design/tui-experience.md), [uygulama planı §8](../implementation-plan.md), sahip bağlamı [harness-context.yaml](../harness-context.yaml) / [harness-ux-context.yaml](../harness-ux-context.yaml).

## 🔔 Ürün sahibi için hatırlatıcı

- [ ] **K1 bitince dene:** `node F:\development\Tunahan\tuna\ai-template\dist\cli.js agent` (C:\temp\syn-smoke içinde). Dene: `/` paleti, `@dosya`, görsel yapıştırma (Alt+V), `Shift+Tab` plan modu, `/model`, `/usage`, `/graph`, büyük bir işte canlı worker panosu, çalışırken mesaj yazıp yön verme.
- [ ] **Geri bildirimi yaz:** neyi sevdin, ne rahatsız etti, ne eksik (ekran görüntüsü yeterli).
- [ ] **Claude köprüsünü dene** (çapraz sağlayıcı için gerekli): `syn login anthropic --method cli-bridge`.
- [ ] **CI logları için (isteğe bağlı):** `winget install GitHub.cli` → `gh auth login` — macOS/Windows CI hatalarını hızlı çözmek için.
- [ ] **docs/harness'ı güncellemeye devam et** (ChatGPT ile de); orchestrator her görevde taze okur.

## Tamamlananlar (özet)

| Dönem | Sonuç | Commit |
| --- | --- | --- |
| Faz D + Dalga 1–3 | Runtime altyapısı: auth/provider, oturum deposu, araçlar/policy/sandbox, orkestrasyon, hafıza; 4 güvenlik incelemesi | `6be6748`…`d1a7a6b` |
| Canlı sağlamlaştırma | Harness-hesaplı kanıt, Windows/git sadakati, verimlilik, plan-time doğrulama, rol bütçeleri | `920d37f`…`b1cea84` |
| Pivot (D0) | Ürün tanımı, ADR-21 (Accepted), UX tasarımı | `a592854`…`b9dab08` |
| K0 | Sohbet öncelikli `syn agent` (anında cevap, doğrudan düzenleme, `/undo`, `/allow`) — ürün sahibi onayladı | `2c51679` |
| K1 (sürüyor) | U1 giriş (palet, @dosya, görsel, mouse, model seçici) ✅ `7c0c7c2` · U3 görünümler (pano, graf, usage, kartlar) ✅ `1cab7ec` · U2 oturum özellikleri ✅ `73f834f` → deneme bekliyor | |

## Sıradaki dalgalar (öncelik sırasıyla)

### K1 — Günlük kullanım hissi (sürüyor)
- U2: çalışırken yön verme, plan modu (policy daraltma), `orchestrate` aracı + canlı pano verisi, tek komut kaydı (`/help /plan /model /review /commit /undo /allow /trust /usage /evidence /why /compact /context /resume /memory /mouse`), kullanım istatistikleri + kota %, ekler (dosya/görsel → model), "kaldığın yerden devam" özeti.
- Entegrasyon → ürün sahibi denemesi.

### K1.5 — Ürün sahibinin 2026-09-24 istekleri ⭐ — altyapı ✅ (2026-09-24 akşam: `1112be2` görseller + kota, `7f54568` çapraz sağlayıcı katalog/routing + Claude Code köprüsü worker, `7e54328`/`c80c0a6` `syn config` + `/config` + init'siz + full'da yıkıcı → onay). Bekleyen: gerçek Claude Code ile doğrulama (`--model claude-opus-5-5`, MCP rapor araçları, `--resume`, görsel, abonelik `apiKeySource`), Codex models listesi formatı.
0. **K1.6 ✅ (2026-09-24, `4d71fa4` + `848894a`):** Claude Code tarzı izin modları (ask/auto/full/plan, Shift+Tab, `/permissions`, reddetmek yerine sor); reviewer'lar workspace'in tamamını okur; görevler arası ölçütler entegrasyon review'una; ret yerine revize turu; çift basılan pano düzeltmesi.
0. **K1.7 ✅ (`7a99493`) — Worker'ların içine girme (ürün sahibi isteği, 2026-09-24) ⭐ ayrıştırıcı:**
   - Pano ve graf görünümünde worker seçimi: `↑/↓` (veya `j/k`), grafta `←/→` ile seviyeler arası; seçili worker vurgulanır.
   - `Enter` → seçili worker'ın **kendi terminal görünümü**: o worker'ın oturumunun canlı akışı (düşünme özeti, araç satırları, diff'ler), aynı sessiz-varsayılan kurallarıyla; `Esc` veya `Ctrl+O`/`b` ile ana oturuma dön. `Tab` ile worker'lar arasında geçiş.
   - Worker görünümünün başında **orchestrator'ın o worker'a verdiği görev**: hedef, sahip olunan dosyalar, kabul ölçütleri, doğrulama komutları (task packet'ın okunur özeti) + sonradan gelen yönlendirmeler.
   - Ana sohbette orchestrator'ın worker'lara verdiği komutlar/delegasyonlar görünür (katlanabilir "→ worker'a gönderildi" satırları).
   - Worker ile iletişim: worker görünümündeyken yazılan mesaj **o worker'a** steer olarak gider (güvenli adım sınırında), orchestrator'a da bildirilir ve audit'e yazılır; worker'ı duraklat/iptal et (`p`/`x`) seçenekleri.
   - Teknik not: her attempt zaten ayrı oturum (session log) — görünüm bu log'un projeksiyonu; attempt başına steer kuyruğu (driver.steer) ve coordinator'a bildirim gerekir.
0. K1 artıkları: görselleri modele gerçekten gönder (adapter image parts), footer kotasına worker kullanımını kat, `/review` → ADR-09 dispatchReview, `/commit` seçici staging, orkestrasyon 1 saat tool timeout.
1. **Çoklu sağlayıcı model görünürlüğü:** OpenAI ve Anthropic'e birlikte giriş yapıldıysa `/model` ve model seçici **her iki sağlayıcının modellerini** gösterir (ChatGPT aboneliği modelleri + Claude modelleri; Claude aboneliği Claude Code köprüsüyle, API key ile doğrudan).
2. **Çapraz sağlayıcılı orkestrasyon:** tier/rol başına farklı sağlayıcı seçilebilir. Örnek hedef yapılandırma:
   - orchestrator → `openai/gpt-6-sol`
   - complex_worker → `anthropic/opus-5.5` (Claude Code köprüsü veya API key)
   - fast_worker → `openai/gpt-6-luna`
   - reviewer → implementer'dan farklı sağlayıcı (bağımsızlık için tercih)
   Seçim config ile ve etkileşimli olarak yapılır; yalnızca giriş yapılmış sağlayıcılar seçilebilir; sessiz fallback yok (mevcut kural).
   Teknik not: Claude aboneliği yalnız Claude Code köprüsüyle (AgentBackendAdapter) kullanılabildiği için köprünün worker rolünde (MCP araçlarıyla, policy altında) tam çalıştığı doğrulanmalı; aksi halde Anthropic API key yolu.
3. **Terminalden yapılandırma yönetimi:** YAML düzenlemeden:
   - `syn config list | get <anahtar> | set <anahtar> <değer> | unset | edit` (kullanıcı katmanı; repo katmanı yalnız daraltır — mevcut güven kuralı)
   - oturum içinde `/config` etkileşimli ekranı (route'lar, policy modu, bütçe, UI tercihleri, mouse, glyph seti)
   - `/model` seçiminde "varsayılan olarak kaydet" onayı
4. **Init gerektirmeyen kullanım:** paketlenmiş `syn` hiçbir `syn init` olmadan her repoda tam Synorch yapısıyla çalışır.
   - Bugün kısmen var: `.ai/` yoksa yerleşik varsayılanlar (anayasa, 8 protokol, 5 rol, 9 skill) yükleniyor (`src/harness/cli/canonical.ts`).
   - Yapılacak: uyarı dili ("run syn init") kaldırılır; yerleşik yapı birinci sınıf mod olur; `syn init` yalnız özelleştirmek isteyenler için; yerleşik skill'ler paketle birlikte gelir (npm `files`); `doctor` yalnız bilgi verir.

### K2 — Güven ve şeffaflık
- `/evidence` kanıt kartı tam veriyle, `/why` açıklaması.
- Karar masası + Obsidian hafıza defteri (kararlar/varsayımlar oturumlar arası, düzeltme kontrolü) — sahip belgesi [obsidian/README.md](../obsidian/README.md).
- Kaldığın yerden devam paketi (UX-06), "bu bağlam neden?" (UX-07).

### K3 — Güç kullanıcısı
- Worker'lar arka planda çalışırken sohbet (UX-GATE-02).
- Çapraz sağlayıcılı review (K1.5 ile birleşir).
- MCP client (harici araçlar, gateway altında).
- Zamanda yolculuk: oturumun herhangi bir anından fork.

### K4 — Yetenekler: internet ve araç seti (ürün sahibi isteği, 2026-09-24) ⭐
Ürün sahibi harness'la konuşurken internete çıkamadığını ve bazı yeteneklerin eksik olduğunu fark etti: "yetenekli bir aracımız olsun". Önce araştırma + bağlam, sonra uygulama.
- **K4.0 Yetenek boşluğu araştırması:** bizim araç setimizi Claude Code, Codex CLI, Oh My Pi/pi, Hermes ile karşılaştır (web arama, web fetch/okuma, tarayıcı otomasyonu, görsel görüntüleme, todo/plan aracı, alt ajan/görev aracı, LSP/diagnostics, arka plan süreçleri ve uzun komutlar, notebook, paket kurulumu, dosya glob/arama, git işlemleri, MCP). Çıktı: `docs/harness/research/capabilities/` + önceliklendirilmiş liste. Ürün sahibi isterse ChatGPT ile ek bağlam (YAML) üretir; ikisi birleştirilir.
- **K4.0 ✅ (`7677cb5`):** [capabilities/README.md](../research/capabilities/README.md), [recommendation.md](../research/capabilities/recommendation.md). Orchestrator kararları (2026-09-24): arama varsayılanı ChatGPT aboneliği (hosted `web_search`, ayrı alt istek), sonra OpenAI/Anthropic API, isteğe bağlı Brave/Tavily/Exa anahtarı, sessiz fallback yok; `live` arama; "bu alan adına her zaman izin ver" kullanıcı kapsamında global; kullanıcının açıkça verdiği tek URL'de robots.txt engel değil, model keşfettiklerinde uyulur; full modda web içeriği okunan turda dışa etkili eylem (push/publish/dış POST) bir kez onay ister (prompt-injection kalkanı), diğer her şey serbest; implementer/explorer/reviewer arama yapabilir; anahtarsız ücretsiz arama katmanları yok; K4.2 P0 sırası: arka plan süreçleri → glob → todo → dosyadan görsel/PDF okuma. Köprü worker'ları web araçlarını MCP ile gateway'den alır (Claude Code yerleşik WebSearch kapalı kalır). Sözleşme: `TOOL_EFFECTS`'e `network-read`.
- **K4.1 İnternet:** `web_search` (sağlayıcı yerleşik arama aracı varsa onu — OpenAI Responses `web_search`, Anthropic web search/fetch — yoksa yapılandırılabilir arama sağlayıcısı) ve `web_fetch` (URL → okunur metin/markdown, boyut sınırı, önbellek). Ağ politikası izin modlarına bağlı: auto'da yeni alan adı için onay kartı ("bu alan adı için her zaman izin ver"), full'da serbest, headless'ta allowlist. Web içeriği güvenilmeyen veri olarak işaretlenir (prompt injection koruması); sır sızdırma rayları geçerli.
- **K4.2 Eksik araçlar:** araştırmanın P0/P1 çıktıları (ör. arka plan komut + çıktı izleme, todo/plan aracı, görsel okuma, LSP/diagnostics, glob).
- **K4.3 İsteğe bağlı:** tarayıcı otomasyonu (Playwright/CDP) ve MCP üzerinden harici yetenekler (K3 MCP client ile birleşir).

### Sadeleştirme (K1.5–K3 boyunca)
- Eski toplu yol: `syn agent --legacy` ve batch `syn run` → yeni çekirdeğe katla; orkestrasyonu `--orchestrate` ile tut.
- Explorer yalnız orkestrasyonda (session ajanı keşfi kendisi yapar).
- scoped-dir izolasyonunu basitleştir veya git olmayan klasörde orkestrasyonu kapat.
- Tören satırlarını (audit) ekrandan kaldır, yalnız log'da tut.

### Altyapı / sonra
- macOS + Windows CI hatalarını düzelt (Ubuntu yeşil; ilk CI run `35917000110`).
- Windows OS sandbox (AppContainer + job object) — HD-03.
- Güveni commit/lockfile değişikliğine bağlama.
- Paketleme ve dağıtım (npm yayını ayrı karar; `main`e taşıma ayrı karar).

## Çalışma kuralları (hatırlatma)
- Build-first, test-light: ürünü önce eline ver, hataları kullanımla düzelt.
- `docs/harness` sahibin kanonik bağlamı: her görevde taze oku, sahip belgelerini silme/üzerine yazma.
- Kullanıcıya dönük her dalga: gerçek terminalde dene → geri bildirim → sonraki dalga.
