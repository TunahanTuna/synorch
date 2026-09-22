# Harness kabul ve test stratejisi

> Statü: uygulama öncesi kalite sözleşmesi. Bu matristeki testler bugün mevcut değildir.

## Seviye 1: sözleşme ve deterministic replay

- Event store farklı sürüm, bilinmeyen event, yarım append ve bozuk blob referansında doğru hata verir.
- Bir model request envelope'u log ve immutable blob'lardan aynı sırada yeniden kurulur.
- Tool call/result ve approval asked/decided kimlikleri eşleşir; orphan çağrı `interrupted` projection'ına düşer.
- Compaction önceki olayları silmez ve kabul kanıtını kaybetmez.
- Task packet `source_digest` değiştiğinde dispatch engellenir; delta packet ebeveyn digest'ini doğrular.

## Seviye 2: güvenlik ve izolasyon

- Symlink/junction, `..`, mutlak yol, case farkı, hard link ve yarış senaryolarında ownership sınırı test edilir.
- Bir read-only explorer, shell/MCP veya alt araç üzerinden yazamaz.
- Approval `unavailable`, timeout ve ret halinde dış eylem çalışmaz; aynı approval başka argümana uygulanamaz.
- Sandbox `partial` raporlandığında bu durum UI ve JSON event'te yer alır; tam koruma isteyen task durur.
- Secret, model prompt/tool result/log/artifact/terminal çıkışı boyunca redaksiyon testinden geçer.
- İzin/policy prompt injection ile yükseltilemez; repo dosyası ve tool çıktısı düşük güvenli kaynak olarak işaretlenir.

## Seviye 3: uçtan uca senaryolar

| Senaryo | Başarı ölçütü |
| --- | --- |
| Trivial belge düzeltmesi | Tek worker, hedefli kanıt, gereksiz review/approval tekrarı yok |
| Standart kod değişikliği | Plan → packet → diff → test → koşullu review → rapor |
| Yüksek riskli değişiklik | Güçlü izolasyon, ayrı reviewer, kapsamlı kanıt ve açık onay |
| İki çakışan task | Scheduler aynı path'e paralel yazdırmaz |
| Crash: tool sonrası, kayıt öncesi | Belirsiz eylem tekrar edilmez; kullanıcıya açık recovery |
| Provider timeout/rate limit | Attempt başarısız, bütçe ve route görünür; sessiz fallback yok |
| Çalışırken kullanıcı düzeltmesi | Güvenli step sınırında steer; eski plan gerekiyorsa geçersiz |
| Headless onay bekleme | Fail-closed, makinece okunur sonuç ve doğru exit code |

## Ölçümler

Task tamamlama oranı yanında şu metrikler takip edilmeli: yanlış yetki verme sayısı (hedef sıfır), replay tutarlılığı, crash recovery oranı, tekrar keşif token maliyeti, kişi başına gereksiz onay sayısı, reviewer'ın yakaladığı bulgu oranı, median/p95 ilk görünür çıktı gecikmesi, task başına gerçek/tahmini maliyet farkı. Ölçümlerde model ve sağlayıcı değişkenleri ayrıca kaydedilir; tek model benchmark'ı harness başarısı diye sunulmaz.

## Doküman doğrulaması

Her uygulama PR'ında değişen interface için bir owning belge ve test eşleşir. Komut örnekleri `--help`/smoke ile, schema örnekleri parser ile, kaynak bağlantıları periyodik link check ile doğrulanır. [DeepSeek'in doküman hiyerarşisi](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) “bir olgunun tek sahibi” yaklaşımı için referanstır; bu klasörde de araştırma ile normatif runtime sözleşmesi birbirine karıştırılmaz.
