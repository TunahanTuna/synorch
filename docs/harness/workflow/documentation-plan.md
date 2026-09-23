# Harness dokümantasyon planı

> Durum: çalışma planı; aşağıda `planlandı` yazan dosyalar henüz yok. Ana dal: `harness`. Amaç, geliştirme başlamadan gerekli karar ve sözleşmeleri sırayla olgunlaştırmak; uygulama sırasında belgelerin koddan kopmasını önlemek.

## 1. Belge türleri ve tek sahip ilkesi

| Tür | İşlevi | Normatif mi? | Örnek |
| --- | --- | --- | --- |
| Araştırma | Dış sistemde gözlenen davranış ve kaynak | Hayır | `research/*.md` |
| Ürün gereksinimi | Kullanıcı davranışı, kapsam ve kabul ölçütü | Karar verildikten sonra evet | planlanan `foundation/product-requirements.md` |
| Mimari harita | Bileşen, veri akışı ve sahiplik | Kabul edildikten sonra evet | `design/runtime-architecture.md` |
| Sözleşme/referans | Alan, tip, hata, durum ve sürüm semantiği | Şema onayı sonrası evet | planlanan `contracts/*.md` |
| ADR | Seçilen alternatif ve gerekçe | `Accepted` iken evet | planlanan `decisions/ADR-*.md` |
| Oyun kitabı | Geliştirici/operatör prosedürü | Süreç için evet | `workflow/*.md` |
| Test/kanıt | Kabul senaryoları ve ölçümler | İlgili faz için evet | `delivery/verification.md` |

Bir bilgi kendi türünün bir dosyasında ayrıntılı anlatılır; diğer belgeler oraya bağlanır. Örneğin `EventStore` alanları sözleşme referansında, neden event sourcing seçildiği ADR'de, çalışma sırası workflow'da durur. Ürün kodu yayımlandıktan sonra API ve CLI davranışının nihai doğrulayıcısı test ve implementasyondur; belgede amaç farklıysa drift kaydı açılır. [DeepSeek Harness'ın doküman standardı](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) bu ayrım için araştırma referansıdır.

## 2. Bugünkü belge envanteri

| Alan | Bugünkü durum | Sonraki işlem |
| --- | --- | --- |
| [Mevcut Synorch mimarisi](../../AI-ORCHESTRATION-ARCHITECTURE.md) | Uygulanan yapı ve kısmen tarihsel kararlar | Yeni runtime özelliği gibi yorumlama; gerektiğinde doğrula |
| [Çok sağlayıcılı vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md) | Öneri ve geniş ürün yönü | Faz/öncelik değiştiğinde güncelle; detayları tekrar etme |
| `research/` | Kaynaklı dış inceleme | Uygulama sprintinde upstream commit ve lisans tekrar doğrula |
| `foundation/current-state.md` | Depo taban çizgisi | Her büyük release veya mimari değişimde eşleştir |
| `design/` | Uygulama öncesi tasarım önerileri | ADR onayından sonra normatif sözleşmelere bağla |
| `delivery/` | Yol haritası, test ve açık karar | Faz çıkışında sonuç ve kanıtla güncelle |
| `workflow/` | `harness` dalındaki çalışma usulü | Süreç değişince aynı commit'te güncelle |

Bu tablo dosyaların bugün **uygulanmış runtime** kanıtı olduğunu söylemez. [Mevcut durum](../foundation/current-state.md) ayrımı belirler.

## 3. Yazım sırası ve teslim paketleri

### D0 — Kapsam ve izlenebilirlik

Önce ürünün ilk kullanıcısı, ilk yerel CLI senaryosu, desteklenen işletim sistemleri, ilk provider, risk sınırları ve başarı metrikleri kararlaştırılır. Sonuçta gereksinimler `HREQ-001` gibi sabit ID alır; her gereksinim bir kullanıcı senaryosu, kabul ölçütü ve kaynak/karar bağlantısı taşır.

| Planlanan belge | İçerik | Tamamlanma kapısı |
| --- | --- | --- |
| `foundation/product-requirements.md` | Kullanıcı/persona, ilk sürüm kapsamı, kapsam dışı, davranış örnekleri | Ürün sahibi ilk dikey dilimi ve sınırları onaylar |
| `foundation/terminology.md` | Run, session, turn, step, task, attempt, approval, artifact ayrımı | Tüm tasarım belgeleri aynı sözcükleri kullanır |
| `foundation/requirements-traceability.md` | HREQ → ADR → sözleşme → test → commit eşlemesi | Her P0 gereksinimin kabul kanıtı tanımlı |

### D1 — Belirsiz tasarım kararları

[ADR kuyruğundaki](../delivery/decisions.md) seçenekler üzerinde gereken mini deneyler yapılır. İlk uygulama için asgari kararlar: repo/paket sınırı, event store formatı, ilk provider/auth, tool policy ve sandbox tabanı, terminal renderer, onay kapsamı, worker izolasyonu. Karar eksikse uygulama yalnızca değiştirilebilir prototip olarak işaretlenir; production varsayımı yapılmaz.

| Planlanan belge | İçerik | Tamamlanma kapısı |
| --- | --- | --- |
| `decisions/ADR-01-*.md` … | Bağlam, seçenekler, ölçülen deney, karar, geri dönüş | İlgili tasarım ve test maddesine bağlantı |
| `decisions/README.md` | Accepted/Superseded/Proposed dizini | Açık kararlar tek listede görünür |

### D2 — Uygulama öncesi normatif sözleşmeler

Bu aşamadaki örnek JSON/YAML'ler parse edilmeli ve kodla aynı şema kaynağından doğrulanmalıdır. Önce kavramları netleştir, sonra şemayı dondur; dokümana elle yazılmış tipler tek kaynak haline gelmesin.

| Planlanan belge | Asgari konu | Bağımlılık |
| --- | --- | --- |
| `contracts/identity-and-state.md` | ID tipleri, Run/Task/Attempt/Step state machine, geçiş koşulları | D0, event ADR |
| `contracts/events-and-storage.md` | Event envelope, sıralama, append, flush, replay, migration | Depolama ADR |
| `contracts/model-adapter.md` | Capability, stream, cancel, usage, hata taksonomisi | Provider ADR |
| `contracts/tools.md` | Tool metadata/schema, output cap, cancellation, idempotency | Tool/policy ADR |
| `contracts/policy-and-approval.md` | Yetki kesişimi, action digest, grant ömrü, headless sonuç | Approval/sandbox ADR |
| `contracts/task-packets.md` | Context/completion/review vNext, digest/freshness | Rol ve state sözleşmesi |
| `contracts/cli-and-jsonl.md` | İnsan komutları, frame, stdout/stderr, exit code | Terminal ve headless ADR |

### D3 — Güvenlik ve operasyon hazırlığı

| Planlanan belge | Asgari konu | Tamamlanma kapısı |
| --- | --- | --- |
| `security/threat-model.md` | Varlıklar, güven sınırları, injection, secret, path escape, provider spoofing | Her yüksek risk tehdidine kontrol ve test |
| `security/platform-matrix.md` | Windows/macOS/Linux sandbox seviyeleri, gerçek enforcement | Her iddianın platform deneyi |
| `operations/recovery-runbook.md` | Crash, çift resume, disk dolması, rate limit, bozuk session | Operatör güvenli devam/iptal yolu |
| `operations/data-and-privacy.md` | Credential/log/blob konumu, retention, export/delete | Kullanıcı verisi yaşam döngüsü açık |

### D4 — Kodla birlikte büyüyecek referans

Kod ve test henüz yokken ayrıntılı API referansı yazılmaz. İlk dikey dilim geldiğinde kaynak tiplerinden üretilen veya doğrulanan `reference/` sayfaları açılır: CLI help, config, event catalog, tool catalog, error codes ve provider capability matrix. Her davranış değişikliği, owning referans ve testle aynı değişiklikte güncellenir. Üretilmiş referans elle düzeltilmez; üretici düzeltilir.

### D5 — Kabul ve yayın

`delivery/verification.md` senaryoları fixture/test ID'leriyle bağlanır. Faz çıkışı için `delivery/milestones/<id>.md` kanıt kaydı açılır: commit, paket sürümü, geçen test, platform/providera göre sınırlar, açık hatalar ve sonraki karar. Bir release yapılacaksa `operations/upgrade-and-migration.md` ve değişiklik notu hazırlanır. `main`e taşıma veya npm yayın, `harness`a entegrasyondan ayrı karardır.

## 4. Her belge için kalite sözleşmesi

Belgenin başında **durum** (`research`, `proposal`, `accepted`, `implemented`, `superseded`), son doğrulama tarihi ve sahibi olan alt sistem belirtilir. Doğrulanabilir mevcut iddia dosya/test/commit veya resmi dış kaynak bağlantısı taşır. Örnek komut gerçekten mevcutsa çalıştırılır; taslak komut “öneri” diye işaretlenir. Bir özelliğin hem mevcut hem planlı anlatımı varsa tablo ile ayrılır. Belge değişikliği referans ettiği karar ve testte etki taraması yapar. Göreli bağlantılar ve kod blokları denetlenir.

## 5. Güncelleme tetikleyicileri

- Kullanıcı hedefi veya önceliği değişti → gereksinim ve traceability.
- ADR kabul edildi veya değişti → ilgili design, contract, roadmap, test.
- Şema/CLI/tool davranışı değişti → sözleşme, örnek, migration ve `--help` doğrulaması.
- Upstream kaynak değişti → araştırma tarihi, commit, etkilenmiş çıkarım.
- Güvenlik olayı veya başarısız test → threat model, runbook ve regresyon.
- Faz çıkışı veya release → uygulandı statüsü, gerçek limitler, kanıt kaydı.

## 6. Planın bitmiş sayılması

“Bütün belgeler yazıldı” tek kapı değildir. D0–D3 tamamlandığında ilk runtime dilimini güvenle geliştirmek için yeterli normatif temel vardır. D4 ve D5 kodla birlikte canlı tutulur. Her P0 gereksinimi bir ADR veya açık varsayım, bir sözleşme maddesi, bir doğrulama senaryosu ve sorumlu modülle izlenebilir olmalıdır. Bu bağlantı yoksa ilgili iş uygulamaya hazır değildir.

## 7. Konuşma öncelikli pivot (revizyon notu, 2026-09-23)

Revizyon: ürün sahibinin konuşma öncelikli ürün tanımıyla D0 geriye dönük tamamlandı. Önceki bölümler değiştirilmedi; §3'teki "planlanan `foundation/product-requirements.md`" artık vardır (durum `proposal`, ürün sahibi onayı bekleniyor).

| Aşama | Belge | Kapı |
| --- | --- | --- |
| D0 — kapsam | [product-requirements.md](../foundation/product-requirements.md) (persona, yolculuklar, gecikme, HREQ-023…040, ayrıştırıcılar), [izlenebilirlik](../foundation/requirements-traceability.md) satırları | Ürün sahibi ilk dikey dilimi ve sınırları onaylar |
| D1 — karar | [ADR-21](../decisions/ADR-21-conversation-first-runtime.md) (ADR-08/09 deltası, tur/run kimliği, doğrudan mod yetki matrisi) | ADR-21 `Accepted` (K0 onayıyla) |
| D2 — sözleşme | [conversation-runtime §3](../design/conversation-runtime.md#3-sözleşme-değişiklikleri-tek-commit-k0dan-önce): tek sözleşme commit'i | `pnpm check` yeşil, eski olaylar okunur |
| Dikey dilim | [uygulama planı §8.2 K0](../implementation-plan.md#82-k0--dikey-dilim-ürün-sahibi-deneyecek) | Ürün sahibi gerçek terminalde dener (UX kapısı, [yönetişim §11](./governance.md#11-ux-kapısı)) |
| Dalgalar | Uygulama planı §8.3–8.5 (K1…K4) | Dalga sonu UX kapısı; K2 sonunda tek review |

Ekran tasarımı ayrı iş akışındadır: [TUI deneyimi](../design/tui-experience.md), [UX araştırması](../research/ux/README.md). Ürün sahibinin tasarım bağlamı: [harness-context.yaml](../harness-context.yaml).
