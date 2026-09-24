# Synorch terminal deneyimi: Claude Code düzeyinde akıcılık brifi

> Durum: ürün sahibi geri bildirimine dayalı **tasarım ve kalite brifi**; uygulanmış özellik listesi değildir. Tarih: 2026-09-24. Kapsam: `syn agent` etkileşimli terminal deneyimi. Bu belge, [TUI spesifikasyonunun](./tui-experience.md) kısa uygulama brifidir; kabul edilmiş [ADR-04](../decisions/ADR-04-terminal-renderer.md), [ADR-08](../decisions/ADR-08-approval-policy.md) ve normatif sözleşmelerin yerini almaz.

## Kullanıcıdan gelen ihtiyaç

“UI ham geliyor. Kullanım ve ekran akışı Claude Code kadar pürüzsüz hissettirsin.”

**Hedef deneyim:** Kullanıcı komutu açtığında hemen nerede olduğunu anlar, doğal bir mesaj yazar, anında geri bildirim alır, ajanın ne yaptığını bir bakışta görür, gerektiğinde ayrıntıyı açar, kritik kararı rahatça verir ve sonucu kanıtıyla inceler. Uzun işler sırasında yazmaya veya yönlendirmeye devam edebilir. Terminal yeniden çizimi, gürültü ve iç sistem terimleri bu akışı bölmez.

Bu, Synorch'un kendi marka diliyle tasarlanacak bir kalite hedefidir. Claude Code'un belgelenmiş **etkileşim kalıpları** referanstır; birebir renk, glyph veya metin kopyası kabul ölçütü değildir.

## Bağlamı doğru oku

- Mevcut [TUI spesifikasyonu](./tui-experience.md) çok daha ayrıntılı ekran, olay eşleme, mockup ve erişilebilirlik kurallarını içeriyor. Eski §1 ve “uygulanmadı” üst notu 2026-09-23 tarihli anlık durumdur; bugünkü kod için tek başına doğru envanter sayılmamalı.
- Kodda `ConversationPresenter` kısa araç satırları, akan cevap ve durum metni üretiyor ([conversation-view.ts](../../../src/harness/tui/conversation-view.ts)); `PiTuiRenderer` editör, transkript, canlı pano, footer, overlay, worker görünümü ve render kuyruğunu birleştiriyor ([pi-tui-renderer.ts](../../../src/harness/tui/pi-tui-renderer.ts)). Bu parçalar “var” diye gerçek terminal deneyimi tamamlandı varsayılmamalı.
- Sanal terminal ve E2E testleri akış, genişlik, onay, iptal, model seçimi ve doğrudan konuşmanın bazı davranışlarını kapsıyor ([TUI testleri](../../../tests/harness-tui-pi-tui.test.ts), [girdi testleri](../../../tests/harness-tui-input-renderer.test.ts), [konuşma E2E](../../../tests/harness-e2e-conversation.test.ts)). [Faz 1–2 kapanış kaydı](../delivery/milestones/phase-1-2.md) gerçek TTY/host matrisinin ve ürün sahibi denemesinin henüz eksik olduğunu belirtiyor. Bu yüzden “ham” hissin kesin teknik nedeni değil, doğrulanacak hipotezleri aşağıda yazıyoruz.
- Öncelik sırası: güncel kullanıcı kararı → kabul edilmiş ADR/sözleşme → doğrulanmış kod ve test → tasarım önerisi → dış referans. Paralel ajanların değiştirdiği dosyalar için her uygulama diliminde yeniden envanter çıkar.

## Referans deneyimden alınan ilkeler

Anthropic'in güncel resmî belgeleri, ayrıntıları gizleyip açabilen transkript (`Ctrl+O`), çalışan ajanı kesmeden mesaj kuyruğu, klavyeyle izin kararı ve dosya değişikliklerini içeriden görme (`/diff`) davranışlarını açıklıyor. Terminal belgesi titreme ve kayan scroll konumunu ayrı bir deneyim sorunu olarak ele alıyor. Bu davranışların Synorch karşılıkları ürün hedefidir; aynı tuşların birebir taşınması, mevcut kısayollar ve terminal uyumluluğuyla test edilerek kararlaştırılır.

Kaynaklar: [Claude Code interaktif mod](https://code.claude.com/docs/en/interactive-mode), [terminal yapılandırması](https://code.claude.com/docs/en/terminal-config), [izinler](https://code.claude.com/docs/en/permissions). Karşılaştırmalı yerel araştırma: [UX araştırması](../research/ux/README.md).

## Deneyim sözleşmesi

### 1. İlk ekran ve boş durum

Tek bakışta **ürün, çalışma klasörü, aktif model, izin modu** anlaşılır; bunlar transkripti doldurmaz. Editör görsel olarak birincildir. Kullanıcıya ilk eylem için kısa, yerinde bir ipucu verilir; başarılı konfigürasyon/audit satırları basılmaz. Hata veya güven gerektiren durum varsa eylem açıkça gösterilir.

### 2. Mesaj ve ilk tepki

Enter ile kullanıcı mesajı ve “çalışıyor” durumu aynı algısal anda görünür. Editör odağı kaybolmaz, yazılan taslak korunur. Cevap akarken metin okunabilir kalır; her token yeni bir satır veya tüm ekranı sıçratan çizim üretmez. Kısa bir soru plan ya da worker panosu açmadan doğrudan cevaplanır. [TUI §4](./tui-experience.md#4-gecikme-beklentileri) gecikme hedefleri ölçüm tabanıdır.

### 3. Araçlar ve uzun işler

Varsayılan transkriptte araç başına kısa eylem + sonuç görünür; ham JSON, iç ID, tekrar eden durum geçişi görünmez. Ayrıntı açılınca aynı eylemin çıktısı, diff'i ve hata nedeni bulunur. Çok worker'lı işte tek canlı pano yerinde güncellenir; tamamlandığında kısa bir sonuç olarak sabitlenir. Kullanıcı o sırada mesaj yazabilir ve kuyruğa alındığını açıkça görür. Worker metni ana ajanın cevabı gibi görünmez.

### 4. Onay, kesme ve kurtarma

Onay istemi **ne yapılacak, nereye etki edecek, ne kadar yetki verilecek** sorularını cevaplar. Klavye odağı ve güvenli varsayılan nettir. Esc/iptal davranışı tahmin edilebilir; daha önce olmuş işi silinmiş gibi göstermez. Hata mesajı “ne oldu, ne etkilendi, şimdi ne yapılabilir” sırasıyla yazılır. Yeniden deneme sırasında sessiz bekleme yerine kısa ve güncellenen durum verilir.

### 5. Tur sonu ve yön bulma

Cevap en üstte anlaşılır. Düzenleme varsa değişen dosyalar ve doğrulama sonucu bir bakışta okunur; çalışmamış test “geçti” sayılmaz. Kullanıcı tek eylemle ayrıntılı diff veya tool çıktısına gider. Footer aktif model/mod ve gerekli bağlamı gösterir; dar ekranda önemsiz alanlar düşer. Kısayol yardımına editörden ulaşılır.

## Ekran taslağı

Bu, hiyerarşiyi gösterir; piksel veya kesin metin şartı değildir.

```text
Synorch  proje-klasoru                                  model · izin modu

> Giriş formundaki hatayı düzelt

● Giriş formunu inceledim.
  ● Read  src/login/form.tsx                       ✓
  ● Edit  src/login/form.tsx                       ✓  +8 −3
  ● Test  login-form                              ✓  12 geçti

Hata düzeltildi. Boş e-posta artık gönderilmiyor.
Değişiklik: src/login/form.tsx · Test: 12 geçti · /diff ayrıntı

┌──────────────────────────────────────────────────────────────────┐
│ Mesaj yaz…                                                       │
└──────────────────────────────────────────────────────────────────┘
proje-klasoru · model · izin modu · ? yardım
```

Çalışırken bu sabit düzenin transkript ile editör arasına **tek** etkinlik satırı veya canlı pano eklenir. Onay, editör yakınında odaklı bir katman olarak görünür. Durum bitince geçici alan kalkar, konuşma konumu sebepsiz sıçramaz.

## Öncelikli uygulama dilimleri

| Öncelik | Dilim | Beklenen değişim | Başlıca doğrulama |
| --- | --- | --- | --- |
| P0 | Gerçek terminal baz çizgisi | Windows Terminal'de açılış, kısa soru, edit, tool, onay, kesme ve uzun cevap kayıt altına alınır; sorunlar süre, titreme, sıçrama, odak ve metin gürültüsü olarak işaretlenir. | Ürün sahibinin 10 dakikalık denemesi + terminal kayıtları. |
| P0 | İlk etkileşim ve akış | Enter tepkisi, streaming, taslak/odak ve uzun cevap boyunca scroll davranışı tutarlı. | 80×24 ve dar genişlikte video/gözlem + mevcut headless testleri. |
| P0 | Bilgi hiyerarşisi | L0 temiz; her eylem kısa, genişletme ile ayrıntı kayıpsız; sonuç kartı kanıtlı. | 20 araçlık senaryoda tekrar/ID/JSON yok; ayrıntı geri bulunur. |
| P0 | Onay ve hata dili | Karar vermek ve hatadan dönmek için teknik iç terim okumak gerekmez. | Klavye ile onay/ret, iptal ve kısmi iş senaryosu. |
| P1 | Görsel cila | Boşluk, hizalama, satır kırılma, renk/glyph ve kod/diff okunurluğu tutarlı. | 40/80/120 sütun, açık/koyu terminal, `NO_COLOR`, ASCII glyph. |
| P1 | Uzun oturum | Kuyruk, worker panosu, geri dönme ve transkript içinde yön bulma rahat. | 30+ dakika oturum, resize ve resume denemesi. |

Uygulama bir dilimde küçük ve gözle görülür olmalı: önce mevcut ekranı yakala, tek sürtünmeyi düzelt, sonra aynı senaryoyu tekrar oynat. Yalnız “daha güzel” diye renderer veya event sözleşmesi değiştirme.

## “Smooth” için kabul kontrolü

- **Tepki:** Enter → kullanıcı satırı + aktivite ≤50 ms; tuş vuruşu editörde ≤16 ms; ilk token → çizim ≤1 frame. Bunlar [mevcut tasarım hedefleri](./tui-experience.md#4-gecikme-beklentileri); gerçek terminalde ölçülmeden “geçti” denmez.
- **Stabilite:** Akış, spinner, pano ve pencere yeniden boyutlandırması editörü odağından etmez; kullanıcı geçmişi okuyorsa otomatik aşağı kaydırma onu zorlamaz. 80×24'te yazı alanı ve son cevap görünür kalır.
- **Anlaşılırlık:** İlk kez kullanan biri 5 saniyede aktif modeli, güven/izin durumunu, ajanın çalışıp çalışmadığını ve kendisinden karar beklenip beklenmediğini söyleyebilir.
- **Sessizlik:** Basit soruda plan/worker/audit gürültüsü yok. Normal işte tool başına en çok [TUI L0 kuralındaki](./tui-experience.md#21-varsayılan-olarak-sessiz-kuralı-normatif) iki satır; detay saklanmaz, isteğe bağlı açılır.
- **Erişilebilirlik:** Renk tek anlam taşıyıcısı değildir. `NO_COLOR` ve `SYN_GLYPHS=ascii` okunabilir; plain mod aynı önemli bilgiyi verir. `--mode jsonl` sözleşmesi korunur.
- **Kanıt:** Sonuçta değişen dosya, testin geçti/kaldı/çalışmadı durumu ve belirsizlik açık. Gerçek TTY denemesi olmadan yalnız snapshot yeterli kabul sayılmaz.

## Uygulayıcı agent için kısa görev metni

> Synorch `syn agent` terminal deneyimini ürün sahibinin “Claude Code kadar akıcı” hedefi için iyileştir. Önce bu belgeyi, [TUI spesifikasyonunu](./tui-experience.md), [ADR-04'ü](../decisions/ADR-04-terminal-renderer.md) ve güncel `src/harness/tui/**` ile `src/harness/cli/**` kodunu oku. Mevcut davranışı “yok” varsayma; gerçek terminalde kısa soru, düzenleme, onay, uzun akış ve kesme senaryolarını gözlemle. En çok sürtünme yaratan P0 dilimini seç; önce/sonra ekranını ve gecikme/odak/scroll kanıtını kaydet. Konuşma öncelikli ve özet varsayılan bilgi hiyerarşisini uygula. Mevcut izin, güvenlik, plain ve JSONL sözleşmelerini koru. Paralel değişen dosyaları geri alma. Ürün sahibine hangi sorunun düzeldiğini, nasıl denendiğini ve kalan pürüzleri kısa bir özetle bildir.

## Sınırlar ve açık kararlar

- Bu brif, kullanıcı geri bildirimini yapılabilir kalite ölçütlerine çevirir; görsel kullanışlılık konusunda gerçek kullanıcı testi yerine geçmez.
- Dil (Türkçe/İngilizce), tema sistemi ve önerilen yeni kısayollar [TUI açık soruları](./tui-experience.md#16-açık-sorular) içindedir. İlk cila diliminde mevcut ürün dilini tutarlı kullan; yeni ürün politikası icat etme.
- [HREQ-039](../foundation/product-requirements.md) UX kapısı ürün sahibinin denemesini ister. Belge veya sanal terminal snapshot'ı tek başına bu kapıyı kapatmaz.
