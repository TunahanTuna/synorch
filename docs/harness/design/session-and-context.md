# Oturum, geçmiş ve bağlam yönetimi

> Statü: öneri. İlham: [OMP session](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md), [OMP compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md), [DeepSeek session](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session), [Claude Code oturumları](https://code.claude.com/docs/en/how-claude-code-works).

## Tek doğruluk kaynağı

Session'ın kalıcı aslı tipli, sıralı, append-only olay günlüğüdür. Etkin sohbet geçmişi, görev tablosu ve UI görünümü bu logdan projection olarak hesaplanır. Eski olaylar değiştirilmez; düzeltme yeni olayla yapılır. Başlangıçta SQLite/WAL veya segmentli JSONL seçimi [açık karardır](../delivery/decisions.md); iki format için de aynı invariants geçerli:

- `seq` artan, tek session içinde benzersiz; `eventVersion` ve yazıcı sürümü mevcut.
- Büyük tool çıktıları ayrı blob/artifact dosyasında tutulur; olay digest ve boyutunu taşır.
- Her model request için kullanılan sistem mesajı, user/skill/context ekleri, tool schema seti, route ve history kesimi yeniden kurulabilir.
- Kısmi stream ayrı `attempt` statüsüdür; settled assistant mesajıyla karıştırılmaz.
- Gizli veri log veya artifact'a yazılmadan redakte edilir; redaksiyonun gerçekleştiği olayda izlenir.
- Yazma başarısızsa UI “kaydedildi” demez; yeni yan etkili tool yürütülmez.

## Önerilen olay aileleri

| Aile | Örnekler | Model görünürlüğü |
| --- | --- | --- |
| `run/*`, `plan/*`, `task/*`, `attempt/*` | açılış, onay, atama, durum | Yalnızca seçilmiş context projection |
| `turn/*`, `step/*` | başlangıç/bitiş/neden | Log-only |
| `message/*` | system, user, assistant | Evet, verilen sürüm/kesimde |
| `tool/*` | call, policy decision, result | Call/result model geçmişine girer; policy metadata girmez |
| `approval/*` | asked, decided, invalidated | Sonuç gerektiği kadar bağlam; kimlik ve gerekçe audit |
| `context/*` | included, compacted, source changed | Seçilen özet veya bildirim görünür |
| `provider/*` | route, usage, error | Kullanıcıya görünür durum; modele yalnızca gerekli hata |

Event payload için JSON schema/Zod tek kaynaktan üretilir. Geriye dönük okuyucu, bilinmeyen versiyonu sessiz atlamak yerine `unsupported` olarak raporlar.

## ContextBuilder algoritması

1. Session'ın etkin dalını ve onaylanmış plan sürümünü seç.
2. Anayasa/protokol/rol talimatlarını güven ve öncelik sırasıyla ekle; düşük güvenli repo metnini yüksek öncelikli sistem talimatı gibi sunma.
3. Skill açıklamalarını katalog halinde sun, tam SKILL.md içeriğini yalnızca tetiklendiğinde yükle.
4. Görev paketindeki kaynak/digest'leri ve gerçek dosya sürümlerini eşleştir. Uyumsuzlukta dispatch'i durdur.
5. Geçerli branch'teki son compaction sınırından sonraki history'yi ve tool call/result çiftlerini yeniden kur.
6. Modelin context limitine göre bütçe uygula; hangi blokların kısaltıldığına dair olay yaz.
7. Son `requestEnvelopeDigest` ile provider'a gönder; replay komutu bu envelope'un redakte edilmiş dökümünü gösterebilir.

## Compaction sözleşmesi

Özet, kaynak olay aralığı, kullanılan model/yöntem, oluşturulma zamanı, korunacak açık işler, önemli kararlar, dosya/artifact referansları ve belirsizlikler ile saklanır. Orijinal olaylar silinmez. Özet **kanıt yerine geçmez**; görev kabulünde ilgili test/artifact kaydına dönülür. Threshold, overflow ve manuel tetikleyici ayrılır. Tek bir tool çıktısı bağlamı dolduruyorsa önce bounded tool output uygulanır. Tekrar tekrar özetleyip dolma (“thrash”) saptanır ve açık hata verilir.

## Resume, fork ve crash

`resume` aynı session kimliğine ekleme yapar, `fork` yeni kimlikte sabitlenmiş atasal olay aralığına işaret eder. Tek yazıcı lock'u ve heartbeat lease'i gerekir. Crash sonrası yarım model stream, açık tool call veya bekleyen approval için deterministic recovery durumu üretilir. Dış yan etkili çağrı onaysız otomatik tekrarlanmaz. Worker task ve artifact digest'leri mevcutsa kullanıcıya “devam”, “yeniden dene” ve “iptal et” seçenekleri verilir.

## Bağlam ölçümleri

Her request için kaynaklara göre token tahmini/gerçek kullanım, prompt cache bilgisi varsa provider ölçümü, skill yükleme, tool output truncation ve compaction tasarrufu ayrı kaydedilir. Tahmini tutar gerçek fatura diye gösterilmez. Aynı task'ın tekrar keşif maliyeti izlenir; [Synorch'un context packet hedefi](../../AI-ORCHESTRATION-ARCHITECTURE.md) böyle ölçülebilir hale gelir.
