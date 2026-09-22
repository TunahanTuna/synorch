# Harness geliştirme iş akışı

> Durum: bu deponun geliştirme çalışma anlaşması. Başlangıç: 2026-09-22. Ürün runtime'ının davranışı için [tasarım belgelerine](../README.md) bakılır; bu dosya bugün insanların/agent'ların **harness'ı nasıl geliştireceğini** anlatır.

## 1. Dal ve çalışma alanı kuralı

`harness` bu girişim için **ana entegrasyon ve dokümantasyon dalıdır**. Yeni harness çalışması bu daldaki güncel commit'ten başlar ve buraya döner. `main` mevcut Synorch ürününün ayrı çizgisidir; kullanıcı ayrı bir yayın/taşıma kararı vermedikçe harness geliştirmesi `main`e geçirilmez. Bu bir GitHub varsayılan branch ayarı veya uzak depo koruma kuralı değişikliği değildir; o işlemler ayrıca kararlaştırılır.

| İş tipi | Önerilen çalışma şekli | Entegrasyon hedefi |
| --- | --- | --- |
| Tek yazarlı belge/karar düzeltmesi | Temiz `harness` üzerinde doğrudan, küçük commit | `harness` |
| Runtime kodu veya birden çok dosyalı değişiklik | `harness`tan kısa ömürlü konu dalı; mümkünse ayrı worktree | `harness` |
| Paralel worker'lar veya riskli dosya değişikliği | Her worker'a ayrı worktree ve dosya sahipliği | Kanıtlı birleştirmeden sonra `harness` |
| Acil mevcut CLI düzeltmesi | Etkiyi ayrıca belirle; harness'ta yapılırsa mevcut `syn` regresyonu ölçülür | Önce `harness`; `main`e taşıma ayrı karar |

Konu dalı adları varsayılan olarak `codex/harness-<kisa-konu>` biçiminde olabilir. Paylaşılan `harness` üzerinde force-push, geçmişi yeniden yazma veya kullanıcıya ait değişiklikleri temizleme yapılmaz. Birleştirmeden önce `git status`, dal tabanı, hedef diff ve mevcut worktree'ler kontrol edilir. Remote PR kullanılıyorsa hedef dal `harness` seçilir. PR zorunluluğu, korumalı dal kuralı ve remote yayın politikası ayrıca karara bağlanır.

## 2. Tek işin uçtan uca akışı

```text
İstek → kapsam/riski anlama → repo ve kanıt taraması → iş notu
→ gerekirse ADR → tasarım/sözleşme → küçük dikey dilim
→ hedefli test ve güvenlik deneyi → bağımsız inceleme
→ belgeleri eşleme → harness'a entegrasyon → sonuç/izleme
```

Bu çizgi her işte aynı yoğunlukta uygulanmaz. Trivial belge düzeltmesinde kısa iş notu ve bağlantı kontrolü yeterli olabilir. Kalıcı veri formatı, auth, sandbox, provider adaptörü veya yetki değişikliğinde ADR, tehdit senaryosu ve bağımsız inceleme gerekir. Ayrıntılı karar tablosu [yönetişimde](./governance.md).

### A. İstek ve amaç

İşin tek cümlelik sonucu, kullanıcıya görünen davranışı, kapsam dışı sınırlar ve başarı ölçütleri yazılır. Kaynak olarak kullanıcı isteği, mevcut [Synorch mimarisi](../../AI-ORCHESTRATION-ARCHITECTURE.md), [harness vizyonu](../../FUTURE-MULTI-PROVIDER-HARNESS.md) ve bu dosyalardaki açık kararlar karşılaştırılır. Bir “özellik” adı yeterli kabul edilmez: en az bir yürütülebilir örnek veya hata senaryosu gerekir. İstek yeni gereksinimle eski belgeyi çeliştiriyorsa fark görünür kaydedilir.

### B. Keşif ve karar

İlgili mevcut kod, testler, manifestler ve belgeler okunur; özellik bugünkü üründe var mı, sadece öneri mi açıkça belirtilir. Dış API, lisans, sağlayıcı veya güvenlik bilgisi zamanla değişebiliyorsa resmi kaynak yeniden doğrulanır. Tasarım seçenekleri olası hata, bakım maliyeti, Windows/Unix davranışı ve geri dönüş yolu açısından kıyaslanır. [ADR kuyruğundaki](../delivery/decisions.md) bir karar etkileniyorsa uygulama öncesi ADR taslağı açılır.

### C. Tasarım ve görev parçalama

Davranış sözleşmesi, veri şeması, hata/iptal davranışı, policy etkisi, gözlemlenebilirlik ve migration yazılır. İlk dikey dilim mümkün olduğunca küçük seçilir: model/araç/session arayüzünün yalnızca gerekli parçaları uygulanır. Paralel işlerde her göreve `owned_paths`, `read_paths`, bağımlılık, kabul ölçütü ve çıkış paketi verilir. Aynı dosyayı eşzamanlı yazacak iki iş gönderilmez.

### D. Uygulama ve doğrulama

Önce geçerli davranışı kanıtlayan test/örnek, sonra kod değişikliği, sonra hedefli test yapılır. Kalıcı format veya policy için negatif test zorunludur. Değişiklik küçük tutulur; ilgisiz yeniden düzenleme aynı diff'e eklenmez. Bu repodaki mevcut toplu kapı `pnpm check` (`typecheck`, test, build); yeni runtime paketleri gelirse kendi doğrulama komutları manifestte tanımlanır. Kodu yazan worker'ın kendi testi nihai bağımsız incelemenin yerine geçmez.

### E. İnceleme ve entegrasyon

İnceleyen kişi/agent diff'i, kapsamı, güvenlik sınırını, test çıktısını ve belge iddialarını ayrı kontrol eder. Bulgular önem ve tekrar yolu ile raporlanır; bloke eden bulgular düzeltilir veya açık risk kararı alınır. Entegrasyon hedefi `harness`tır. Entegrasyondan sonra durum, ilgili commit/PR, geçen kapılar ve kalan açık kararlar kısa bir sonuç kaydında yer alır. `main`e otomatik aktarım yapılmaz.

## 3. Rol sorumlulukları

| Rol | Geliştirme sürecindeki işi | Teslim ettiği kanıt |
| --- | --- | --- |
| Ürün sahibi | Öncelik, kullanıcı değeri ve davranış tercihi | Kabul ölçütü/karar |
| Orchestrator | İş notu, kapsam, görev sırası, nihai sentez | Plan, sahiplik, kanıt matrisi |
| Explorer | Kod ve resmi kaynak incelemesi | Kaynaklı bulgular, belirsizlikler |
| Implementer | Sahip olduğu modül/dokümanda değişiklik | Diff, test çıktısı, completion packet |
| Reviewer | Yazarın iddiasını bağımsız kontrol | Bulgular, kendi doğrulaması, review packet |

Bu roller [üründe tasarlanan runtime rol sözleşmelerine](../design/orchestration-contracts.md) benzer, fakat bu belgenin kendisi çalışan bir rol yetki sistemi kurmaz. Bugünkü depoda statik talimatların teknik sınırları [mevcut durum](../foundation/current-state.md) dosyasında yazılıdır.

## 4. İşin tamamlanma tanımı

Bir iş ancak (1) kabul ölçütleri sonuç/kanıtla eşleştiğinde, (2) ilgili test ve negatif senaryolar geçtiğinde, (3) geriye uyumluluk etkisi açık olduğunda, (4) belgelerin statüsü ve bağlantıları güncellendiğinde, (5) açık risk/karar kaydedildiğinde ve (6) değişiklik `harness` üzerinde görünür hale geldiğinde kapanır. Belge/araştırma işi için kod testi gerekmez; kaynak ve bağlantı denetimi gerekir. Kullanıcının onayı gereken dış yayın veya yıkıcı adım işin teknik hazırlığı bitmeden istenmez.

## 5. Sonraki belge ve şablonlar

- [Dokümantasyon planı](./documentation-plan.md): hangi normatif belge ne zaman yazılır.
- [Görev oyun kitabı](./task-playbook.md): doldurulabilir iş notu, kanıt ve teslim şablonları.
- [Yönetişim ve değişiklik kontrolü](./governance.md): risk kapıları, ADR, çelişki ve sürümleme.
- [Teslim yol haritası](../delivery/roadmap.md): ürün fazları ve çıkış kapıları.
- [Doğrulama stratejisi](../delivery/verification.md): harness kabul senaryoları.
