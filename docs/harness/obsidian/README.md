# Obsidian ile yerel hafıza ve bilgi haritası

> Statü: dış kaynak araştırması ve Synorch için tasarım önerisi. Entegrasyon henüz uygulanmadı.
>
> İnceleme tarihi: 2026-09-22. Ürün sürümü, CLI ve lisans koşulları uygulama öncesi yeniden doğrulanmalıdır.

## 1. Amaç ve Synorch bağlamı

Synorch'un hedefi yerel terminalde çalışan, kendi orchestration akışını yöneten bir CLI harness. [Runtime sözleşmeleri](../design/orchestration-contracts.md), orchestrator ve görev rollerini; [oturum ve bağlam tasarımı](../design/session-and-context.md), kalıcı olay günlüğünü ve ContextBuilder'ı tarif ediyor. Bu belge şu soruyu ele alıyor: Görevler arasında işe yarayan proje bilgisi, kararlar, varsayımlar ve bunların ilişkileri nerede saklanmalı; kullanıcı bunları Obsidian ile nasıl inceleyebilmeli?

Önceki ürün tartışmasındaki **belirsizlik haritası + karar masası** bu tasarımın kullanıcı deneyimi hedefidir. Bir işte hangi kararların geçerli olduğu, hangi varsayımların açık kaldığı ve önerilen yeni bilginin neye dayandığı görünür olmalı. Obsidian, bu bilgilerin okunması ve görselleştirilmesi için adaydır; karar verme ve doğrulama mantığı Synorch'ta kalır.

Bu belge mevcut kodda hazır bir hafıza modülü, API veya CLI komutu bulunduğunu varsaymaz. Aşağıdaki tür, alan ve komut adları uygulanmamış önerilerdir.

### Tasarım hedefleri

- CLI, Obsidian kurulu veya açık değilken de hafızayı okuyup yazabilsin.
- Kalıcı her iddianın kaynağı, kapsamı, durumu ve güncelliği görülebilsin.
- Görev bağlamına yalnızca ilgili ve geçerli bilgi girsin.
- Otomatik ilişki ve çelişki çıkarımı, kanıt ve kullanıcı değerlendirmesi olmadan gerçek kabul edilmesin.
- Kullanıcı notları düzenleyebilsin; Synorch bu değişiklikleri sessizce ezmesin.
- Veri, standart araçlarla okunabilir ve başka ürüne taşınabilir kalsın.

## 2. Obsidian'ın temeli

Obsidian, Markdown biçimli düz metin notlarını **vault** denen yerel bir klasörde saklar. Vault alt klasörleri de kapsar. Başka editörler aynı notları düzenleyebilir ve Obsidian dışarıdan gelen değişiklikleri algılar. Vault açmak için uzak servis veya Obsidian Sync gerekmez. Obsidian, ayarlarını vault kökündeki .obsidian klasöründe tutabilir. [Obsidian: How Obsidian stores data](https://obsidian.md/help/data-storage)

| Yerleşik özellik | Ne yapar? | Synorch'a katkısı |
| --- | --- | --- |
| Markdown dosyaları | İnsan ve program tarafından okunur | Taşınabilir kalıcı bilgi |
| İç bağlantılar ve backlinks | Notlar arası gezinme | Karar, kanıt, kavram ilişkileri |
| Graph view | İç bağlantıları düğüm ve çizgi olarak gösterir | Görsel keşif |
| Properties | YAML ön madde alanlarını düzenler | Tür, durum, kaynak, tarih ve kapsam |
| Bases | Notları özelliklere göre tablo/listede gösterir | Karar ve inceleme kuyruğu |
| Search | Vault içeriğini arar | İnsan incelemesi |

Graph view, var olan bağlantıları görselleştirir. İki notun anlamsal olarak benzer veya çelişkili olduğunu kendi başına kanıtlamaz. Bases görünümü de not dosyaları ve özellikleri üzerinde çalışır; ayrı bir kalıcı veritabanı olarak görülmemelidir. [Graph view](https://obsidian.md/help/plugins/graph), [Properties](https://obsidian.md/help/properties), [Bases](https://obsidian.md/help/bases/create-base)

Obsidian hem çift köşeli ayraçlı wiki bağlantılarını hem standart Markdown bağlantılarını destekler. Taşınabilirlik için standart Markdown bağlantıları tercih edilebilir. Obsidian'a özgü blok referansları diğer araçlarda çalışmayabilir. [Internal links](https://obsidian.md/help/links)

## 3. Entegrasyon yolları ve API gereksinimi

**Temel yerel hafıza için Obsidian API'si veya yeni bir ağ servisi gerekmez.** Synorch Markdown dosyalarını doğrudan okur ve yazar; kullanıcı klasörü Obsidian'da açar. Obsidian kapalıyken Synorch çalışmaya devam eder. Bu, Obsidian'ın dosya tabanlı saklama biçiminden çıkan mimari öneridir. [Data storage](https://obsidian.md/help/data-storage)

| Entegrasyon | Sağladığı şey | Çalışma koşulu | Önerilen rol |
| --- | --- | --- | --- |
| Dosya sistemi | Not oluşturma, okuma, indeksleme | Yerel klasöre erişim | Çekirdek hafıza adaptörü |
| Obsidian URI | Notu veya aramayı uygulamada açma | Obsidian yüklü | İsteğe bağlı kullanıcı kısayolu |
| Resmi Obsidian CLI | Arama, okuma, not/Bases işlemleri | Masaüstü uygulaması; kapalıysa başlatılır | İsteğe bağlı entegrasyon |
| Plugin API | Obsidian içinde özel panel ve eylemler | Eklenti kurulumu ve çalışan uygulama | Gereksinim doğrulanırsa ileride |
| Headless Sync | Uzak vault ile eşitleme | Sync aboneliği; açık beta | Yerel çekirdeğin dışında |

Obsidian'ın **resmi CLI'ı** bulunuyor. Resmi yardım 1.12.7+ yükleyiciyi, ayardan CLI'ın açılmasını ve masaüstü uygulamasına bağlantıyı anlatıyor. İlk komut kapalı uygulamayı başlatabilir. CLI arama, okuma, oluşturma, bağlantı ve Bases komutları sunuyor. Obsidian URI, open/new/search gibi eylemleri destekliyor. Headless Sync ise masaüstü olmadan uzak eşitleme içindir; yerel hafıza motoru değildir. [CLI](https://obsidian.md/help/cli), [URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI), [Headless Sync](https://obsidian.md/help/sync/headless)

**Önerilen sınır:** Dosya sistemi çekirdek olsun. CLI/URI Obsidian kullanan kişiye kolaylık katsın. Üçüncü taraf REST eklentisi veya özel plugin ilk sürüm bağımlılığı olmasın.

## 4. Mevcut oturum mimarisiyle ilişki

[Oturum ve bağlam belgesi](../design/session-and-context.md), session'ın kalıcı aslını sıralı, append-only olay günlüğü olarak öneriyor. Obsidian notları bu günlüğün yerine geçmez. Görev, attempt, tool call ve approval olayları o logda kalır. Markdown hafıza notları, günlükteki kanıtı veya depo durumunu işaret eden **insan tarafından incelenebilir bilgi projeksiyonlarıdır**.

~~~text
Run / Task / Attempt olayları ------> append-only session log
           |                                  |
           | aday bilgi ve kaynak             | kanıt kimliği
           v                                  v
    Hafıza değerlendirme --------------> kabul edilmiş bilgi
           |                                  |
           | öneri kuyruğu                    v
           +--------------------------> Markdown vault
                                             |
                         +-------------------+------------------+
                         v                                      v
                  Synorch CLI sorgusu                      Obsidian görünümü
~~~

Ayrılması gereken veri sınıfları:

1. **Çalışma izi:** Ham tool çıktıları, ara planlar ve denemeler. Hacimli ve geçici; vault'a topluca kopyalanmaz.
2. **Kalıcı bilgi:** Onaylanmış kararlar, kullanıcı tercihleri, proje kuralları, doğrulanmış bulgular.
3. **Kanıt işaretçisi:** Task/attempt kimliği, dosya yolu, revizyon veya digest, test sonucu. İddianın kaynağına götürür.
4. **Türetilmiş indeks:** Tam metin, bağlantı ve isteğe bağlı vektör araması için yeniden üretilebilir yerel veri.
5. **Öneri kuyruğu:** Olası bağlantı, çelişki veya eskime tespiti; henüz kalıcı gerçek değildir.

ContextBuilder'ın mevcut önerilen kaynak/digest doğrulaması korunmalı. Hafızadan getirilen iddia da kaynağı ve durumu olmadan yüksek öncelikli talimat gibi modele sunulmamalı. [ContextBuilder sözleşmesi](../design/session-and-context.md)

## 5. Önerilen hafıza modeli

### 5.1 Bilgi türleri ve yaşam döngüsü

| Tür | Amaç | Örnek durum |
| --- | --- | --- |
| Project | Proje kapsamı ve kimliği | active, archived |
| Decision | Seçenek, gerekçe, etkiler, geri alma koşulu | proposed, accepted, superseded, rejected |
| Assumption | Henüz doğrulanmamış kabul | open, verified, invalidated |
| Question | Açık belirsizlik | open, resolved |
| Evidence | Bir iddianın kaynağı | current, stale, unavailable |
| Concept | Bileşen veya alan kavramı | active, deprecated |
| Preference | Kullanıcının açık çalışma tercihi | active, revoked |

Bu türler **Synorch şeması önerisidir**; Obsidian'ın zorunlu kavramları değildir. İlişki türleri de Synorch tarafından tanımlanmalı: supports, contradicts, depends_on, supersedes, affects, originated_from. Obsidian'ın standart Graph view'ı genel bağlantıyı çizer; bu anlamsal kenar türlerini doğal olarak ayırmaz.

### 5.2 Vault yerleşimi

~~~text
<yerel-hafıza-kökü>/
  README.md
  projects/
    <project-id>/
      index.md
      decisions/
      assumptions/
      questions/
      evidence/
      concepts/
  shared/
    preferences/
  views/
    decisions.base
    review-queue.base
~~~

Varsayılan konum uygulama öncesi karara bağlanmalı. Depoya alınan ekip bilgisi ile kullanıcıya özel yerel hafıza aynı gizlilik ve paylaşım politikasına sahip değildir. Harness dokümantasyonunun **harness** branch'inde tutulması kararı, çalışma zamanındaki kişisel hafızanın otomatik olarak Git'e veya aynı branch'e yazılacağı anlamına gelmez. Birden çok worktree/branch varsa bilgi kapsamı açık tutulmalı. Obsidian, iç içe vault düzeninden kaçınmayı öneriyor; bağlantılar şaşabilir. [Data storage](https://obsidian.md/help/data-storage)

### 5.3 Örnek not şeması

Aşağıdaki alanlar ve dosya adları yalnızca öneridir:

~~~markdown
---
id: dec-0042
kind: decision
project_id: synorch
scope: project
status: accepted
created_at: 2026-09-22
reviewed_at: 2026-09-22
source_task: task-018
source_ref: repo/path/to/source@revision
confidence: high
owner: human
---

# Hafıza notları yerel Markdown olarak tutulacak

## Karar
CLI, Obsidian çalışmadan hafızaya erişebilir.

## Gerekçe
Son kullanıcı Obsidian kurmak zorunda kalmamalıdır.

## Etkiler
- Obsidian isteğe bağlı bilgi arayüzüdür.
- Arama indeksi notlardan yeniden üretilebilir.

## İlgili notlar
- [Hafıza mimarisi](../concepts/memory-architecture.md)
- [Açık soru](../questions/que-0007.md)
~~~

Kalıcı **id**, değişebilen dosya yolundan bağımsızdır. **project_id/scope** bağlam karışmasını engeller. **source_ref**, **reviewed_at** ve **confidence** bir iddianın yeniden değerlendirilmesine yardım eder. Tekrarlanabilir kimlik ve alan doğrulaması Synorch tarafında yapılmalıdır. Obsidian'ın Properties özelliği bu YAML alanlarını arayüzde gösterir. [Properties](https://obsidian.md/help/properties)

## 6. Haritalama ve geri çağırma

### 6.1 İlişki üretim basamakları

1. **Açık ilişki:** Kullanıcı veya task paketi iki öğeyi bağlar. Kaynağıyla kaydedilir.
2. **Kural tabanlı aday:** Aynı dosya, kavram, hata veya karar kimliği görülür. İnceleme kuyruğuna alınır.
3. **Anlamsal aday:** Yerel ya da harici model benzerlik/çelişki önerir. Model çıktısı kanıt sayılmaz.
4. **Onaylanmış ilişki:** İnsan veya önceden belirlenmiş deterministik kural kabul eder. Kalıcı hafızaya geçer.

İlk iki basamak için model veya Obsidian API'si gerekmez. Üçüncü basamakta harici model API'si **bir seçenek** olabilir; yerel model de mümkündür. Anlamsal haritanın değerini yanlış ilişki oranı, gecikme, maliyet ve kullanıcıya sağladığı faydayla ölçmek gerekir.

### 6.2 Geri çağırma sırası

- Proje, branch, kapsam, durum ve geçerlilik filtresini uygula.
- Açık bağlantı ve anahtar sözcük/tam metin aramasını kullan.
- Gerekirse anlamsal sıralama ekle.
- Sonuçla birlikte **neden getirildi**, kaynak, gözden geçirme tarihi ve güven düzeyini göster.
- Superseded karar yürütmeyi yönlendirmesin; geçmiş gerekçe olarak erişilebilir kalsın.
- Kaynak digest'i artık eşleşmiyorsa bilgi stale olsun ve görev bağlamına kesin gerçek gibi girme.

Arama indeksi bozulduğunda notlardan yeniden kurulabilmelidir. Obsidian'ın kendi metadata cache'i dosyalarla bazen ayrışabilir ve uygulamadan yeniden oluşturulabilir; Synorch kendi sorgularını bu iç cache'e bağlamamalı. [Obsidian data storage ve metadata cache](https://obsidian.md/help/data-storage)

### 6.3 Belirsizlik haritası + karar masası deneyimi

CLI görev başında “2 geçerli karar, 1 açık varsayım, 1 olası çelişki” gibi kısa bir özet verebilir. Her kayıtta kaynak ve göreve neden dahil edildiği görünür. Çelişki bulunduğunda iki iddia ve kanıtları yan yana sunulur. Kullanıcı **kabul et, reddet, ertele, kaynağı aç, yeniden doğrula** eylemlerinden birini seçer. Görev sonunda önerilen hafıza değişikliklerinin farkı gösterilir. Obsidian aynı öğelerin not ve grafik görünümünü sağlar.

Bu deneyimin asıl değeri grafiğin görüntüsü değil, kararların izlenebilirliği ve kullanıcının kontrolüdür.

## 7. Tutarlılık, güvenlik ve gizlilik

### 7.1 Eşzamanlı düzenleme

- Yazmadan önce dosyanın son içerik özetini veya sürümünü kontrol et.
- Synorch'un yönettiği alanlarla kullanıcının serbest metninin sahipliğini tanımla.
- Beklenmeyen dış değişiklikte sessiz overwrite yapma; farkı ve birleştirme seçeneklerini göster.
- Dosya izleme döngülerine karşı debounce ve idempotency uygula.
- Toplu değişikliklerde kısmi hata, geri alma ve platforma uygun atomik yazmayı sınayıp belgeye bağla.
- Not taşınsa bile kalıcı id ile referansı çöz; kırık bağlantıları raporla.

İleride Obsidian eklentisi geliştirilirse resmi Vault API içindeki **process** yöntemi, eklenti içinde okuma/yazma arasında veri kaybını önlemek için önerilir. Ayrı Synorch sürecinin dosyadan yazması için bu garanti kendiliğinden geçerli olmaz; iki tarafın çakışma sözleşmesi gerekir. [Vault API](https://docs.obsidian.md/Plugins/Vault)

### 7.2 Saklama politikası

- Token, parola, özel anahtar ve ham ortam değişkenleri hafızaya girmez.
- Ham sohbet ve tüm tool çıktıları varsayılan olarak vault'a aktarılmaz.
- Hassas içerik ayıklama, not dosyasına yazmadan önce yapılır.
- Repo/web/tool metni **veri ve kanıt** olarak ele alınır; üst düzey talimat yetkisi kazanmaz.
- Kaynağı belirsiz bilgi doğrudan accepted karara dönüşmez.
- Silme, dışa aktarma ve proje hafızasını sıfırlama kullanıcıya açık işlemler olmalıdır.
- Ekipçe paylaşılan vault ile kişisel hafıza ayrı konum ve erişim kuralları kullanmalıdır.

Yerel vault varsayılan olarak şifreli değildir; Obsidian Sync'in uzak vault şifrelemesi farklı bir özelliktir. Topluluk eklentileri Obsidian'ın dosya/ağ erişimini devralabilir; resmi güvenlik açıklaması eklentilerin dar izinlerle sınırlandırılamadığını belirtiyor. Bu nedenle üçüncü taraf REST veya grafik eklentilerini güvenlik incelemesi olmadan çekirdeğe bağlamamak gerekir. [Sync güvenliği](https://obsidian.md/help/sync/security), [Plugin security](https://obsidian.md/help/plugin-security)

### 7.3 Branch ve sürüm ilişkisi

Notun hangi proje, depo, branch ve gerekiyorsa commit için geçerli olduğu açıkça belirtilmeli. Bir branch'teki mimari karar ötekine otomatik taşınmamalı. Paylaşılan dosyalar Git'e alınırsa Obsidian'ın sık değişen workspace ayar dosyaları için resmi .gitignore önerisi değerlendirilmelidir. [Data storage](https://obsidian.md/help/data-storage)

## 8. Kullanıcı akışı ve taslak CLI

Aşağıdaki komutlar **taslak sözdizimidir**; mevcut Synorch komutları değildir:

~~~text
syn memory status
syn memory search "kimlik doğrulama"
syn memory show dec-0042
syn memory related dec-0042
syn memory review
syn memory open dec-0042 --in obsidian
syn memory reindex
~~~

Beklenen akış:

1. Görev başında ContextBuilder kapsamla eşleşen ve geçerli hafızayı seçer.
2. Task packet, gerekli iddiaları kaynak/digest bilgisiyle taşır.
3. Görev sonunda yeni karar ve varsayım adayları üretilir.
4. Kullanıcı öneriyi kabul eder, düzenler veya erteler.
5. Synorch olay kaydını ve Markdown notunu tutarlı biçimde günceller; türetilmiş indeksi yeniler.
6. Obsidian yüklüyse kullanıcı ilgili notu URI ile açar; yüklü değilse CLI aynı içeriği sunar.
7. Obsidian'daki insan düzenlemesi dosya değişimi olarak görülür ve doğrulama/çakışma sürecinden geçer.

URI'da vault ve dosya hedefleri kodlanmalı; aynı başlıklı notlarda tam yol tercih edilmeli. Resmi CLI, vault seçimi ve arama/okuma komutları sağlar; ancak masaüstü uygulamasına bağlıdır. [URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI), [CLI](https://obsidian.md/help/cli)

## 9. Aşamalı teslim önerisi

| Aşama | Çıktı | Geçiş ölçütü |
| --- | --- | --- |
| 0. Sözleşme | Türler, kapsam, kaynak ve alan sahipliği | Örnek notlar ve yaşam döngüsü onaylı |
| 1. Yerel temel | Markdown adaptörü, doğrulama, indeks, CLI sorguları | Obsidian olmadan çalışıyor |
| 2. Güvenli yazma | Ön izleme, çakışma, sır ayıklama, geri alma | Veri kaybı/sızıntı senaryoları sınanmış |
| 3. Obsidian görünümü | Vault açma yönergesi, URI, Graph/Bases örnekleri | Aynı notlar uygulamada gezilebiliyor |
| 4. İlişki motoru | Kural tabanlı bağlantı ve eskime/çelişki adayları | Kaynaklı öneri ve onay akışı çalışıyor |
| 5. İsteğe bağlı semantik katman | Yerel/harici model adaptörü ve kalite ölçümü | Yanlış öneri, maliyet ve gecikme kabul edilebilir |
| 6. Gerekirse özel eklenti | Obsidian içinde Synorch paneli | CLI'da karşılanmayan doğrulanmış ihtiyaç var |

Bu tablo teslim tarihi veya onaylanmış roadmap değildir; [ana roadmap](../delivery/roadmap.md) ve [açık kararlar](../delivery/decisions.md) ile uygulama öncesi eşleştirilmelidir.

## 10. Açık kararlar ve kabul senaryoları

### Kapanması gereken kararlar

1. Varsayılan hafıza kökü proje içinde mi, kullanıcı alanında mı?
2. Hangi türler kullanıcı onayı olmadan kalıcı hale gelebilir?
3. Kullanıcı notu değiştirirse hangi alanlarda öncelik kimde?
4. Çoklu repo, branch ve worktree kapsamları nasıl eşlenir?
5. Şema sürümü ve not göçü nasıl yönetilir?
6. Obsidian Bases ürünce desteklenen bir görünüm mü, yalnızca örnek mi?
7. Yerel semantik modelin kullanıcıya ölçülebilir yararı var mı?
8. Silinen/geçersiz kılınan bilginin geçmişi ne kadar tutulur?

### Kabul senaryoları

- Obsidian kurulu değilken not yazma, arama ve kaynak gösterme çalışır.
- Kullanıcı Obsidian'da not düzenlediğinde sonraki Synorch okuması değişikliği fark eder.
- İki süreç aynı notu değiştirirse bilgi kaybı olmadan çakışma görünür.
- Eski branch kararı yeni branch'teki göreve kesin gerçek diye eklenmez.
- Kaynağı değişen iddia stale işaretlenir.
- Modelin yanlış çelişki önerisi reddedilince karar notlarını değiştirmez.
- Arama indeksi silinse de Markdown notlarından yeniden kurulabilir.
- Vault sır içeren ham tool çıktısını otomatik saklamaz.

## 11. Resmi kaynaklar

- [How Obsidian stores data](https://obsidian.md/help/data-storage): yerel Markdown vault, dış düzenleme, metadata cache ve Git ayarları.
- [Internal links](https://obsidian.md/help/links): wiki/Markdown bağlantıları ve taşınabilirlik.
- [Graph view](https://obsidian.md/help/plugins/graph): grafiğin bağlantıları nasıl gösterdiği.
- [Properties](https://obsidian.md/help/properties): YAML ön madde ve alan türleri.
- [Bases](https://obsidian.md/help/bases/create-base) ve [Bases syntax](https://obsidian.md/help/bases/syntax): tablo görünümleri ve dosya biçimi.
- [Obsidian CLI](https://obsidian.md/help/cli): kurulum, masaüstü bağımlılığı ve komutlar.
- [Obsidian URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI): uygulamadan not/arama açma.
- [Headless Sync](https://obsidian.md/help/sync/headless): abonelik gerektiren açık beta eşitleme.
- [Plugin Vault API](https://docs.obsidian.md/Plugins/Vault): eklenti içinden dosya işlemleri.
- [Plugin security](https://obsidian.md/help/plugin-security) ve [Sync security](https://obsidian.md/help/sync/security): güven sınırları.

**Özet tasarım kararı adayı:** Synorch hafızası Obsidian uyumlu yerel Markdown üzerinde çalışabilir; Obsidian zorunlu runtime bağımlılığı olmaz. Append-only session log kanıt ve olay geçmişinin aslı olarak kalır. Semantik haritalama ve kullanıcı onayı Synorch'un orchestration/bağlam katmanına bağlanır.
