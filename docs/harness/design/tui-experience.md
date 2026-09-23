# Synorch TUI deneyimi: tasarım spesifikasyonu

> Statü: araştırma + tasarım önerisi. Uygulanmadı. `src/harness/tui/**` ve `src/harness/cli/**`'ın bugünkü davranışı [§1](#1-bugünkü-durum-ve-sorunlar)'de anlatılıyor. Tarih: 2026-09-23. Araştırma girdisi: [UX referans araştırması](../research/ux/README.md) (Oh My Pi / pi, Claude Code, Hermes Agent). Bağlı kararlar: [ADR-04 terminal renderer](../decisions/ADR-04-terminal-renderer.md), [ADR-08 onay politikası](../decisions/ADR-08-approval-policy.md), [CLI deneyimi](./cli-experience.md), [çapraz platform listesi](../research/tui/cross-platform-checklist.md).

**Ürün modeli (ürün sahibi netleştirmesi, 2026-09-23).** Synorch harness, Claude Code gibi kullanılan **etkileşimli ve konuşma öncelikli** bir kodlama ajanıdır. Kullanıcı sohbet eder, soru sorar ve birlikte plan yapar. Ajan dosyaları doğrudan okur, düzenler, komut çalıştırır. Büyük bir kod tabanı uzun oturumlarda onunla birlikte kurulur. Her mesaj hemen akan bir cevap alır. Küçük işi ana ajan kendisi yapar ve tool satırları görünür. **Çok worker'lı orkestrasyon** (plan → worktree'lerde paralel worker'lar → bağımsız review), ana ajanın büyük iş için önerdiği veya başlattığı bir yetenektir. Her mesajın varsayılan yolu değildir. Claude Code'daki subagent ve plan mode'a benzer.

Bu belge `syn agent` ve `syn run` insan modlarının (`tui` ve `plain`) **ne gösterdiğini** tanımlar. Nasıl çizdiği ADR-04'te sabittir: pi-tui, retained bileşen ağacı, ana ekran ve korunan scrollback. `--mode jsonl` bu belgenin kapsamı dışındadır ve **değişmez**.

## İçindekiler

1. [Bugünkü durum ve sorunlar](#1-bugünkü-durum-ve-sorunlar)
2. [Tasarım ilkeleri ve "varsayılan olarak sessiz" kuralı](#2-tasarım-ilkeleri)
3. [Etkileşim modeli: doğrudan, plan modu, orkestrasyon](#3-etkileşim-modeli)
4. [Gecikme beklentileri](#4-gecikme-beklentileri)
5. [Ekran bölgeleri](#5-ekran-bölgeleri)
6. [Bilgi hiyerarşisi: default / expanded / debug](#6-bilgi-hiyerarşisi)
7. [Olay → sunum eşleme tablosu](#7-olay--sunum-eşleme-tablosu)
8. [Mockup'lar](#8-mockuplar)
9. [Tuş atamaları ve komutlar](#9-tuş-atamaları-ve-komutlar)
10. [Spinner, aktivite satırı ve alt bilgi](#10-spinner-aktivite-satırı-ve-alt-bilgi)
11. [Glyph ve renk token'ları](#11-glyph-ve-renk-tokenları)
12. [Plain mod eşdeğeri](#12-plain-mod-eşdeğeri)
13. [Erişilebilirlik](#13-erişilebilirlik)
14. [Runtime önkoşulları](#14-runtime-önkoşulları)
15. [Kabul ölçütleri](#15-kabul-ölçütleri)
16. [Açık sorular](#16-açık-sorular)

## 1. Bugünkü durum ve sorunlar

Kaynak: `harness` @ `04e022c`. Ürün sahibinin transcript'i ([araştırma §0](../research/ux/README.md#0-başlangıç-noktası-bugünkü-çıktı)) şu kök nedenlere iner:

- **Model yanlış.** `syn agent`'taki her mesaj `coordinator.run()` açıyor ve plan zorunlu. Doğrudan cevap veya doğrudan düzenleme yolu yok. Orchestrator yalnız `.ai/tasks/**`'a yazabiliyor. Kaynak: `cli/session.ts` `agentCommand()`, `cli/role-policy.ts`.
- **Olay günlüğü, konuşma değil.** Her `SessionEvent` bir satıra çevriliyor: ULID'ler, `draft -> ready`, audit satırları, ham JSON tool argümanları. Kaynak: `tui/describe.ts`, `tui/tool-cards.ts`.
- **Worker stream'leri atıfsız.** Worker metni ana cevaba karışıyor, worker tool kartları `proposed` durumunda asılı kalıyor. Kaynak: `cli/runtime.ts` ~384.
- **Durum satırı hep `ready`.** `{kind:"status"}` yayan bir üretici yok.
- **Başlık, sonuç ve hata metinleri makine dilinde.** 4–8 satırlık başlık var. `Run run_… completed (exit 0)` sonucu ve `Error [code] / ids / retry safe` hata bloğu basılıyor. Kaynak: `cli/run-summary.ts`, `cli/session.ts`, `describe.ts`.

## 2. Tasarım ilkeleri

Araştırmadan çıkan ilkeler ([ayrıntı ve kaynaklar](../research/ux/README.md#5-ilkeler)):

1. **Konuşma önce.** Varsayılan ekran; kullanıcının mesajı, ajanın akan cevabı, yaptığı işin tek satırlık izleri ve (varsa) sonuç raporudur.
2. **Doğrudan iş varsayılan, orkestrasyon bir yetenek.** Ana ajan küçük işi kendisi yapar. Worker'ları büyük iş için önerir, ve bu da konuşmanın içinde bir blok olarak görünür ([§3](#3-etkileşim-modeli)).
3. **Özet varsayılan, ayrıntı istenince.** Her öğenin tek satırlık özeti vardır. `Ctrl+O` ayrıntıyı, `--debug` ve `/log` olay günlüğünü açar. Bilgi kaybolmaz, katmanlanır.
4. **İnsan dilinde, iç kimliksiz.** ULID, digest, state machine adı, isolation modu ve audit jargonu varsayılan görünümde yoktur.
5. **Bir canlı bölge, sonra kalıcı kayıt.** İlerleme yerinde güncellenen tek bir panoda gösterilir. Bitince transcript'e bir kez sabitlenir.
6. **Kanıt raporda, iddia değil.** Rapor harness'in kendi çalıştırdığı kontrolleri (ADR-18) ve reviewer kararını gösterir.
7. **Hata = ne oldu + ne etkilendi + ne yapmalı.**
8. **Her ortamda aynı bilgi.** TUI, plain ve ekran okuyucu modu aynı hiyerarşiyi taşır. Renk ve glyph tek bilgi kanalı değildir.

### 2.1 "Varsayılan olarak sessiz" kuralı (normatif)

L0 görünümüne (varsayılan) bir satır **yalnız** şu dört koşuldan biri doğruysa girer:

| Koşul | Örnek |
| --- | --- |
| **K1 Konuşma içeriği** | Kullanıcı mesajı, ajanın metni, `ask_user` sorusu |
| **K2 Kullanıcının istediği işin izi veya sonucu** | Tool satırı (1 satır + 1 özet), düzenleme diff önizlemesi, run panosu, sonuç raporu |
| **K3 Kullanıcıdan eylem bekleyen durum** | Onay, güven, soru, bütçe kararı |
| **K4 Güvenlik veya doğruluk sapması** | Kısmi sandbox, worktree yerine scoped-dir, route fallback, kesilmiş cevap, belirsiz sonuçlu kesinti |

Ek kurallar:

- İç durum geçişi (run, plan, task, attempt, turn, step) kendi başına **hiçbir zaman** satır üretmez. Etkisi pano satırında veya aktivite satırında görünür.
- Tool çağrısı başına L0'da en çok 2 satır basılır (satır + özet). Düzenleme diff önizlemesi en çok 8 satırdır.
- İlerleme bilgisi transcript'e **eklenmez**, canlı bölgede **güncellenir**.
- Rutin audit (autonomous self-approval, policy snapshot, trust kullanımı) L0'da görünmez.
- Başarılı bir yükleme veya kontrol (canonical `.ai` yüklendi, profil onaylı) sessizdir. Yalnız başarısızlık konuşur.

## 3. Etkileşim modeli

Ana ajan (UI'da **Synorch**) üç biçimde çalışır. Kullanıcı hangisinde olduğunu her zaman görür: doğrudan modda işaret yoktur, plan modunda alt bilgide `plan mode` görünür, orkestrasyonda pano görünür.

| Biçim | Ne zaman | Görünüm | Onay |
| --- | --- | --- | --- |
| **Doğrudan** (varsayılan) | Sohbet, soru, kod açıklama, küçük ve orta düzenleme, test çalıştırma | Akan cevap + tool satırları (`● Read`, `● Edit`, `● Run`) | Policy'ye göre: `autonomous`'ta yok, `ask`'te yan etkili tool başına |
| **Plan modu** | Kullanıcı `/plan <hedef>` yazar veya `Shift+Tab` ile açar. Ajan yalnız okur ve arar, dosya yazmaz. | Akan tartışma + önerilen plan (checklist) + seçim: *Workers ile çalıştır / Burada doğrudan yap / Planlamaya devam* | Plan kabulü kullanıcıdadır (her policy'de) |
| **Orkestrasyon** | Ana ajan büyük işte önerir (çok dosya, bağımsız alanlar, review gereken risk), kullanıcı ister ("use workers", `/workers`), veya plan modundan "Workers ile çalıştır" seçilir | Konuşma içinde tek bir blok: 1 cümlelik gerekçe → run panosu (canlı) → sonuç raporu. Konuşma sonra doğrudan modda devam eder. | `ask`: plan onayı overlay'i. `autonomous`: ajan başlatır, blok ilk satırında `esc to stop` gösterir. |

Orkestrasyonu önerme ölçütleri (ajan talimatı için öneri, [açık soru 2](#16-açık-sorular)): Değişiklik ≥ 5 dosyaya veya ≥ 2 bağımsız alana yayılıyor. Kullanıcı bağımsız review istiyor. Risk sınıfı `high`. Ya da iş, doğrudan modda bir bağlam penceresine sığmayacak kadar büyük. Doğrudan modda yapılan değişiklikler bağımsız review'dan geçmez. `/review` komutu mevcut diff'i bir reviewer worker'a gönderir ([§9](#9-tuş-atamaları-ve-komutlar)).

## 4. Gecikme beklentileri

Kullanıcı **her** mesajda hemen tepki görür. Harness, provider'ın ilk token'ından önce kullanıcıyı bekleten bir adım (planlama turu, onay, ağ çağrısı) eklemez.

| Ölçüm | Hedef | Not |
| --- | --- | --- |
| Enter → kullanıcı mesajı ekranda ve spinner (`Thinking`) görünür | ≤ 50 ms | Tek frame. Olay deposu yazması beklenmez (ADR-04: renderer beklemez). |
| Enter → provider isteği gönderildi (harness ek yükü: bağlam kurma, olay yazma, policy snapshot) | p95 ≤ 300 ms | Doğrudan modda. Plan turu yok. |
| İlk token geldi → ekranda | ≤ 1 frame (16 ms) | pi-tui `requestRender` birleştirmesi |
| İlk token (TTFT) | Provider'a bağlı; harness ölçer ve L1'de gösterir | `model/request_prepared` → ilk `text_delta` farkı |
| Stream verisi yok | 15 s → aktivite satırı `Waiting for OpenAI · 15s`. 60 s → `· esc to cancel, or keep waiting` | Claude Code 20 s eşiğiyle `Waiting for API response` gösterir |
| Orkestrasyon kabul edildi → pano görünür | ≤ 500 ms | Satırlar hemen `starting` durumunda çizilir |
| `syn agent` → editör hazır (sıcak başlangıç, güven ve giriş istemi hariç) | p95 ≤ 700 ms | Başlık ilk frame'de çizilir. Provider sağlık kontrolü arka planda yapılır. |
| Tuş vuruşu → editörde görünür | ≤ 16 ms | pi-tui `requestImmediateRender` |

Klasör güveni ilk mesajı geciktirmemek için **oturum açılırken** sorulur (bugün ilk mesajda soruluyor). Güvenilmeyen klasörde `Not now` seçilirse ajan yalnız sohbet eder ve dosya okumaz.

## 5. Ekran bölgeleri

pi-tui `TuiMainScreen` üzerinde, yukarıdan aşağıya (ADR-04: ana ekran, scrollback korunur):

```text
(1) Başlık ─────────── 1 satır, en çok 2; bir kez çizilir, scrollback'e kayar
(2) Transcript ─────── kalıcı: mesajlar, cevaplar, tool satırları, diff önizlemeleri,
                       sabitlenmiş panolar, sonuç raporları, uyarılar
(3) Canlı bölge ────── yalnız orkestrasyon sürerken: run panosu + worker etkinlikleri;
                       bitince (2)'ye sabitlenir
(4) Kuyruk ─────────── çalışma sırasında yazılmış, henüz uygulanmamış mesajlar (dim)
(5) Aktivite satırı ── spinner · fiil · süre · token · "esc to interrupt"; boştayken yok
(6) Editör ─────────── pi-tui Editor; üst/alt ince çizgi
(7) Alt bilgi ──────── 1 satır, dim: klasör · dal · model · mod · ctx% · $ · "? shortcuts"
(8) Overlay ────────── onay, güven, soru, seçim listesi; editörün üstünde, alt-orta
```

| Bölge | pi-tui bileşeni | Kural |
| --- | --- | --- |
| Başlık | `Text` | En çok 2 satır ([§8.1](#81-başlangıç-başlığı)) |
| Transcript | `Container` (bugünkü `transcript`) | Yalnız ekleme. Tek istisna, yerinde güncellenen son tool satırı veya akan cevap. |
| Canlı bölge | Yeni `RunBoard` | Yükseklik ≤ `min(10, rows/3)`. Fazla görev `+N more` satırına katlanır. |
| Kuyruk | Yeni `QueuedMessages` (pi `pendingMessagesContainer` karşılığı) | Mesaj başına 1 dim satır |
| Aktivite satırı | Bugünkü `StatusBar` genişletilir | Yalnız etkinlik varken. Boştayken yüksekliği 0. |
| Editör | `Editor` | `/` ve `@` autocomplete. Plan modunda çizgi rengi `accent`. |
| Alt bilgi | Yeni `Footer` | 1 satır. Dar ekranda alan düşer ([§10.2](#102-alt-bilgi)). |
| Overlay | `SelectList` + `Box` (bugünkü `openDialog`) | Varsayılan seçim her zaman güvenli seçenek |

Yükseklik bütçesi: 80×24 terminalde canlı bölge + kuyruk + aktivite + editör + alt bilgi ≤ 16 satır. Böylece transcript'in en az 8 satırı görünür kalır.

## 6. Bilgi hiyerarşisi

| Katman | Nasıl açılır | Ne gösterir |
| --- | --- | --- |
| **L0 default** | Varsayılan | [§2.1](#21-varsayılan-olarak-sessiz-kuralı-normatif) kuralına uyan her şey. Kimlik, digest ve state adı yok. |
| **L1 expanded** | `Ctrl+O` (aç/kapa; geçmiş dahil tüm transcript'e uygulanır), `--verbose`, config `ui.view: expanded` | L0 + tool çıktısının ilk 10 satırı ve tam diff; düşünme metni (en çok 5 satır); worker başına son 3 etkinlik; doğrulama çıktısı özeti; reviewer gerekçesi; kabul ölçütleri; TTFT ve istek başına token; route kaynağı; isolation modu. Kimlik yine yok. |
| **L2 debug** | `--debug` veya `SYN_DEBUG=1` ile açılış; oturum içinde `/log [n]` | L1 + bugünkü `describeEvent()` satırları: tam ID, state geçişi, audit ve approval kaydı. Dim ve `[event]` önekli. |

- `Ctrl+O` görünümü değiştirir, veriyi değil. Retained bileşenlerin iki render modu vardır (`compact`/`expanded`). Geçiş tam yeniden çizim ister, ve pi-tui bunu genişlik değişiminde de zaten yapar.
- Tam kayıt her zaman `syn show <run>` ve `--mode jsonl` ile alınır. L2 onun yerine geçmez.
- Plain modda `Ctrl+O` yoktur. `--verbose` ve `--debug` aynı katmanları açar.

## 7. Olay → sunum eşleme tablosu

Kısaltmalar: **Gizli** = gösterilmez (L2'de `[event]` satırı). **Pano** = run panosundaki satırı günceller, transcript'e satır eklemez. **Aktivite** = yalnız aktivite satırının fiilini veya sayaçlarını değiştirir. "Bugün" sütunu `describe.ts`'teki karşılıktır.

### 7.1 Olay aileleri → sunum

Tam liste `src/harness/contracts/events.ts`'teki 46 tiptir. Burada ailelere göre gruplanmıştır. **Gizli** = yalnız L2'de `[event]` satırı. **Pano** = run panosundaki satırı günceller. **Aktivite** = yalnız aktivite satırını değiştirir.

| Aile | L0 default | Not |
| --- | --- | --- |
| `session/*` | Gizli. Resume → `↻ Resumed · 2h ago · …` ([§8.8](#88-uzun-oturum-bağlam-compact-resume)). Çıkış → `Saved · resume with syn agent --continue`. | Kurtarılan belirsiz tool çağrısı → K4 uyarısı |
| `run/*`, `turn/*`, `step/*`, `message/recorded`, `model/request_prepared`, `policy/snapshot`, `task/packet_issued`, `attempt/state_changed`, `trust/used` | Gizli / Aktivite | Bitiş durumları raporu veya hata bloğunu tetikler |
| `plan/*`, `task/*`, `attempt/*`, `review/recorded`, `task/integrated`, `attempt/verification_ran`, `attempt/repair_requested` | Pano ([§7.3](#73-görev-durumu--pano-sözlüğü)) | Satırlar: `checking · npm test`, `checks 2/2`, `fixing evidence · round 1/2`, `accepted`. `isolation.fallback` → K4 uyarısı. |
| `approval/*` | İnsan gerekiyorsa overlay ([§8.10](#810-onay-güven-ve-soru-istemleri)). Autonomous self-approval gizli. Kullanıcı kararı tek dim satır. | |
| `tool/*` (ana ajan) | `● Fiil arg` + `⎿ özet` ([§7.4](#74-tool-satırları-ve-özetleri)). Deny → `✗ … blocked by policy: …`. Kesinti → `⎿ interrupted · may have partly run`. | Koordinasyon tool'ları (`plan_propose`, `task_spawn`, `task_status`, `ask_user`) tool satırı üretmez |
| `route/decided` | Gizli. Fallback → `! Using luna instead of astra (quota)` | |
| `model/response_*`, `provider/usage` | Yeniden deneme → Aktivite `Retrying in 4s · 2/5`. Nihai hata → hata bloğu. `length` → `! The reply was cut off`. Usage → sayaçlar. | |
| `context/compacted`, `memory/persisted`, `trust/granted` | Tek dim satır | |
| `context/source_changed`, `budget/exceeded` | K4 uyarısı, pano notu veya hata bloğu | |
| `memory/proposed`, `memory/proposal_decided`, `trust/revoked` | Gizli; rapor sonunda toplu not | |
| `steer/queued` | Kuyruk satırı ([§8.7](#87-kesme-ve-yönlendirme)) | |

### 7.2 Stream ve CLI metinleri

- **Ana ajan `text_delta`:** `●` madde işaretli, akan Markdown. **Worker `text_delta`:** transcript'e yazılmaz, pano etkinliğini besler ([R1](#14-runtime-önkoşulları)). **`thinking_delta`:** gizlidir (L1'de 5 satır).
- **Coordinator `notice`'leri** (plan adayı reddi, triage hatası): gizli, aktivite `Planning · revising (2/3)`. İstisnalar: `ledger write failed` K4 olarak kalır, güvenilmeyen klasör hata bloğu olur.
- **Başlık bildirimleri:** Başarılı yükleme sessizdir. Uyarılar tek satırda toplanır (`! 2 warnings · /doctor`).
- **`ask_user`:** soru overlay'i. **`describeOutcome` / `formatHarnessError`:** rapor ve hata bloğu. Kod ve kimlikler L2'de. Exit code değişmez.

### 7.3 Görev durumu → pano sözlüğü

| `TaskState` | Glyph (rich / safe / ascii) | Etiket |
| --- | --- | --- |
| `draft`, `awaiting_approval`, `ready` | `○` / `o` / `.` | `waiting` veya `waiting for <anahtar>` |
| `running` | spinner | `<etkinlik>` (worker'ın son eylemi) |
| `verifying` | spinner | `checking · <komut>` |
| `reviewing` | spinner | `in review` |
| `changes_requested`, `retry_pending` | `↻` / `~` / `~` | `revising` / `retrying` |
| `needs_context` | `?` | `needs more context` |
| `blocked` | `!` | `blocked · <neden>` |
| `interrupted` | `‖` / `=` / `=` | `interrupted` |
| `failed` | `✗` / `×` / `x` | `failed · <neden>` |
| `cancelled` | `–` / `-` / `-` | `cancelled` |
| `completed` | `✓` / `√` / `+` | `<özet>` · `+24 −0` · `checks 2/2` |

### 7.4 Tool satırları ve özetleri

Tool satırı `● <Fiil> <ana argüman>`, özet satırı `  ⎿ <sonuç>` biçimindedir. JSON hiçbir katmanda ham gösterilmez. L1 alan: değer listesi kullanır.

| Tool | Satır | L0 özet (`⎿`) | L0 önizleme | L1 |
| --- | --- | --- | --- | --- |
| `read_file` | `Read src/cli/args.ts` | `214 lines` | — | İlk 10 satır |
| `list_dir` / glob | `List src/` | `14 entries` | — | Liste |
| `search` / grep | `Search "--json" in src/` | `3 matches in 2 files` | — | Eşleşmeler |
| `apply_patch` / edit | `Edit src/cli/args.ts` | `+2 −1` | **Diff, en çok 8 satır**, satır numaralı; fazlası `… +N lines (ctrl+o)` | Tam diff |
| `write_file` | `Write docs/usage.md` | `new file · 40 lines` | — | İlk 10 satır |
| `shell` | `Run npm test` | `✓ exit 0 · 42 passed · 6.1s` veya `✗ exit 1 · 3 failed` | Başarısızsa son 5 satır | Son 10 satır |
| `git_status` | `Git status` | `2 modified, 1 untracked` | — | Liste |
| Bilinmeyen / MCP | `<tool> <ilk string argüman>` | Sonucun ilk satırı (≤ 80 karakter) | — | ≤ 20 satır |

- Arka arkaya gelen salt-okuma çağrıları tek satırda birleşir: `● Read 3 files` / `⎿ args.ts, session.ts, +1`. OMP `read-tool-group.ts` ve Claude Code (`Called slack 3 times`) aynı şeyi yapar.
- Düzenleme diff'i L0'da görünür, çünkü kullanıcının "ne değişti?" sorusunun cevabıdır (K2). pi `edit` ve Claude Code `Update` de diff'i varsayılan olarak gösterir.
- Çalışan `shell` satırı son çıktı satırını yerinde günceller (pi bash renderer'ı son 5 satırı 100 ms throttle ile gösterir). Bitince özete iner.

## 8. Mockup'lar

UI metinleri İngilizcedir (bugünkü CLI metinleriyle tutarlı; yerelleştirme [açık soru 1](#16-açık-sorular)). Mockup'lar `rich` glyph seti ve 80 sütunla çizildi. Editör ve alt bilgi yalnız ilk mockup'ta tam gösteriliyor.

### 8.1 Başlangıç başlığı

Normal durum, 1 satır:

```text
Synorch 0.9 · syn-smoke (master) · gpt-6-astra · autonomous
```

Güvenlik sapması varsa en çok 1 ek satır. Birden çok uyarı birleşir:

```text
Synorch 0.9 · syn-smoke (master) · gpt-6-astra · autonomous
! Sandbox is partial: commands can write outside this folder · 2 more warnings · /doctor
```

Klasör adı basename'dir (tam yol L1 ve `/doctor`'da). Model ana ajanın kısa adıdır. Worker route'ları başlıkta yer almaz, panoda görünür. Canonical `.ai` başarıyla yüklendiyse hiçbir şey yazılmaz.

### 8.2 Selam ve hızlı soru-cevap

```text
Synorch 0.9 · syn-smoke (master) · gpt-6-astra · autonomous

> hi

● Hi! I'm in syn-smoke on master. What are we working on?

> which node version does this project need?

● Node 24 or newer. `package.json` sets `"engines": { "node": ">=24" }`.
  ⎿ Read package.json

────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────
  syn-smoke · master · gpt-6-astra · ctx 3% · $0.01          ? shortcuts
```

Plan, pano veya görev yoktur. İlk mesajda tool bile yoktur. Tek bir okuma, cevabın altına tek satır olarak düşer. Tool başlamadan önce metin akmaya başladıysa sıra korunur (metin → tool → metin).

### 8.3 Kodu okuyarak açıklama

```text
> how does syn agent decide between the tui and plain renderers?

● Read 3 files
  ⎿ renderer.ts, renderers.ts, terminal.ts

● `selectRendererKind()` in `src/harness/contracts/renderer.ts:68` checks,
  in order:

  1. `--mode jsonl` / `--json` → **jsonl**
  2. `--plain`, `SYN_PLAIN`, `TERM=dumb`, or stdin/stdout not a TTY → **plain**
  3. otherwise → **tui** (pi-tui)

  Colour is decided separately by `selectColor` (`--color` > config >
  `NO_COLOR` > `FORCE_COLOR`), so plain mode can still be coloured when
  you ask for it.
```

Okumalar gruplanır. Açıklama Markdown olarak akar. `dosya:satır` referansları OSC 8 bağlantısıdır (destekleyen terminallerde tıklanır).

### 8.4 Doğrudan küçük düzenleme, test ve diff

```text
> --json should just be an alias for --mode jsonl. fix it and run the cli tests

● Search "--json" in src/harness/cli
  ⎿ 3 matches in 2 files

● Edit src/harness/cli/args.ts
  ⎿ +2 −1
     88    if (arg === "--mode") { mode = next(); continue; }
     89 −  if (arg === "--json") { json = true; continue; }
     89 +  // --json is an alias of --mode jsonl
     90 +  if (arg === "--json") { mode = "jsonl"; continue; }

● Run npm test -- tests/harness-cli
  ⎿ ✓ exit 0 · 42 passed · 6.1s

● `--json` now sets the same mode as `--mode jsonl`, and the CLI tests pass.
  This was a direct change, not reviewed. Say "review it" or use /review
  if you want an independent check.
```

`ask` policy'de `Edit` ve `Run` satırlarından önce tool onayı overlay'i görünür ([§8.10](#810-onay-güven-ve-soru-istemleri)). "Not reviewed" cümlesi her doğrudan düzenlemede değil, yalnız oturumdaki ilk doğrudan yazmadan sonra bir kez söylenir (ajan talimatı; [açık soru 3](#16-açık-sorular)).

### 8.5 Plan modu: yürütmeden önce birlikte planlama

Kullanıcı `Shift+Tab` ile plan moduna geçer (alt bilgi: `plan mode · read-only`, editör çizgisi `accent` renginde):

```text
> we need to move all 38 test files from jest to node:test. how would you
  approach it?

● Search "from '@jest/globals'" in tests/
  ⎿ 38 files
● Read jest.config.js, tests/cli.test.ts
  ⎿ 2 files

● Most files only use describe/it/expect, so they convert mechanically.
  Four use jest.mock and need hand-written fakes. I'd do it in four steps:

  ● Proposed plan · 4 tasks
    1 map-usage        explorer     List jest APIs used per file
    2 convert-simple   implementer  Convert 34 mechanical files · tests/**
    3 convert-mocks    implementer  Replace jest.mock in 4 files · tests/**
    4 review-migration reviewer     Check the whole diff, run npm test

  2 and 3 can run in parallel in separate worktrees.

> keep jest.config.js until the end, and do mocks first

● Updated: convert-mocks now runs before convert-simple, and a final step
  deletes jest.config.js after review.

  ● Proposed plan · 5 tasks  (changed: order, +1 task)
    …

  › 1. Run with workers
    2. Do it here directly
    3. Keep planning
```

Plan modunda ajan yalnız okur (`workspace-write` ve `exec` reddedilir). Plan checklist'i konuşmanın içinde bir blok olarak durur. Revizyonda yalnız değişiklik işaretlenir. Seçim listesi editörün hemen üstünde satır içi görünür, overlay değildir. "Do it here directly" plan modunu kapatır ve adımları ana ajan doğrudan uygular. "Run with workers" [§8.6](#86-konuşmaya-gömülü-orkestrasyon)'ya geçer.

### 8.6 Konuşmaya gömülü orkestrasyon

**a) Başlatma.** Ana ajan hemen bir cümleyle cevap verir, sonra panoyu açar:

```text
● Starting 4 workers. Each works in its own worktree, and a reviewer
  checks the result before anything is applied.

● Workers · 4 tasks                                             esc to stop
  ✓ map-usage        explorer     luna   38 files mapped, 4 use mocks  14s
  ⠼ convert-mocks    implementer  astra  editing tests/http.test.ts    41s
  ⠼ convert-simple   implementer  astra  converted 12/34 files         41s
  ○ review-migration reviewer     luna   waiting for 2 tasks

⠼ Working… 2 of 4 running · 1m 04s · 61.4k tokens · esc to interrupt
```

**b) Harness doğrulaması ve review.** Satırlar yerinde güncellenir:

```text
  ✓ convert-mocks    implementer  astra  4 files +96 −71 · checks 1/1  1m 22s
  ⠦ convert-simple   implementer  astra  checking · npm test           2m 03s
  ○ review-migration reviewer     luna   waiting for convert-simple
```

Reviewer değişiklik isterse:

```text
  ↻ convert-simple   implementer  astra  revising · 2 files still import jest
  ✓ review-migration reviewer     luna   changes requested
```

**c) Sonuç.** Pano transcript'e sabitlenir, ardından rapor gelir. Konuşma kaldığı yerden sürer:

```text
● Workers · 4 tasks · done in 4m 12s
  ✓ map-usage        explorer     38 files mapped, 4 use mocks
  ✓ convert-mocks    implementer  4 files +96 −71 · checks 1/1
  ✓ convert-simple   implementer  34 files +410 −388 · checks 1/1
  ✓ review-migration reviewer     Accepted after 1 revision

● All 38 test files use node:test now, and jest.config.js is gone.

  Changed   39 files  +506 −512   /diff to see them
  Checks    ✓ npm test  ✓ npm run lint   run by Synorch
  Review    accepted (luna) after 1 revision
  Cost      $0.41 · 212k tokens · 4m 12s

> nice. update the CI workflow to drop the jest cache step too

● Read .github/workflows/ci.yml
  …
```

Rapor alanları: **Changed** (`task/integrated`, en çok 5 dosya, sonra `/diff`). **Checks** (`attempt/verification_ran`; "run by Synorch" bunun worker beyanı olmadığını söyler). **Review** (`review/recorded`). **Cost** (`provider/usage`, tahminse `~`). İsteğe bağlı: **Memory**, ve **Notes** (worker'ların açık bıraktığı sorular, en çok 3). Özet paragrafı ana ajanın metnidir ([R5](#14-runtime-önkoşulları)).

6 görevden fazlasında canlı pano katlanır:

```text
● Workers · 9 tasks · 3 running                                 esc to stop
  ✓ 3 done
  ⠏ fix-session      implementer  astra  running npm test          1m 02s
  ⠏ fix-cookie       implementer  astra  editing cookie.ts           47s
  ⠏ fix-csrf         implementer  astra  reading middleware/          9s
  ○ 3 waiting
```

### 8.7 Kesme ve yönlendirme

Akış sırasında `Esc`:

```text
● I'll rename loadConfig to readConfig and update the three call sites,
  starting with src/config/load.ts. Then I'll
  ⎿ Interrupted · tell Synorch what to do instead

> keep loadConfig as an alias so plugins don't break
```

Tool'lar çalışırken yazılan mesaj (`Enter`) kuyruğa girer ve bir sonraki güvenli sınırda uygulanır:

```text
● Edit src/config/load.ts
  ⎿ +12 −4
⠸ Working… 18s · 9.2k tokens · esc to interrupt
  queued › also update docs/config.md
```

Sınırda kuyruk satırı transcript'e kullanıcı mesajı olarak geçer ve ajan cevabına döner:

```text
> also update docs/config.md

● Noted. I'll update docs/config.md after the call sites.
```

Orkestrasyon sırasında yönlendirme ana ajana gider ve ajan etkilenen görevlere dağıtır. Uygulanacak görev kalmadıysa ajan bunu tek cümleyle söyler (bugünkü `steering noted, but no task is left` notice'inin yerine). `Esc` orkestrasyonda önce ana ajanın isteğini keser. Pano sağ üstündeki `esc to stop` ise ikinci `Esc` ile tüm worker'ları durdurmayı önerir: `Stop 2 running workers? enter stop · esc keep going`.

### 8.8 Uzun oturum: bağlam, compact, resume

Bağlam dolarken alt bilgi rengi değişir (≥ %70 uyarı, ≥ %90 hata; pi aynı eşikleri kullanır):

```text
  syn-smoke · master · gpt-6-astra · ctx 84% · $1.92         ? shortcuts
```

`/compact [odak]`:

```text
> /compact keep the config refactor details

● Context compacted · 182k → 41k tokens
  ⎿ kept: config refactor decisions, 6 modified files, open TODOs
```

Otomatik compaction aynı satırı `(auto)` ekiyle basar ve aktivite satırında `Compacting…` fiili görünür.

`syn agent --continue` (son oturum) veya `syn agent --resume` (seçici):

```text
Synorch 0.9 · syn-smoke (master) · gpt-6-astra · autonomous
↻ Resumed · 2h ago · 64 messages · last: "update the CI workflow to drop…"
  … 58 earlier messages (ctrl+o to show)

> update the CI workflow to drop the jest cache step too

● Edit .github/workflows/ci.yml
  ⎿ +0 −6
● Done. The cache step is gone and the workflow still runs npm test.
```

`--resume` argümansız çalışınca seçici açılır: satır başına göreli zaman, ilk mesaj, mesaj sayısı ve dal. ID yalnız L1'de görünür. Resume transcript'in son 3 alışverişini çizer, gerisini tek satıra katlar.

### 8.9 Başarısızlık ve sonraki adım

Orkestrasyonda doğrulama başarısız ve onarım bütçesi tükendi:

```text
● Workers · 2 tasks · stopped after 3m 12s
  ✓ explore-auth     explorer     Mapped login flow (5 files)
  ✗ fix-login-test   implementer  npm test still failing after 2 repairs

✗ The workers stopped: fix-login-test could not make `npm test` pass.
  Failure    tests/login.test.ts:42  expected 200, received 401
  Workspace  unchanged · the worker's edits were kept aside, not applied
  Next       /retry fix-login-test  ·  ask me to look at it  ·  ctrl+o details
```

Kimlik doğrulama hatası (doğrudan modda):

```text
> why is the build slow?

✗ Couldn't reach OpenAI: you're not signed in.
  Workspace  unchanged
  Next       syn login openai   then press ↑ and Enter to resend
```

Başlık cümlesi `✗` ile başlar ve renk olmadan da "stopped" veya "couldn't" fiiliyle anlaşılır. **Workspace** satırı her zaman vardır. `HarnessErrorInfo.workspace_effect` değerinden gelir: `none` → `unchanged`, `unknown` → `may have changed · check git status`, `partial` → dosya listesi. **Next** kopyalanabilir komutlar içerir. Hata kodu, `retry safe` ve kimlikler yalnız L2'dedir. Exit code değişmez.

### 8.10 Onay, güven ve soru istemleri

Klasör güveni (oturum açılışında, bir kez). Varsayılan seçim `Not now`:

```text
╭─ Trust this folder? ──────────────────────────────────────────────────╮
│ C:\temp\syn-smoke                                                      │
│ Synorch will read files and run commands here.                         │
│ Sandbox is partial: commands are not fully contained.                  │
│                                                                        │
│ › 1. Not now (chat only)                                               │
│   2. Trust for this session only                                       │
│   3. Trust this folder                                                 │
│                                                                        │
│ ↑↓ choose · enter confirm · esc not now                                │
╰────────────────────────────────────────────────────────────────────────╯
```

Tool onayı (`ask` policy, doğrudan mod):

```text
╭─ Run a command? ──────────────────────────────────────────────────────╮
│ npm install left-pad                                                   │
│ network · writes package.json, package-lock.json                       │
│                                                                        │
│ › 1. Yes                                                               │
│   2. Yes, and don't ask again for npm install this session             │
│   3. No, tell Synorch what to do instead                               │
│                                                                        │
│ esc no                                                                 │
╰────────────────────────────────────────────────────────────────────────╯
```

Düzenleme onayında kutu diff önizlemesini içerir (en çok 12 satır). Orkestrasyon plan onayı (`ask` policy) [§8.5](#85-plan-modu-yürütmeden-önce-birlikte-planlama)'teki checklist'i ve `Run with workers / Do it here directly / No, keep planning` seçeneklerini aynı kutuda gösterir.

Ajanın sorusu (`ask_user`):

```text
╭─ Synorch asks ────────────────────────────────────────────────────────╮
│ Should the usage section document the legacy `syn init` too?           │
│                                                                        │
│ › 1. Yes, briefly                                                      │
│   2. No, only the harness commands                                     │
│   3. Type something else…                                              │
╰────────────────────────────────────────────────────────────────────────╯
```

Kurallar:

- Başlık bir soru cümlesidir. `subject_kind` gibi iç adlar görünmez.
- `esc` hiçbir şeyi genişletmeyen seçenektir: güvende `Not now`, tool'da `No`. Güven isteminde imleç `Not now` üzerinde başlar, tool isteminde `Yes` üzerinde.
- "No, tell Synorch…" editöre odak verir ve yazılan metin ajana geri bildirim olarak gider (Claude Code ile aynı).
- Süre aşımı varsayılanı ret olarak kalır ([CLI deneyimi](./cli-experience.md)). Kalan süre 30 s'nin altına inince kutuda gösterilir.
- Karar transcript'e tek dim satır olarak düşer: `✓ Allowed npm install for this session`.
- `bell_on_prompt` (varsayılan kapalı) açıksa istemde terminal zili çalar.

### 8.11 `/` komutları

`/` yazınca autocomplete açılır (pi-tui `Editor` + `SelectList`):

```text
> /
  /plan         plan together before changing anything (read-only)
  /workers      run the current plan with parallel workers
  /review       have an independent reviewer check the current diff
  /tasks        status of the current or last worker run
  /diff         changes made in this session
  /evidence     checks and reviews behind each change
  /compact      summarize older context to free space
  /context      what the model saw in its last request
  /cost         tokens, cost and time by model
  /model        which model each role uses
  /permissions  what Synorch may do here
  /memory       memory vault and suggestions
  /log          raw event log of the last run (debug)
  /cancel       stop the current work (session stays resumable)
  /help         shortcuts and commands
  /exit         leave
```

Komut çıktıları panoyla aynı dili kullanır. Örnek `/tasks`:

```text
● Workers · 4 tasks · done in 4m 12s · approved by you for this session
  ✓ map-usage        explorer     luna   38 files mapped, 4 use mocks
  ✓ convert-mocks    implementer  astra  4 files +96 −71 · checks 1/1
  ✓ convert-simple   implementer  astra  34 files +410 −388 · checks 1/1
  ✓ review-migration reviewer     luna   Accepted after 1 revision
  ctrl+o acceptance criteria · /log raw events
```

Digest ve ID yalnız `/log` ve L2'de görünür.

### 8.12 `syn run` (tek atış)

`syn run` editör ve alt bilgi çizmez. Doğrudan modda yalnız tool satırlarını ve cevabı basar. Orkestrasyon gerektiyse pano ve rapor aynıdır:

```text
Synorch 0.9 · syn-smoke (master) · gpt-6-astra · autonomous
● Edit README.md
  ⎿ +1 −1
     12 −  Data you recieve is cached.
     12 +  Data you receive is cached.
● Fixed the "recieve" typo in README.md.
```

Toplam 6 satır.

## 9. Tuş atamaları ve komutlar

| Tuş | Boştayken | Çalışırken | Kaynak / not |
| --- | --- | --- | --- |
| `Enter` | Gönder | Kuyruğa al (sonraki güvenli sınırda uygulanır) | Bugünkü steer; pi aynı |
| `Shift+Enter`, `Ctrl+J` | Yeni satır | Yeni satır | Ctrl+J her terminalde çalışır |
| `Esc` | Autocomplete'i kapat | Etkin isteği kes. Orkestrasyonda ikinci `Esc` worker'ları durdurmayı önerir. | ADR-04; bugünkü `InterruptController` |
| `Ctrl+C` | Editör doluysa temizle; boşsa `Press Ctrl+C again to exit` | Kes; ikinci basış çıkışı önerir | ADR-04, değişmez |
| `Ctrl+D` | Editör boşsa çık | — | Bugünkü davranış |
| `Shift+Tab` | Doğrudan ↔ plan modu | Aynı (sonraki turdan itibaren) | Claude Code plan mode tuşu. Yalnız daraltır, policy genişletmez. Windows'ta VT input yoksa `Alt+M`. |
| `Ctrl+O` | L0 ↔ L1 | L0 ↔ L1 | Claude Code ve pi ile aynı |
| `Ctrl+T` | Son panoyu göster/gizle | Canlı panoyu katla | Claude Code task list tuşu |
| `Ctrl+L` | Ekranı yeniden çiz | Aynı | Claude Code ile aynı; pi'de model seçici |
| `↑` / `↓` | Geçmiş; kuyruk doluysa `↑` son kuyruk mesajını düzenler | Aynı | pi `Alt+Up` ile kuyruk düzenleme |
| `Tab` | `/` ve `@dosya` tamamlama | Aynı | pi-tui Editor |
| `?` (boş editörde) | Kısayol paneli | Aynı | Claude Code |

Eklenmeyenler: Policy'yi oturum içinde genişletmek (`ask → autonomous`) için tuş yok, bu bir onay akışıdır. Model seçici yok (`/model` bilgi verir, route config'ten gelir). Rewind ve dal ağacı (`Esc Esc`, pi `/tree`) ilk sürümde yok. Session fork zaten `syn agent --fork` ile var.

Yeni veya değişen slash komutları: `/plan` artık plan modunu açar (bugünkü "planı göster" işlevi `/tasks`'a taşınır). Yeniler: `/workers`, `/review`, `/compact`, `/cost`, `/log`, `/retry <görev>`. Runtime desteği [§14](#14-runtime-önkoşulları)'te.

## 10. Spinner, aktivite satırı ve alt bilgi

### 10.1 Aktivite satırı (yalnız etkinlik varken)

```text
<spinner> <Fiil>… <süre> · <token> [· <ek>] · esc to interrupt
```

| Faz | Fiil | Ek alan |
| --- | --- | --- |
| Model isteği, düşünme | `Thinking` | — |
| Tool çalışıyor (doğrudan) | `Running` / `Reading` / `Editing` | `npm test` |
| Plan turu (orkestrasyon öncesi) | `Planning` | `revising (2/3)` |
| Worker'lar çalışıyor | `Working` | `2 of 4 running` |
| Harness doğrulaması | `Checking` | `npm test` |
| Review | `Reviewing` | — |
| Entegrasyon | `Applying` | `39 files` |
| Compaction | `Compacting` | — |
| Onay bekliyor | `Waiting for you` | Spinner durur, glyph `?` |
| Yeniden deneme | `Retrying in 4s` | `2/5 · rate limited` |
| Stream durdu | `Waiting for OpenAI` | `15s` |

- Fiiller olgusaldır. Claude Code'un döner fiilleri ("Cogitating") ve Hermes'in kaomoji yüzleri bilgi taşımaz. Synorch'ta fiil fazı söyler.
- Süre: mevcut kullanıcı mesajından itibaren. `14s`, `1m 04s`. 1 Hz güncellenir.
- Token: bu turun girdi + çıktı toplamı (`21.4k`). Tahminse `~21k`.
- Spinner: `rich` → braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 80 ms (pi-tui `Loader` ile aynı kare seti). `safe`/`ascii` → `- \ | /` 120 ms. `SYN_REDUCED_MOTION=1` veya plain → sabit `•`/`*`.
- Pano satırlarındaki spinner'lar aynı saati paylaşır: tek zamanlayıcı, tek `requestRender`, ve yalnız değişen satırlar yazılır.
- Genişlik < 60 sütunsa önce ek alan, sonra token, sonra `esc to interrupt` düşer.
- Bir turun sonunda, süre ≥ 10 s ise, tek dim satır basılır: `  worked 42s · 18.2k tokens`. Claude Code'un `Cooked for 1m 6s` ve Hermes'in tur sonu özeti karşılığıdır. Daha kısa turlarda basılmaz.

### 10.2 Alt bilgi

Her zaman 1 satır, dim:

```text
  syn-smoke · master · gpt-6-astra · ctx 12% · $0.04               ? shortcuts
  syn-smoke · master · gpt-6-astra · plan mode · ctx 12% · $0.04   ? shortcuts
```

- Dar ekranda sağdan başlayarak alan düşer: `? shortcuts` → `$` → dal → model. `ctx%` ve mod hiçbir zaman düşmez.
- `ctx%` = son ana ajan isteğinin `model/request_prepared.context` token toplamı / route'un bağlam penceresi. Pencere bilinmiyorsa alan yoktur. Compaction'dan hemen sonra `ctx ?` (pi ile aynı).
- Renk: ≥ %70 `warning`, ≥ %90 `error`. %90'da bir kez K3 satırı: `! Context is 90% full · /compact or it will compact automatically at 95%`.
- Maliyet: API key kullanımında `$`, abonelik (OAuth) kullanımında kota yüzdesi ([açık soru 5](#16-açık-sorular)).
- Bekleyen onay varsa alt bilgi `approval waiting` olarak uyarı rengine döner. `Ctrl+C` sonrası 2 s boyunca `Press Ctrl+C again to exit` gösterir.

### 10.3 Terminal başlığı ve ilerleme

`terminal.setTitle("syn · <klasör> · <faz>")`. Windows Terminal ilerleme göstergesi (`setProgress`, OSC 9;4) iş sürerken belirsiz modda açılır. pi-tui API'si mevcuttur (`ChunkedTerminal.setProgress`).

## 11. Glyph ve renk token'ları

### 11.1 Glyph setleri

Seçim sırası: `--glyphs rich|safe|ascii` > `SYN_GLYPHS` > config `ui.glyphs` > otomatik algılama. OMP de `unicode` / `nerd` / `ascii` sembol ön ayarları kullanır. Nerd Font seti ilk sürümde yoktur.

| Token | `rich` | `safe` (WGL4 + kutu çizgisi) | `ascii` | Anlam |
| --- | --- | --- | --- | --- |
| `bullet` | `●` | `●` | `*` | Mesaj / tool satırı |
| `result` | `⎿` | `└` | `\_` | Özet satırı |
| `ok` | `✓` | `√` | `+` | Başarılı |
| `fail` | `✗` | `×` | `x` | Başarısız |
| `pending` | `○` | `o` | `.` | Bekliyor |
| `retry` | `↻` | `~` | `~` | Revizyon / yeniden deneme |
| `resume` | `↻` | `~` | `~` | Devam edilen oturum |
| `warn` | `!` | `!` | `!` | Uyarı |
| `ask` | `?` | `?` | `?` | Kullanıcı bekleniyor |
| `user` | `>` | `>` | `>` | Kullanıcı mesajı |
| `select` | `›` | `>` | `>` | Seçili öğe |
| `sep` | `·` | `·` | `-` | Alan ayırıcı |
| `arrow` | `→` | `→` | `->` | Önce → sonra |
| `minus` | `−` | `-` | `-` | Diffstat ve diff |
| `box` | `╭╮╰╯─│` | `┌┐└┘─│` | `+ + + + - \|` | Overlay çerçevesi |
| `spinner` | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `-\|/` | `-\|/` | Çalışıyor |

Neden `⏺` değil `●`: `⏺` (U+23FA) ve `⎿` (U+23BF) WGL4 dışındadır, ve Consolas ile Lucida Console'da (klasik conhost varsayılanları) glyph'leri yoktur. `●` (U+25CF), `√`, `×` ve kutu çizgileri WGL4 içindedir. Braille (U+2800 bloğu) Cascadia'da var, Consolas'ta yok. `safe` seti bu yüzden braille kullanmaz. Emoji hiçbir sette yoktur: genişliği belirsizdir ve ekran okuyucuda gürültü yapar. Hermes'in emoji ağırlıklı tool satırları bu nedenle alınmadı. Hermes'te otomatik glyph fallback'i de yok.

**Otomatik algılama** (ilk eşleşen kazanır):

1. `TERM=dumb` veya plain renderer → `ascii`.
2. POSIX'te `LC_ALL`/`LC_CTYPE`/`LANG` UTF-8 değil → `ascii`. `TERM=linux` → `safe`.
3. Windows'ta console output codepage ≠ 65001 ve `ConsoleCodepageGuard` düzeltemedi → `ascii`.
4. Windows'ta `WT_SESSION` var veya `TERM_PROGRAM` ∈ {`vscode`, `WezTerm`, …} → `rich`. Yoksa (klasik conhost) → `safe`.
5. Diğer her şey → `rich`.

`syn doctor --runtime` seçilen seti ve nedenini yazar ve bir test satırı basar (`● ⎿ ✓ ✗ ⠋`). Kullanıcı kutu görürse `SYN_GLYPHS=safe` önerilir.

### 11.2 Renk token'ları

Token'lar 16 renkli ANSI paletine eşlenir. Truecolor gerekmez, ve conhost ile açık/koyu temalar terminalin kendi paletini kullanır.

| Token | ANSI | Kullanım |
| --- | --- | --- |
| `text` | varsayılan ön plan | Cevap metni |
| `muted` | dim (SGR 2); yoksa bright black | Özetler, alt bilgi, süreler, L2 |
| `accent` | cyan | Başlık, seçili öğe, Markdown başlıkları, plan modu çizgisi |
| `user` | bold | Kullanıcı mesajı |
| `running` | cyan | Spinner, çalışan pano satırı |
| `success` | green | `✓`, `+` diffstat |
| `warning` | yellow | `!`, uyarı, onay kutusu çerçevesi, ctx ≥ %70 |
| `error` | red | `✗`, hata bloğu, `−` diffstat, ctx ≥ %90 |
| `diff.added` / `diff.removed` | green / red ön plan (arka plan değil) | Diff satırları |
| `border` | dim | Editör çizgileri, overlay çerçevesi (onay hariç) |

- Arka plan rengi kullanılmaz: açık temalarda okunmaz ve conhost'ta dim ile birleşmez. pi, kullanıcı mesajı ve tool kartı için arka plan kullanır. Synorch bunu kasıtlı olarak yapmaz.
- Bugünkü `Styler` (`bold/dim/red/green/yellow/cyan/magenta`) token katmanının altında kalır. Bileşenler `theme.success(text)` çağırır.
- `NO_COLOR` ve `--color=never` davranışı değişmez (`selectColor`). Renk kapalıyken her token kimlik fonksiyonudur, ama glyph ve önek kelimesi kalır. pi-tui'nin kendisi NO_COLOR işlemez. Synorch tema fonksiyonlarını pi-tui bileşenlerine (Editor, SelectList, Markdown) kendisi verdiği için bu kural bileşenlere de uygulanır.
- Tema dosyası bu fazda yok. `ui.theme: auto|ansi` ileride eklenebilir ([açık soru 8](#16-açık-sorular)).

## 12. Plain mod eşdeğeri

Plain renderer (`--plain`, `SYN_PLAIN`, `TERM=dumb`, TTY yok) aynı hiyerarşiyi satır bazlı, imleç hareketsiz ve animasyonsuz verir. Canlı pano yoktur. Pano **değişiklikleri** satır olarak basılır. Önek kelimeleri glyph'in yerini tutar.

[§8.4](#84-doğrudan-küçük-düzenleme-test-ve-diff) ve [§8.6](#86-konuşmaya-gömülü-orkestrasyon) plain modda (`ascii`, renk yok):

```text
Synorch 0.9 - syn-smoke (master) - gpt-6-astra - autonomous
you: --json should just be an alias for --mode jsonl. fix it and run the cli tests
tool: Search "--json" in src/harness/cli - 3 matches in 2 files
tool: Edit src/harness/cli/args.ts - +2 -1
tool: Run npm test -- tests/harness-cli - exit 0, 42 passed, 6.1s
synorch: `--json` now sets the same mode as `--mode jsonl`, and the CLI tests pass.
you: move the tests to node:test with workers
synorch: Starting 4 workers. Each works in its own worktree, and a reviewer checks the result.
workers: 4 tasks - map-usage (explorer), convert-mocks (implementer), convert-simple (implementer), review-migration (reviewer)
task 1/4 map-usage: done in 14s - 38 files mapped, 4 use mocks
status: working - 2 of 4 running - 1m 00s
task 2/4 convert-mocks: done in 1m 22s - 4 files +96 -71, checks passed 1/1
task 3/4 convert-simple: revising - 2 files still import jest
task 3/4 convert-simple: done in 3m 40s - 34 files +410 -388, checks passed 1/1
task 4/4 review-migration: accepted after 1 revision
synorch: All 38 test files use node:test now, and jest.config.js is gone.
result: done in 4m 12s
  changed: 39 files +506 -512
  checks: npm test passed, npm run lint passed (run by Synorch)
  review: accepted (luna) after 1 revision
  cost: $0.41, 212k tokens
```

Kurallar:

- Sabit önekler: `you:`, `synorch:`, `tool:`, `workers:`, `task i/n <anahtar>:`, `status:`, `warning:`, `error:`, `result:`, `question:`. Claude Code'un ekran okuyucu modu da aynı yaklaşımı kullanır (`you:`, `claude:`, `tool:`).
- Plain modda diff önizlemesi yoktur, yalnız diffstat basılır. `--verbose` diff'i `+`/`-` önekli satırlarla basar.
- `status:` bir heartbeat'tir: 30 s'de birden sık basılmaz ve yalnız içerik değişince basılır (bugünkü `[status]` dedupe mantığı).
- Worker stream metni plain modda da basılmaz. Ana ajan metni aktıkça yazılır.
- Onay istemi numaralı tek satırlık sorudur: `question: Trust this folder? C:\temp\syn-smoke [1] Not now (default) [2] This session [3] Always:`. Tool onayları için `[y/N]` biçimi korunur (D8).
- stdout ve stderr ayrımı korunur: konuşma, pano ve rapor stdout'a, uyarı ve hatalar stderr'e gider.

## 13. Erişilebilirlik

- **Renk tek kanal değildir:** Her durum glyph ve kelime taşır. NO_COLOR testi bunu doğrular.
- **Ekran okuyucu yolu plain moddur** (ADR-04; pi-tui'de ekran okuyucu modu yok). Spinner yoktur, heartbeat seyrektir, kutu çizgisi yoktur, tablolar `anahtar: değer` satırlarına döner.
- **`--accessible`** (öneri) = `--plain --glyphs ascii` + iş bitince ve istem açılınca terminal zili. Claude Code'un `--ax-screen-reader` modunun karşılığıdır.
- **Hareket:** `SYN_REDUCED_MOTION=1` spinner'ı sabitler. Süre 1 Hz'den sık güncellenmez.
- **Odak:** Overlay açıkken odak listededir, kapanınca editöre döner. İmleç IME için `CURSOR_MARKER` ile konumlanır.
- **Metin genişliği:** Türkçe karakter, CJK ve emoji içeren metin pano hizasını bozmaz. Sütunlar `visibleWidth` ile hesaplanır, özet kırpılır (`…`) ve satır sarılmaz.
- **Prompt işaretleri:** Kullanıcı mesajları OSC 133 prompt-zone işareti taşır (pi `user-message.ts`). Destekleyen terminallerde mesajlar arasında atlanabilir.

## 14. Runtime önkoşulları

Yalnız renderer ile yapılamayanlar:

- **R0 (ADR):** Konuşma öncelikli ana ajan döngüsü. Mesaj bir ana ajan turu açar ve ajan doğrudan tool'larla çalışır. Orkestrasyon bir tool'dur (`workers_run(plan)`), coordinator onun arkasına geçer. Ana ajanın yazma kapsamı ADR-08 ve ADR-09 ile yeniden tanımlanır.
- **R1:** Stream olaylarına köken atfı (`main` veya `worker: task_key`).
- **R2:** Faz ve 1 Hz tick ile `{kind:"status"}` üreticisi. `StatusLine`'a `phase`, `elapsedMs`, `tokens`, `costUsd`, `contextPercent` ve `mode` eklenir.
- **R3:** Plan modu. Geçici policy daraltması ve yapılandırılmış plan önerisi.
- **R4:** Worker tool çağrılarının hafif özeti parent'a yayılır (pano etkinliği).
- **R5:** `RunOutcome.final_message`.
- **R6:** `--continue`, `--resume` seçicisi, `/retry`, `/review`, `/compact`.
- **R7:** `ToolResult`'a opsiyonel `summary` (satır sayısı, diffstat, exit code, geçen test sayısı).
- **R8:** Güven istemi oturum açılışında sorulur.
- **R9:** Enter→istek ve TTFT ölçümü olay günlüğüne yazılır.

JSONL mevcut frame'lerle uyumlu kalır. Yeni alanlar opsiyoneldir.

## 15. Kabul ölçütleri

Ürün sahibi deneyerek kabul eder. Destek olarak birkaç sanal terminal snapshot'ı (`@xterm/headless`, 80×24) alınır.

1. **Snapshot'lar:** [§8.2](#82-selam-ve-hızlı-soru-cevap) (selam ve hızlı soru), [§8.4](#84-doğrudan-küçük-düzenleme-test-ve-diff) (doğrudan düzenleme ve test) ve [§8.6](#86-konuşmaya-gömülü-orkestrasyon) c (orkestrasyon sonucu) mockup'larına biçimce eşleşir.
2. **Kimlik ve iç jargon yok:** Varsayılan görünümde ULID, `a -> b` durum geçişi ve ham JSON yok. Snapshot'larda regex ile kontrol edilir.
3. **Hemen tepki:** Enter'dan sonra kullanıcı satırı ve spinner hemen görünür. Selam mesajında plan, pano veya görev satırı oluşmaz.
4. **Güvenlik sapmaları görünür:** Kısmi sandbox, worktree fallback'i, route fallback'i ve bütçe aşımının her biri en az bir satır üretir.
5. **`NO_COLOR=1` ve `SYN_GLYPHS=ascii`:** Renk ve Unicode glyph olmadan da durum okunur. `--mode jsonl` çıktısı değişmez.

## 16. Açık sorular

1. UI dili İngilizce mi, Türkçe mi, yoksa seçilebilir mi olacak? (Mockup'lar İngilizce.)
2. Orkestrasyon eşiği ne olsun (öneri: ≥ 5 dosya, ≥ 2 alan veya `high` risk)? Autonomous modda ajan worker'ları sormadan başlatsın mı?
3. Doğrudan düzenlemeler review'suz kalsın mı, yoksa belirli bir büyüklükte `/review` önerilsin mi?
4. Pano satırlarında rol ve model sütunları varsayılan görünümde kalsın mı?
5. Abonelik kullanıcılarında `$` yerine kota yüzdesi mi gösterilsin?
6. `Shift+Tab` yalnız plan moduna mı ayrılsın?
7. R0 sonrası her tur bir "run" mı sayılacak? Bu, `syn runs`, `syn show` ve JSONL'yi etkiler.
8. 16 renk ANSI yeterli mi, yoksa ilk sürümde bir tema dosyası isteniyor mu?
