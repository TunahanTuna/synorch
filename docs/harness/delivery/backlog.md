# Harness geliştirme planı ve hatırlatıcılar

> Durum: yaşayan plan (ürün sahibi + orchestrator). Son güncelleme: 2026-09-25. Bu dosya "ne yapacağız, hangi sırayla, neden" sorusunun tek listesidir. Ayrıntılı tasarım: [ürün gereksinimleri](../foundation/product-requirements.md), [ADR-21](../decisions/ADR-21-conversation-first-runtime.md), [TUI deneyimi](../design/tui-experience.md), [uygulama planı §8](../implementation-plan.md), sahip bağlamı [harness-context.yaml](../harness-context.yaml) / [harness-ux-context.yaml](../harness-ux-context.yaml).

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

## ✅ P0 — Orantılılık ve hız (ürün sahibi testi, 2026-09-25) — yapıldı: `0faaada` worker izinleri (auto = otonom), `17d4bde` orantılı review + üretilmiş dosyalar hariç + kurulum bir kez + tek tur; gerçek modelle ölçüm bekliyor. Not: orkestrasyon ASLA caydırılmaz (ürün sahibi hızlı/ucuz modellerle bilinçli kullanıyor).
Ürün sahibi aynı işi ("boş bir React projesi oluştur") ChatGPT'nin harness'ına ve bize verdi: ChatGPT 2 dk 21 sn, Synorch 9 dk+ ve bitmedi. Kayıtlar (`C:\temp\Yeni klasör`, run `run_01M3AKRA9EQ0X4VP4PTKZFFRD7` failed + `run_01M3AM498W7VJXWX3QT486312W`):
1. Session agent tek komutluk işi doğrudan yapmak yerine orkestrasyon açtı (iki run: plan + "onaylanan planı uygula").
2. Tek görevli plana zorunlu bağımsız reviewer eklendi (risk "standard").
3. Harness doğrulaması her deneme/onarım/revize turunda `npm install` + `npm run build` koştu.
4. Reviewer `node_modules`/`dist` (gitignore'lu üretilmiş dosyalar) yüzünden "changes requested" dedi.
5. İkinci review "artifact changed during review" ile düştü (reviewer'ın build'i `dist`'i değiştirdi).
Hedefler:
- **Orantılılık:** session agent basit/tek adımlı işleri (scaffold, tek dosya, komut çalıştırma) doğrudan yapar; `orchestrate` yalnız gerçekten çok parçalı ve paralelleşebilir işte; tek görevli planı orkestrasyona çevirmek reddedilir → doğrudan yapılır. Planı "onaylat → ayrı run" iki aşamalılığı kaldır.
- **Risk sınıflaması ve review:** araçla üretilmiş scaffold / tek görevli / trivial işlerde bağımsız review yok (harness doğrulaması yeterli); review yalnız anlamlı kod değişikliği olan standard+ işte.
- **Üretilmiş dosyalar:** gitignore'lu çıktılar (`node_modules`, `dist`, `build`, cache'ler) artifact digest'ine, diff'e, review'a ve "changed ⊆ owned" kontrolüne girmez; reviewer'ın doğrulaması artifact'ı değiştirmez (yalnız izlenen dosyalar sabitlenir).
- **Doğrulama maliyeti:** kurulum komutları (`npm install` vb.) attempt başına bir kez, sonraki turlarda önbellek/yeniden kullanım; doğrulama paralel ve kısa tutulur.
- **Ölçüt:** "boş React projesi" ≤ ChatGPT harness süresi (~2,5 dk, çoğu `npm install`); gerçek modelle ölçülür.

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

### Ürün ilkesi (ürün sahibi, 2026-09-24)
Sistemi hantallaştırma; amaca yönelik kal. Ana amaç orkestrasyonda çok yetkin bir araç olmak ve kendi ayrıştırıcılarımızla öne çıkmak. Diğer harness'ların hantal olmayan iyi özelliklerini içer, gerekirse doğrudan paylaş/kullan (ör. Claude Code native araçları, OpenAI hosted web_search). Her zaman önce kullanıcı deneyimi.

### K2 eki — Hafıza grafı (ürün sahibi isteği, 2026-09-24)
`/memory graph`: Obsidian graph view benzeri, hafıza notlarının (karar, varsayım, soru, kanıt, kavram, tercih) ilişki yumağını terminalde göster; ilişki türleri + not bağlantıları, filtreler, odakla-genişlet gezinme (ajan grafıyla aynı etkileşim), çelişki vurgusu, `o` ile notu Obsidian'da aç, `--obsidian` ile Obsidian'ın kendi graph view'unu aç. K2 ajanına eklendi.

### K3 — Güç kullanıcısı
- Worker'lar arka planda çalışırken sohbet (UX-GATE-02). ✅ (`05468f4`; tasarım: [conversation-runtime §7](../design/conversation-runtime.md#7-arka-plan-orkestrasyonu-k3-ux-gate-02); gerçek terminal/gerçek model denemesi bekliyor)
- Çapraz sağlayıcılı review (K1.5 ile birleşir).
- MCP client (harici araçlar, gateway altında). ✅ (`f3d13ce`): `syn mcp list|add|remove|approve|revoke|enable|disable|test`, `/mcp`; stdio + streamable HTTP (resmi SDK); proje server'ları ve `.mcp.json` tek seferlik onayla; Claude native modda `--mcp-config`. Playwright: `syn mcp add playwright -- npx @playwright/mcp@latest`. Ayrıntı: [ADR-13 revizyonu](../decisions/ADR-13-mcp-acp.md).
- ✅ (`e97835b`) Zamanda yolculuk: `/rewind` (Esc Esc; istersen dosyaları da geri al), `/fork`, `/resume` seçicisi. Ayrıca `/commit` seçici staging, efor config canlı, görsel temp temizliği.
- ✅ (`8ae9e99`) **UI eki — alt durum satırı (ürün sahibi, 2026-09-25):** Hata: `/model` ile model değişince alttaki model/bağlam bilgisi güncellenmiyor. Durum satırı canlı state'ten beslenmeli: model, efor (K6), izin modu, bağlam %, kota; her değişiklikte (`/model`, `/effort`, Shift+Tab, compact) anında yenilenmeli. Görünüm daha okunur ve renkli olmalı: alanlar ayrı renk/ton, bağlam ve kota eşiklere göre renk (yeşil → sarı → kırmızı), dar terminalde öncelik sırasıyla kısalma.

### K4 — Yetenekler: internet ve araç seti (ürün sahibi isteği, 2026-09-24) ⭐
Ürün sahibi harness'la konuşurken internete çıkamadığını ve bazı yeteneklerin eksik olduğunu fark etti: "yetenekli bir aracımız olsun". Önce araştırma + bağlam, sonra uygulama.
- **K4.0 Yetenek boşluğu araştırması:** bizim araç setimizi Claude Code, Codex CLI, Oh My Pi/pi, Hermes ile karşılaştır (web arama, web fetch/okuma, tarayıcı otomasyonu, görsel görüntüleme, todo/plan aracı, alt ajan/görev aracı, LSP/diagnostics, arka plan süreçleri ve uzun komutlar, notebook, paket kurulumu, dosya glob/arama, git işlemleri, MCP). Çıktı: `docs/harness/research/capabilities/` + önceliklendirilmiş liste. Ürün sahibi isterse ChatGPT ile ek bağlam (YAML) üretir; ikisi birleştirilir.
- **K4.0 ✅ (`7677cb5`):** [capabilities/README.md](../research/capabilities/README.md), [recommendation.md](../research/capabilities/recommendation.md). Orchestrator kararları (2026-09-24): arama varsayılanı ChatGPT aboneliği (hosted `web_search`, ayrı alt istek), sonra OpenAI/Anthropic API, isteğe bağlı Brave/Tavily/Exa anahtarı, sessiz fallback yok; `live` arama; "bu alan adına her zaman izin ver" kullanıcı kapsamında global; kullanıcının açıkça verdiği tek URL'de robots.txt engel değil, model keşfettiklerinde uyulur; full modda web içeriği okunan turda dışa etkili eylem (push/publish/dış POST) bir kez onay ister (prompt-injection kalkanı), diğer her şey serbest; implementer/explorer/reviewer arama yapabilir; anahtarsız ücretsiz arama katmanları yok; K4.2 P0 sırası: arka plan süreçleri → glob → todo → dosyadan görsel/PDF okuma. ~~Claude Code yerleşik WebSearch kapalı kalır~~ → REVİZE (ürün sahibi, 2026-09-24): Claude Code native mod (tüm yerleşik araçlar açık, izin modları eşlenir, onaylar bizim kartımızda) ve OpenAI hosted `web_search` ana istekte; bizim `web_search` yalnız yedek. Sözleşme: `TOOL_EFFECTS`'e `network-read`.
- **K4.1 ✅ (`8e12e27`) İnternet:** `web_search` (sağlayıcı yerleşik arama aracı varsa onu — OpenAI Responses `web_search`, Anthropic web search/fetch — yoksa yapılandırılabilir arama sağlayıcısı) ve `web_fetch` (URL → okunur metin/markdown, boyut sınırı, önbellek). Ağ politikası izin modlarına bağlı: auto'da yeni alan adı için onay kartı ("bu alan adı için her zaman izin ver"), full'da serbest, headless'ta allowlist. Web içeriği güvenilmeyen veri olarak işaretlenir (prompt injection koruması); sır sızdırma rayları geçerli.
- **K4.2 Eksik araçlar:** araştırmanın P0/P1 çıktıları (ör. arka plan komut + çıktı izleme, todo/plan aracı, görsel okuma, LSP/diagnostics, glob).
- **K4.3 İsteğe bağlı:** tarayıcı otomasyonu (Playwright/CDP) ve MCP üzerinden harici yetenekler (K3 MCP client ile birleşir).

### ✅ K5 — Etkileşimli soru/seçim deneyimi (ürün sahibi isteği, 2026-09-24) ⭐ UX — yapıldı `7492d98`: tek seçim modalı (oklar/Enter/1–9, çoklu seçim Space, Önerilen, Diğer…, Esc), tüm istemler taşındı, `ask_user` aracı (Claude AskUserQuestion şeması), Claude Code'un AskUserQuestion'ı modala (2.1.282'de canlı doğrulandı). Gerçek terminalde deneme bekliyor.
Ürün sahibi: "Soru sorduğunda 1 veya 2 yazıp Enter'a basmamı istiyor; cevabım modele mesaj olarak gidip thinking'e düşüyor, sonra kabul ediliyor. Ayrı bir input/pop-up/modal olsun. Claude Code'daki gibi planlarken bana seçenekli sorular sorsun."
- ✅ (`2adcf0d`, `controls.ask()` istem girdiyi sahiplenir; seçimler picker ile) **Hata (K5'in ilk işi):** onay/soru istemleri (ör. `/init` "Write the Synorch structure into this repository? 1. Create the files 2. Cancel") normal giriş kutusunu kullanıyor; yazılan cevap aynı zamanda sohbete mesaj olarak sızıyor ve modeli tetikliyor. İstem açıkken giriş yalnız isteme gitmeli.
- **Seçim modalı (tek bileşen, tüm istemler için):** editörün yerine/üstünde odaklı katman; oklarla gezin, Enter ile seç, sayı kısayolları; tek seçim ve çoklu seçim (Space ile tikle); "Önerilen" etiketi; her soruda "Diğer…" ile serbest metin; Esc = iptal/ret; plain modda numaralı eşdeğer. `/init`, onay kartları, `/model`, `/config`, trust istemi, karar masası bu bileşeni kullanır.
- **Agent'ın soru aracı (Claude Code AskUserQuestion benzeri):** `ask_user` yapılandırılmış sorular alır: 1–4 soru, her biri 2–4 seçenek (açıklama + isteğe bağlı önizleme), `multiSelect`, önerilen seçenek; kullanıcı cevabı yapılandırılmış olarak modele döner. Plan modunda ve planlama sırasında agent önerileriyle seçenek sunar; kullanıcı seçer veya kendi alternatifini yazar. Sohbet akışından ayrı bir etkileşim alanı olarak görünür, cevap transkripte kısa bir özet satırı olarak düşer.
- Claude Code köprüsünde Claude'un kendi AskUserQuestion çağrıları da bu modala yönlendirilir.

### ✅ K6 — Model eforu (reasoning effort) ayarı (ürün sahibi isteği, 2026-09-25) ⭐ — yapıldı `8ae9e99`: rol/tier başına `effort` config, `--effort`, `/effort`, `/model` sonrası efor seçici, modele göre seviye kısıtlama; OpenAI `reasoning.effort`, Claude köprüsü `--effort`, Anthropic `output_config.effort`. Canlı sağlayıcıyla deneme bekliyor; orchestrator görev başına efor önerisi yapılmadı.
Ürün sahibi: "Kullanılan modelin eforu da değiştirilebilir olmalı; buna dair bir ayar görmedim, istediğimiz eforu kullanabilmeliyiz."
- **Ayar:** rol başına efor (orchestrator / complex_worker / fast_worker / session) `~/.synorch/config.yaml` ve `syn config` ile; tek seferlik `--effort` bayrağı.
- **Oturum içinde:** `/effort` komutu + `/model` seçicisinde model yanında efor seçimi (K5 seçim modalıyla); geçerli efor başlık/durum satırında görünür (ör. `gpt-6-sol · high`).
- **Sağlayıcı eşlemesi:** OpenAI/ChatGPT Responses `reasoning.effort`; Claude Code köprüsünde CLI'nin efor ayarı; Anthropic API'de thinking/effort parametresi. Desteklenen seviyeler modele göre katalogdan gelir; desteklenmeyen seviye sessizce yutulmaz, en yakın seviyeye düşülür ve söylenir. Tam parametre adları uygulamadan önce güncel dokümandan doğrulanır.
- **Orkestrasyon:** worker'lar rolünün eforunu kullanır; orchestrator görev başına efor önerebilir (trivial → düşük, zor hata ayıklama → yüksek). Kullanıcı ayarı her zaman önceliklidir.

### Sadeleştirme (K1.5–K3 boyunca)
- ✅ Eski toplu yol: `syn agent --legacy` kaldırıldı (agent e2e'leri konuşma yoluna taşındı; crash-recovery özeti konuşmanın resume kartında). `syn run` headless giriş noktası olarak kaldı: aynı coordinator çekirdeğini süren ince sarmalayıcı, JSONL sözleşmesi aynı; `--orchestrate` açık yazım olarak kabul edilir.
- ✅ Explorer yalnız orkestrasyonda: session yolunda explorer alt-run'ı yok (yalnız planner planlar); session ajanı keşfi kendisi yapar.
- ✅ scoped-dir: olduğu gibi kaldı (git'siz klasör, commit'siz depo, worktree hatası için test edilmiş yedek; crash recovery buna dayanır). Git'siz klasörde ilk worker run'ı tek satırla `git init` önerir. Orkestrasyonu kapatmak e2e'lerin çoğunu git'e çevirmeyi ve git'siz kullanıcıyı worker'sız bırakmayı gerektirirdi.
- Tören satırlarını (audit) ekrandan kaldır, yalnız log'da tut.

### Altyapı / sonra
- macOS + Windows CI: ✅ macOS yeşil (`ef6907a`: pwsh7 altında DPAPI, macOS soket yolu, realpath tmp); Windows'ta 1 test (muhtemelen e2e scaffold) hâlâ kırmızı — log için `gh` veya tarayıcı izni gerekli.
- Windows OS sandbox (AppContainer + job object) — HD-03.
- Güveni commit/lockfile değişikliğine bağlama.
- ✅ Paketleme (`31e28fc`): kendi kendine yeten paket, `pnpm run install:global` → global `syn`; [install.md](install.md). npm yayını ve `main`e taşıma ayrı karar.

## Çalışma kuralları (hatırlatma)
- Build-first, test-light: ürünü önce eline ver, hataları kullanımla düzelt.
- `docs/harness` sahibin kanonik bağlamı: her görevde taze oku, sahip belgelerini silme/üzerine yazma.
- Kullanıcıya dönük her dalga: gerçek terminalde dene → geri bildirim → sonraki dalga.
