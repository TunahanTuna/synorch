# Araştırmadan uygulamaya aşamalı yol haritası

> Statü: plan önerisi. [Eski harness vizyonundaki fazlar](../../FUTURE-MULTI-PROVIDER-HARNESS.md) ürün yönünü verir; buradaki sıra CLI runtime için ölçülebilir teslim kapıları ekler. Bu belgeleri hazırlamak, geliştirmeyi başlatmaz.

Bu fazların günlük yürütme sırası [geliştirme iş akışında](../workflow/README.md), belge teslim sırası [dokümantasyon planında](../workflow/documentation-plan.md) tanımlıdır. Entegrasyon hedefi `harness` dalıdır; `main`e aktarım bu planın otomatik sonucu değildir.

## Faz 0 — Karar ve sözleşme temeli

Çıktı: [açık kararları](./decisions.md) ADR ile kapatma; canonical packet/ledger/event ve provider capability şemaları; risk/onay politikasının açık matrisi; mevcut `syn` komutlarının geriye uyumluluk testi. Upstream referanslar commit SHA ile sabitlenir. Kod taşınacaksa lisans ve bağımlılık denetimi yapılır.

**Çıkış kapısı:** Aynı görev, plan, completion ve review paketleri şema doğrulamasından geçer; bozuk ve yetki genişletmeye çalışan örnekler reddedilir.

## Faz 1 — Tek sağlayıcılı yerel agent çekirdeği

Terminal UI, model stream, sınırlı dosya/search/patch/exec araçları, tek session event store, iptal, bounded output, `doctor --runtime`. Başlangıçta bir orchestrator ve en fazla bir implementer yeterlidir. Prompt görünürlüğü replay ile denetlenebilir.

**Çıkış kapısı:** Tek görev crash/yeniden başlatma sonrası doğru statüde açılır; açık yan etkili tool çağrısı sessizce tekrarlanmaz; modelin gördüğü giriş yeniden üretilebilir.

## Faz 2 — Synorch orkestrasyonunun yürütülmesi

Task DAG, task packet digest/freshness, rol yetkileri, dosya ownership, risk sınıfı, plan/onay, completion ve bağımsız review packet. Explorer/debugger/implementer/reviewer ayrı runtime rolüdür. Eşzamanlılık önce küçük bir global limit ile başlar.

**Çıkış kapısı:** İki worker aynı path'e yazamaz; reviewer, implementer sonucunu kendi kanıtıyla değerlendirir; kabul ölçütlerinin her biri bir kanıt kimliğine bağlanır.

## Faz 3 — Sağlayıcı çeşitliliği ve kontrollü yönlendirme

İkinci resmi provider adaptörü, capability probe, rol bazlı route, bütçe/usage, model değişikliği ve açık fallback kararı. Hiçbir sağlayıcının tüketici aboneliği veya kapalı kimlik doğrulama yolu varsayılmaz.

**Çıkış kapısı:** A sağlayıcısıyla implementasyon, B ile review mümkün; yok/bozuk provider sessiz modele düşmez; usage kaynak etiketiyle görünür.

## Faz 4 — İzolasyon ve güvenilirlik

Platform bazlı sandbox enforcement probe; worktree veya eşdeğer isolation; lease, process recovery, plugin güven sınırı, uzun görevler için gelişmiş compaction. Headless JSONL/RPC kararlılığı ve otomasyon senaryoları.

**Çıkış kapısı:** Symlink/junction, timeout, crash, çift resume ve izin uyuşmazlığı testleri geçer; `partial` sandbox koşulunda güçlü garanti vaadi verilmez.

## Sonraki ürünler

Daemon, web/desktop UI, remote runner, genel amaçlı plugin pazarı ve takım düzeyinde çok kullanıcılı yönetim bu fazların dışındadır. Kullanıcı gereksinimi ve yerel runtime verisi olmadan başlatılmaz.
