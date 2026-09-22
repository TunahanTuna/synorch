# Sağlayıcılar, kimlik bilgileri ve yapılandırma

> Statü: öneri. Bugünkü Synorch yalnızca mantıksal model profilleri üretir; hesap bağlantısı kurmaz. [Gelecek vizyonu](../../FUTURE-MULTI-PROVIDER-HARNESS.md) ürün sınırıdır.

## Üç ayrı kimlik

`provider` (servis/yerel endpoint), `model` (gerçek model ID) ve `role tier` (`orchestrator`, `complex_worker`, `fast_worker`) ayrı kaydedilir. Bir role route seçimi, modelin o anda erişilebilir olduğunu kanıtlamaz. Session açılışında ve request öncesinde gerçek route/capability kontrolü gerekir. Provider sessiz fallback yapıyorsa veya usage alanını döndürmüyorsa adapter bunu bildirmelidir.

## Adapter capability çıktısı

```yaml
provider_id: example
auth_status: connected
models:
  - id: provider-model-id
    context_window: 200000
    tool_calls: true
    streaming: true
    cancellation: true
    image_input: false
    usage_reporting: exact
    system_message_updates: false
probed_at: 2026-09-22T00:00:00Z
source: provider-api
```

Alanlar **taslak**; değerler örnektir, hiçbir gerçek model iddiası değildir. Capability keşfi statik konfigürasyon + runtime probe + sağlayıcı hatasını ayrıştırmalı. Bilinmeyen kabiliyet `false` gibi gizlenmez; `unknown` olarak raporlanır. Route kararı hangi veriye dayandığını audit olayında taşır.

## Konfigürasyon önceliği

Önerilen sıra: session override → proje ayarı → workspace ayarı → kullanıcı ayarı → provider varsayılanı. Her ayar için `value`, `source`, `scope` ve `persisted` bilgisi CLI'da gösterilir. Ortam değişkeni gizli bilgi içerebilir; kullanıcıya ham değer değil kaynak adı gösterilir. Geçici model seçimi “varsayılan olarak kaydet” açıkça istenmedikçe diske yazılmaz. Repo içindeki `.ai/` politika dosyaları güven sınırını platform veya kullanıcı izninin üstüne çıkaramaz.

## Auth ilkeleri

- Yalnızca sağlayıcının resmi API key, OAuth/device-code veya kurumsal gateway yöntemi desteklenir.
- Tüketici aboneliği API erişimi anlamına gelmez; doğrulanamayan haklar `unknown` olarak gösterilir.
- Secret keychain/credential store'da saklanır; log, task packet, tool env ve diff'e yazılmaz.
- Worker'a bütün credential seti verilmez; sadece ihtiyaç duyulan tool/provider için dar, süreli erişim sağlanır.
- Aynı host'taki yerel model endpoint'i güvenilir ilan edilmez; URL, network scope, auth ve TLS politikası uygulanır.
- Provider değişimi maliyet, veri aktarımı ve model davranışı açısından görünür bir karar olayıdır.

## Hata taksonomisi

`unauthenticated`, `forbidden`, `model_unavailable`, `rate_limited`, `quota_exhausted`, `context_overflow`, `timeout`, `cancelled`, `stream_interrupted`, `provider_internal`, `protocol_mismatch`. Her biri retry güvenliği ve kullanıcı eylemi açısından farklıdır. `rate_limited` için `retry_after` varsa kullanılır; yan etkili tool'ların tekrarını model isteği retry'siyle karıştırma. Model çağrısı başarısız olduğunda otomatik başka provider'a geçme; [orkestrasyon politikası](./orchestration-contracts.md) ile karar ver.

## Kullanım ve bütçe

Usage kaydında `provider-reported`, `adapter-estimated`, `unknown` kaynağı bulunmalı. Fiyat çizelgesi tarih/sürüm ve para birimi ile tutulur; fiyat güncellenirse eski run raporu geriye dönük yeniden hesaplanmaz. Request öncesi kalan task bütçesi kontrol edilir; canlı request limiti aşarsa iptal politikası açık olur. Token sayısı, USD tahmini ve tüketici planı kotası aynı alanmış gibi gösterilmez.
