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

### K1.5 — Ürün sahibinin 2026-09-24 istekleri (K1 testinden hemen sonra) ⭐
0. **K1.6 ✅ (2026-09-24, `4d71fa4` + `848894a`):** Claude Code tarzı izin modları (ask/auto/full/plan, Shift+Tab, `/permissions`, reddetmek yerine sor); reviewer'lar workspace'in tamamını okur; görevler arası ölçütler entegrasyon review'una; ret yerine revize turu; çift basılan pano düzeltmesi.
0. **K1.7 — Worker'ların içine girme (ürün sahibi isteği, 2026-09-24) ⭐ ayrıştırıcı:**
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
