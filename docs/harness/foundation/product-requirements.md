# Ürün gereksinimleri: konuşma öncelikli Synorch harness

> Durum: `proposal` (D0 teslimi), 2026-09-23. Sahip: entegrasyon; karar sahibi: ürün sahibi. Tamamlanma kapısı ([dokümantasyon planı D0](../workflow/documentation-plan.md#d0--kapsam-ve-izlenebilirlik)): **ürün sahibi ilk dikey dilimi ve sınırları onaylar.** Okuma sözleşmesi ve yetki sırası: [harness-context.yaml](../harness-context.yaml) `reading_contract` (en güncel açık kullanıcı kararı > kabul edilmiş ADR ve `src/harness/contracts/**` > doğrulanmış kod ve test > tasarım bağlamı ve UX önerileri > dış araştırma). Bağlı karar: [ADR-21](../decisions/ADR-21-conversation-first-runtime.md). Bileşen tasarımı: [conversation-runtime.md](../design/conversation-runtime.md). Ekran: [TUI deneyimi](../design/tui-experience.md). İzlenebilirlik: [requirements-traceability.md](./requirements-traceability.md) (HREQ-023…040).

## 0. Neden bu belge var

D0'ın eksik belgesi buydu. Runtime "her mesaj bir koordinatör run'ıdır" varsayımıyla kuruldu: her mesaj orchestrator modeline gider, `plan_propose` zorunludur, worker'lar ayrı oturumlarda çalışır, doğrulama ve review yapılır (`src/harness/cli/session.ts`, `orchestration/coordinator.ts`). Orchestrator yazamaz ve komut çalıştıramaz. Sonuç: "selam" bile planlama turu açar.

Ürün sahibinin bağlayıcı tanımı (yetki sırasında en üstte): **Synorch harness, Claude Code gibi kullanılan konuşma öncelikli etkileşimli bir kodlama ajanıdır.** Orkestrasyon Synorch'un farkıdır ama ana ajanın iş gerektirdiğinde çağırdığı bir kabiliyettir. Bu, [harness-context.yaml](../harness-context.yaml) `project_baseline.target_experience` ve HCTX-01 ile aynıdır; oradaki HD-01/HD-02/HD-04 açık kararları ADR-21'de kapanır.

## 1. Persona

| Kimlik | Tanım | Öncelik |
| --- | --- | --- |
| **P1 — Lider geliştirici (ürün sahibi)** | Büyük kod tabanlarını uzun oturumlarda geliştirir. Birincil ortam Windows 11 + Windows Terminal; macOS/Linux/SSH ikincil. Claude Code ve Codex'i her gün kullanır; ChatGPT ve Claude aboneliği, gerektiğinde API key. Türkçe ve İngilizce yazar. Küçük işte sohbet hızı, büyük işte orkestrasyon kalitesi (paralel worker, bağımsız review, kanıt) ister. Bilgiyi Obsidian vault'unda tutar. | Birincil |
| **P2 — Otomasyon** | CI/betikten `syn run "<hedef>" --mode jsonl`; insan yok, exit code'a güvenir. | İkincil |
| **P3 — Ekip** | Paylaşılan politika, çok kullanıcı. | Kapsam dışı |

## 2. Etkileşim modeli

```text
syn agent  →  başlık + imleç (model isteği yok, soru yok)
mesaj      →  ANA AJAN tek tur açar, hemen stream eder
               ├─ yalnız cevap                  selam, soru
               ├─ doğrudan araç                  read / search / edit / exec (policy + sandbox + güven + audit)
               ├─ plan modu  (/plan, Shift+Tab)  salt okuma, plan bloğu, kullanıcı seçer
               └─ orkestrasyon                   gösterilen plan → coordinator → worker'lar → review → entegre
                                                 turun içinde; pano canlı; Enter = steer, Esc = durdur
```

- **Tek muhatap:** kullanıcı hep ana ajanla ("Synorch") konuşur; worker'lar panoda görünür, sohbet metnine karışmaz ([TUI §3](../design/tui-experience.md#3-etkileşim-modeli)).
- **Doğrudan iş varsayılan.** Orkestrasyon büyük/çok parçalı/yüksek riskli işte önerilir veya kullanıcı ister (`/plan`, `/workers`, "paralel yap").
- **Otonom varsayılan (ADR-08), görünür orkestrasyon:** otonomda plan bloğu gösterilir ve run hemen başlar (Esc/steer); `ask` modunda sorulur.
- **Aynı güvenlik hattı:** her araç çağrısı mevcut gateway'den geçer; hard rail'ler hiçbir modda gevşemez (HCTX-05/06).
- **Review:** doğrudan düzenlemeler zorunlu review'dan geçmez ve sonuç satırı bunu açıkça söyler ("not independently reviewed · /review"); orkestre edilen işte zorunlu bağımsız review sürer (ADR-09, HCTX-10, HD-04).

## 3. Çekirdek yolculuklar

Ekranlar: [TUI §8](../design/tui-experience.md#8-mockuplar).

| # | Yolculuk | Beklenen |
| --- | --- | --- |
| J1 | Selam / kısa soru | Tek model isteği, sıfır araç, sıfır plan/görev olayı; imleç hemen spinner'a döner ([§8.2](../design/tui-experience.md#82-selam-ve-hızlı-soru-cevap)). |
| J2 | Kodu açıklatma | `read_file`/`search` ile okur, tek satırlık araç satırları, açıklama ([§8.3](../design/tui-experience.md#83-kodu-okuyarak-açıklama)). |
| J3 | Doğrudan düzenleme + test | Ana ağaca yazar (worktree yok), testi çalıştırır (güvenilmeyen klasörde güven sorusu burada, bir kez), sonuç satırı değişen yolları ve doğrulamayı gösterir; tur checkpoint bırakır, `/undo` geri alır ([§8.4](../design/tui-experience.md#84-doğrudan-küçük-düzenleme-test-ve-diff)). |
| J4 | Plan tartışması | `/plan <hedef>`: salt okuma, plan bloğu, sohbetle revizyon; *Workers ile çalıştır / Burada doğrudan yap / Planlamaya devam* ([§8.5](../design/tui-experience.md#85-plan-modu-yürütmeden-önce-birlikte-planlama)). |
| J5 | Orkestre edilmiş büyük değişiklik | Plan bloğu → coordinator (worktree, harness doğrulaması, bağımsız review, entegrasyon) → pano → sonuç raporu; ana ajan sonucu aynı turda özetler ([§8.6](../design/tui-experience.md#86-konuşmaya-gömülü-orkestrasyon)). |
| J6 | Uzun oturum ve devam | Boşta compaction, `/compact`, `--continue`/`--resume`/`--fork`; crash sonrası yan etki tekrarlanmaz ([§8.8](../design/tui-experience.md#88-uzun-oturum-bağlam-compact-resume)). |
| J7 | Hafıza | Tur başında model çağrısız geri çağırma, "neden getirildi"; öneriler ADR-17 kuyruğuna. |
| J8 | Headless | `syn run "<hedef>"` tek tur; `--mode jsonl` yalnız frame; `--orchestrate` eski yol ([§8.12](../design/tui-experience.md#812-syn-run-tek-atış)). |
| J9 | Kesme ve yönlendirme | Esc istek + araç batch'ini keser; çalışırken Enter kuyruğa alır, güvenli sınırda uygulanır ([§8.7](../design/tui-experience.md#87-kesme-ve-yönlendirme)). |

## 4. Gecikme hedefleri

[TUI §4](../design/tui-experience.md#4-gecikme-beklentileri) ile aynıdır; burada gereksinim olarak sabitlenir. Sağlayıcının TTFT'si harness'in kontrolünde değildir; harness'in eklediği süre ölçülür ve olay günlüğüne yazılır (TUI R9).

| # | Ölçü | Hedef |
| --- | --- | --- |
| L1 | `syn agent` → editör hazır (sıcak başlangıç, istemler hariç) | p95 ≤ 700 ms |
| L2 | Enter → kullanıcı satırı + spinner | ≤ 50 ms |
| L3 | Enter → sağlayıcıya istek (doğrudan mod) | p95 ≤ 300 ms |
| L4 | Cevaplayan istekten önce ek model çağrısı | 0 |
| L5 | "selam" gerçek sağlayıcıyla | cevap ≈ 1–2 s içinde akmaya başlar (ürün sahibi kontrolü) |
| L6 | 200. turda L3 | korunur (tam log yeniden okuma yok) |

## 5. Gereksinimler

| HREQ | Öncelik | Gereksinim | Bağ |
| --- | --- | --- | --- |
| HREQ-023 | P0 | Her mesaj ana ajanın bir turunu açar ve hemen stream edilen cevap üretir; plan/DAG/worker zorunlu değildir. | J1–J3, HCTX-01 |
| HREQ-024 | P0 | L1–L4 hedefleri; açılışta model isteği ve soru yok; güven sorusu yalnız depo kodu çalıştıran ilk exec'te (ADR-21 D3, UX-GATE-01). | J1, TUI R9 |
| HREQ-025 | P0 | Ana ajanın her araç çağrısı mevcut gateway hattından geçer; hard rail'ler değişmez. | HCTX-05/06 |
| HREQ-026 | P0 | Ana ajan ana ağacı doğrudan düzenler; kapsam: çalışma alanı eksi ayrılmış yollar ve policy kaynakları; git geçmişini değiştirmez. | J3, ADR-21 D3, HD-01 |
| HREQ-027 | P0 | Ana ajan komut çalıştırır; mevcut exec sınırlaması ve çalışma alanı güveni geçerlidir (Windows'ta kısmi sandbox tam koruma gibi gösterilmez). | J3, HCTX-07 |
| HREQ-028 | P0 | Doğrudan düzenlemenin sonucu değişen yolları, doğrulamayı ve "bağımsız review yapılmadı" etiketini gösterir; `/review` isteğe bağlı bağımsız review başlatır. | J3, HD-04 |
| HREQ-029 | P1 | Tur checkpoint'i ve `/undo` (yalnız harness'in yazdığı dosyalar; exec etkileri kapsam dışı ve söylenir). | J3 |
| HREQ-030 | P1 | Plan modu: salt okuma, plan bloğu, açık seçim. | J4 |
| HREQ-031 | P0 | Orkestrasyon ana ajanın aracıdır; mevcut coordinator aynı oturumda çalışır, olayları oturum günlüğüne gömülür, sonucu ana ajana özetlenir; zorunlu review ve kanıt aynen. | J5, HCTX-09/10 |
| HREQ-032 | P0 | Orkestrasyon gösterilmiş plan olmadan başlamaz; otonomda gösterip başlatır, `ask`'te sorar. | J5, ADR-08 |
| HREQ-033 | P0 | Her mesaj bir turdur; run yalnız orkestrasyonla açılır; `syn runs/show` run'ları listeler; JSONL tur frame'leri taşır. | HD-02 |
| HREQ-034 | P0 | Uzun oturum: boşta compaction, tur başına hafıza çağırma, kararlı önek önbelleği, L6. | J6, HCTX-03/04 |
| HREQ-035 | P0 | Konuşma oturumu resume/fork/recovery; belirsiz yan etki tekrarlanmaz; `--continue`. | J6, HCTX-02 |
| HREQ-036 | P1 | Hafıza tur başına model çağrısız geri çağrılır; öneriler ADR-17 kuyruğuna. | J7, HCTX-11 |
| HREQ-037 | P0 | `syn run` tek turdur; JSONL geriye uyumlu genişler; `--orchestrate` eski yolu korur. | J8 |
| HREQ-038 | P0 | Esc/Ctrl+C ve steer semantiği (ADR-21 D8). | J9 |
| HREQ-039 | P0 | UX kapısı: ana konuşma görünümü tasarıma uyar (birkaç snapshot) ve ürün sahibi dener ([yönetişim §11](../workflow/governance.md#11-ux-kapısı)). | tümü |
| HREQ-040 | P1 | Ayrıştırıcı özellikler (§7) dalgalara bağlı sunulur. | J4–J7 |

HREQ-002 değişmez: orchestrator hâlâ ürün dosyası yazmaz; doğrudan yazma yeni `session` rolünündür.

## 6. Kapsam dışı

- IDE eklentisi, web/desktop UI, daemon, uzak runner, çok kullanıcı (v1 listesi geçerli).
- Her mesaj için zorunlu planlama; mesajı sınıflandıran ayrı model isteği.
- Kullanıcı istemeden commit/push/publish; v1'de ana ajan git geçmişini değiştirmez.
- Exec yan etkilerini geri alma.
- Model-model serbest sürü; orkestrasyon yalnız plan/paket sözleşmesiyle.
- Legacy `syn inspect/init/sync/doctor` davranış değişikliği (HREQ-001).
- Kapsamlı eval/replay matrisleri (HCTX-13 önerisi): ürün sahibinin "önce inşa et" kararıyla sonraya.

## 7. Ayrıştırıcı özellikler

Kaynak: [vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md) §12, §17–18; [Obsidian](../obsidian/README.md) §6.3; [TUI](../design/tui-experience.md); [harness-context.yaml](../harness-context.yaml). Efor: S ≤ 3 gün, M ≤ 2 hafta. Dalgalar: [uygulama planı §8](../implementation-plan.md#8-konuşma-öncelikli-çekirdek-dalgası).

| # | Özellik | Değer | Bugün kodda | Eksik | Efor | Dalga |
| --- | --- | --- | --- | --- | --- | --- |
| X1 | Sohbette görünür orkestrasyon (canlı checklist, worker rol/model/ilerleme) | Büyük işte ne olduğu görünür; çok modelli örgüt Synorch'un yüzü | `task/*`, `attempt/*`, `route/decided`, coordinator `onEvent`, `/tasks` | TUI R1/R2/R4, pano bileşeni | M | K2 |
| X2 | Kanıt matrisi `/evidence` (kriter → harness'in koştuğu kanıt) | İddia değil kontrol edilebilir kanıt | `/evidence`, `harness_evidence`, `attempt/verification_ran`, `syn show --json` | Sohbette tablo | S | K2 |
| X3 | Aboneliklerle sağlayıcılar arası review | Aynı model kendi hatasını kaçırmaz, ek API maliyeti yok | Router'da bağımsız reviewer tercihi, `claude-code` köprüsü | Doğrudan diff için `/review`, route kurulum UX'i | S–M | K3 |
| X4 | Karar masası + belirsizlik haritası (Obsidian) | Uzun projede kararlar izlenebilir, kontrol kullanıcıda | MemoryStore, öneri kuyruğu, `syn memory review`, ilişki/çelişki adayları, `open --in obsidian` | Tur başı özet, sohbet içi kabul/ret | M | K4 |
| X5 | Zaman yolculuğu: fork / rewind | Riskli deneme geri alınır, alternatif denenir | `--fork <id>@<seq>`, yeniden kurulabilir envelope | Checkpoint (K1), `/rewind`, oturum içi `/fork` | M | K1 (checkpoint) + K4 |
| X6 | `/why` policy açıklanabilirliği | Ret anlaşılır, güvenlik sessiz değil | `explainPermission`, `tool/policy_decided` gerekçeleri, `/permissions` | `/why [#n]` | S | K1 |
| X7 | Kota/maliyet farkındalığı (abonelikte %, API key'de $) | Kota bitmeden görünür; sessiz ücretli fallback yok | `quota` stream olayı, `provider/usage`, ADR-14 | Alt bilgi göstergesi | S | K2 |

Dikey dilimde (K0) hiçbiri yoktur; sohbet hızı ve güvenilirliği önce gelir.

## 8. Kaydedilen kararlar

Orchestrator/ürün sahibi, 2026-09-23 (TUI §16 sorularının cevabı): UI metni İngilizce, cevaplar kullanıcının dilinde, yerelleştirme sonra; ana ajan büyük işte worker önerir, otonomda plan gösterip başlatır (Esc/steer), `ask`'te sorar, kullanıcı `/plan` veya "paralel yap" ile zorlar; doğrudan düzenlemede zorunlu review yok, `/review` isteğe bağlı, orkestrasyonda zorunlu review sürer; abonelikte kota %, API key'de $; her mesaj bir tur, run yalnız orkestrasyonla, JSONL'de tur frame'leri; 16 renk, panoda rol/model sütunları, `Shift+Tab` plan modu. Önce inşa et: test hafif, tek büyük kilometre taşında bir review.

## 9. İlk dikey dilim (onay kapısı)

Atılabilir depoda ([canlı smoke test](../delivery/live-smoke-test.md) fikstürü) gerçek terminalde:

1. `syn agent` → başlık + imleç, soru yok.
2. `selam` → anında cevap.
3. `check.mjs ne yapıyor?` → okuyarak açıklama.
4. `add()'i düzelt` → doğrudan düzenleme.
5. `testi çalıştır` → güven sorusu o anda bir kez, sonra `node check.mjs` çıktısı.
6. Uzun cevabı Esc ile kesme, `/exit`, `syn agent --resume <id>` ile dönüş.

Plan modu, orkestrasyon aracı, checkpoint ve ayrıştırıcılar dilimde yoktur. Açık sorular ADR-21'dedir.
