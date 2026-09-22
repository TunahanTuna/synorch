# Karar, risk ve değişiklik yönetimi

> Durum: `harness` dalının geliştirme yönetişimi. Runtime içindeki approval kararının teknik sözleşmesi henüz [tasarım önerisidir](../design/tools-and-security.md); bu süreç belgesi onu uygulanmış gibi göstermemelidir.

## 1. Kaynak önceliği ve çelişki çözümü

Bir gereksinim veya davranış için şu kaynaklar kontrol edilir: (1) kullanıcının güncel isteği ve açık kararları, (2) çalışan ürünün kod/test davranışı, (3) kabul edilmiş ADR ve normatif sözleşme, (4) yürürlükteki workflow, (5) öneri tasarımları, (6) dış proje araştırması. Kod ile kabul edilmiş sözleşme ayrışıyorsa “kod doğru” veya “belge doğru” otomatik sonucu çıkarılmaz; sapma kaydedilir, beklenen davranış kararlaştırılır, ikisi birlikte düzeltilir. Dış projedeki davranış Synorch kararı yerine geçmez.

`main`in mevcut Synorch çizgisi ile `harness`ın yeni runtime çizgisi farklılaşabilir. Ortak CLI/şema dosyası değiştiğinde iki dal arasında taşıma gerekip gerekmediği ayrıca değerlendirilir. `harness` üzerinde yapılan değişiklik kendiliğinden `main`e taşınmaz. Dal koruma, remote varsayılanı veya yayın hedefi Git komutuyla sessiz değiştirilmez.

## 2. Risk sınıflaması

| Sınıf | Tipik örnek | Tasarım ve inceleme kapısı |
| --- | --- | --- |
| Trivial | Yazım, kırık bağlantı, davranışı değiştirmeyen açıklama | Kaynak/bağlantı kontrolü, küçük diff; ayrı ADR gerekmez |
| Standard | İç modül/CLI akışı, yeni test, geriye uyumlu tool | İş notu, hedefli test, `pnpm check` entegrasyon öncesi; sınır aşarsa ayrı review |
| High-risk | Auth, secret, sandbox, permission, kalıcı session formatı, provider billing, yıkıcı dosya operasyonu | ADR, tehdit/hata analizi, negatif ve platform testi, ayrı reviewer, rollback/migration |

Risk görev sırasında artabilir; bulgu yeni dosya, dış sistem veya yetki kapsamı açarsa iş durup plan ve kabul ölçütü yeniden sürümlenir. Önceki Synorch [risk oranlı ilkelerinin](../../AI-ORCHESTRATION-ARCHITECTURE.md) runtime geliştirmesine uygulanışı budur. Belge değişikliği de yanlış güvenlik iddiası yaratıyorsa high-risk inceleme isteyebilir.

## 3. ADR yaşam döngüsü

`Proposed → Accepted → Implemented → Superseded` veya `Rejected`. `Accepted`, seçeneğin gerekçeyle seçildiğini gösterir; kodun yayımlandığı anlamına gelmez. `Implemented` ancak kod/test ve belge kanıtı ile verilir. Eski ADR silinmez; yenisi `Supersedes` ile bağlanır. ADR kimliği sabit tutulur; başlık veya dosya adı değişebilir ama izlenebilirlik bozulmaz.

Bir ADR en az şunları içerir: problem ve sınır, seçenekler, ölçüm/kanıt, seçilen karar, vazgeçilenler, güvenlik/operasyon etkisi, kabul senaryosu, geri alma veya migration yolu, yeniden açma tetikleyicisi. [ADR kuyruğundaki](../delivery/decisions.md) başlıklar birer sorudur; tablo satırı kabul edilmiş karara dönüşmez. İlk uygulama için kritik kararların sırası [dokümantasyon planındadır](./documentation-plan.md).

## 4. Şema ve API değişikliği

Kalıcı event, packet, config ve JSONL frame değişimi için önce okuyucu/yazıcı uyum tablosu hazırlanır. Alan ekleme/silme, varsayılan değişimi ve anlam değişimi ayrı sınıflandırılır. Yeni şema sürümü, eski verinin okunabilirliği ve migration testi kararlaştırılır. Session geçmişi veya artifact sessizce yeniden yazılmaz. Dış plugin/protokol tüketicisi varsa destek penceresi tanımlanır. Referans doküman ve örnekler kodla aynı değişiklikte güncellenir.

## 5. Güvenlik kararı ve istisna

İzin veya sandbox garantisi metin talimatına dayanılarak ilan edilmez. Her garanti için enforcement katmanı, platform, başarısızlık modu ve testi yazılır. Bir platformda `partial` koruma varsa politika o görev için `deny/ask/allow with disclosed limitation` kararını açık verir; risk kullanıcıya görünür olur. Secret taşıma, loglama ve dış provider'a içerik gönderme kararları veri akışı diyagramına işlenir. İstisna sınırlı kapsam, süre ve gerekçeyle kaydedilir; genel varsayılan haline gelmez.

## 6. Paralel çalışma ve çatışma

Bir dosyanın aynı anda tek yazma sahibi vardır. Ortak şema/API değişikliği önce sözleşme görevinde kararlaştırılır, bağımlı worker'lar buna göre başlar. Paralel dal veya worktree'ler aynı `harness` tabanını kaydeder; eski taban sonucu çakışırsa cherry-pick/merge önce okunur, sonra çözülür. Otomatik `reset --hard`, temizleme veya force merge kullanılmaz. Entegrasyon sonrasında ana dalda çıkan regresyonu, değişikliği birleştiren iş sahiplenir; kök neden ve düzeltme kanıtı kaydedilir.

## 7. İnceleme kararı

Reviewer şu iddiaları ayrı ayrı değerlendirir: gereksinim karşılandı mı; istenmeyen dosya/etki var mı; başarısız ve iptal yolları doğru mu; yetki sınırı kanıtlandı mı; testler anlamlı mı; belgeler uygulanan davranışı mı anlatıyor; migration/geri alma mümkün mü. “Test geçti” ifadesi tek başına review sonucu değildir. Bulguların her biri dosya/olay/tekrar adımı ve önem derecesi taşır. Kabul ölçütü kanıtsızsa sonuç `revise` veya `block` olur.

## 8. Entegrasyon ve yayın ayrımı

`harness`a entegre etmek geliştirme sonucunu görünür kılar. Remote'a push, PR açma, `main`e birleştirme, npm yayınlama ve kullanıcı hesabını/credential'ı bağlama ayrı eylemlerdir. Bu eylemler ancak o görevde açıkça istenmiş veya daha önce yetkilendirilmişse yapılır. Öncesinde ilgili diff, test, paket çıktısı ve geri dönüş bilgisi hazırlanır. Yayın kararı [delivery yol haritasından](../delivery/roadmap.md) çıkarılmaz; kullanıcı/product owner kararıdır.

## 9. Süreç iyileştirmesi

Bir kapı tekrar tekrar yanlış alarm üretiyor, gerçek hatayı kaçırıyor veya gereksiz bekleme yaratıyorsa olay kaydı açılır. Yeni süreç kuralı gözlenen problem, alternatif, ölçüm ve güncelleme tarihiyle değiştirilir. Süreç metni büyüdüğü için değil, anlaşılır ve uygulanabilir kaldığı için değer taşır. Özellikle trivial işlerde gereksiz onay ve tekrar keşif maliyeti [doğrulama metrikleriyle](../delivery/verification.md) izlenir.
