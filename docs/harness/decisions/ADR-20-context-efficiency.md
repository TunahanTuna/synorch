# ADR-20: Bağlam verimliliği — terminal araçta tur sonu, kararlı önek ve önbellek, rol başına kapsam

## Status

Accepted

## Date

2026-09-23

## Context

İkinci canlı çalıştırma 22 istekte toplam 140.978 girdi token'ı harcadı; tek istek yalnız 5,1k–8,1k token'dı (Denetim A §4). Maliyet tek bir büyük istemden değil, aynı öneki taşıyan çok sayıda istekten geliyordu:

- Her istekte değişmeyen ~4,6k token'lık önek (harness bloğu, anayasa, 8 protokol, rol, skill kataloğu, birincil skill, araç şemaları): ~100k token (%71). Önbellek okuması yalnız 22 isteğin 4'ünde oldu (20,5k token, %14,5), çünkü ChatGPT arka ucuna `prompt_cache_key` gönderilmiyordu (F16).
- Terminal kontrol aracından (`task_report`, kabul edilen `plan_propose`, `task_triage`) sonra driver bir tam model isteği daha gönderdi; model boş veya sohbet metni döndü: 4 istek, ~29,6k token (%21) (F11).
- Worker'lar orchestrator protokollerini de aldı (~3,6k karakter gereksiz); birincil skill sistem istemindeyken modeller `load_skill` ile tekrar yükledi, her yükleme bir adım ve geçmişte kalıcı metin (F12). Per-task adım bütçesi dispatch edilmeyen reviewer görevleri de sayılarak bölündü (F13).
- Paket boş dizileri, modelin ihtiyaç duymadığı kimlik/digest alanlarını ve delta notlarının kopyasını taşıdı (2,9 KB → 4,3 KB) (F19); read_paths dosyaları üç kez okundu (orchestrator, iki attempt).
- `read_file`/`exec` çıktıları 1 MB'a kadar geçmişe girip her adımda yeniden gönderilebiliyordu (F18).

## Decision

- **Terminal araçta tur sonu.** `ToolMetadata.ends_turn` (yalnız `control`): çağrı `succeeded` ve `status: ok` bitince gateway `ToolCallOutcome.endsTurn` döner, driver aynı batch'teki sonraki çağrıları çalıştırmaz (sentetik "turn ended by <tool>" sonucu) ve yeni model isteği göndermeden turu `completed` bitirir. `task_report`, `review_report`, `plan_propose` (yalnız kabul edilince `ok`), `task_triage` terminaldir. Reddedilen çağrı (düzeltme turu, ADR-18) turu bitirmez.
- **Kararlı önek ve prompt cache.** `ModelRequest.cache = {key, stable_system_blocks}`: `key` session + rol için sabittir; ilk `stable_system_blocks` sistem bloğu o session'ın her adımında bayt bayt aynıdır, değişken bloklar (paket, hafıza, compaction özeti) onlardan sonra gelir. OpenAI Responses adapter'ları `prompt_cache_key`, Anthropic Messages adapter'ı son kararlı bloktan ve araç listesinden sonra `cache_control` kırılma noktası gönderir. Alan modelin gördüğünü değiştirmez.
- **Rol başına protokol ve araç alt kümeleri.** ContextBuilder her role yalnız ilgili protokolleri verir (worker'a orkestrasyon/planlama/delegasyon/model yönlendirme protokolleri gitmez); harness, anayasa ve rol metni arasındaki tekrarlar kısaltılır. Araç listesi rol ve görev biçimine göre daraltılır; `task_report`/`plan_propose` şema açıklamaları kısaltılır; orchestrator'ın ilk mesajındaki plan JSON şablonu (zaten `plan_propose` şemasında) kaldırılır.
- **Skill'ler bir kez.** Birincil skill sisteme enjekte edilir; zaten bağlamda olan skill için `load_skill` "already in your context" döner ve içeriği tekrar etmez; aynı skill ikinci kez yüklenmez; triyaj turuna skill verilmez.
- **Kompakt paket ve satır içi kaynaklar.** Model görünümünde paket boş alanları, `expected_report` listesini ve modele gerekmeyen kimlik/digest alanlarını atar; delta notları `decisions`'a kopyalanmaz. Küçük read_paths dosyaları pakete `context.inline_sources` olarak satır içi girer (dosya başına ≤ 8 KiB, toplam ≤ 32 KiB, her biri aynı digest'le `sources`'ta).
- **Sınırlı araç çıktısı.** Modele gösterilen `read_file`/`exec` metni 32 KiB'la sınırlıdır (baş + son); tamamı blob'ta kalır ve "truncated; use offset/limit" notu eklenir.
- **Adım bütçesi.** Görev başı adım bütçesi yalnız dispatch edilen görevlere bölünür, alt sınır 25'tir; kontrol ve skill çağrıları adım sayılmaz.

## Alternatives

- **Önbelleği yalnız sağlayıcıya bırakmak:** ChatGPT arka ucu anahtar olmadan önbelleği nadiren eşledi (4/22). Reddedildi.
- **Terminal araçtan sonra modele son bir "özet" isteği:** Yeni bilgi getirmiyor, %21 maliyet. Reddedildi; özet rapor aracının içindedir.
- **Skill'leri tamamen isteğe bağlı yüklemek:** Birincil skill hemen her görevde gerekiyor; ek adım ve geçmiş metni maliyeti. Reddedildi; birincil enjekte, diğerleri isteğe bağlı ve tekilleştirilmiş.
- **Paket içeriğini tamamen satır içi vermek:** Büyük dosyalarda bağlam taşar ve freshness karmaşıklaşır. Reddedildi; boyut sınırlı ve digest'e bağlı.

## Consequences

- Aynı görev için beklenen maliyet ~12 istek × ~3,5k ≈ 40–45k token'dır ve çoğu önbellekten okunur (Denetim A §4 tahmini; W2'de ölçülecek).
- Sistem bloklarının sırası sözleşmedir: kararlı bloklar önce. Bir bloğu kararlı bölgeye koymak onun session boyunca değişmemesini gerektirir.
- Terminal araçtan sonra modelin eklemek istediği metin kaybolur; rapor aracının `summary` alanı bunun yeridir.

## Evidence

- Denetim A (`audit-a.md`): §4 bağlam boyutu tablosu (önek dağılımı, 141k'nın dağılımı, azaltma seçenekleri 1–8); F11, F12, F13, F16, F18, F19.
- Sözleşme: `src/harness/contracts/model.ts` (`promptCacheSchema`, `ModelRequest.cache`), `tools.ts` (`ToolMetadata.ends_turn`, `ToolCallOutcome.endsTurn`), `packets.ts` (`context.inline_sources`, `INLINE_SOURCE_MAX_BYTES`, `INLINE_SOURCES_MAX_TOTAL_BYTES`).
- Belgeler: [model-adapter §2](../contracts/model-adapter.md#2-modeladapter), [tools §2](../contracts/tools.md), [runtime-seams §7](../contracts/runtime-seams.md).

## Verification

- `tests/harness-contracts.test.ts`: `prompt-cache` örnekleri, `ends_turn`'ün yalnız kontrol araçta geçerli olması, satır içi kaynağın `sources`'ta olması ve boyut sınırı.
- W1d kabul ölçütleri ([uygulama planı §7](../implementation-plan.md#7-canlı-çalıştırma-sağlamlaştırma-dalgası)); W2 replay'inde istek sayısı ve girdi token'ı ölçümü.

## Revisit trigger

Önbellek okuma oranının kararlı önekle bile %50'nin altında kalması; rol başına protokol kesintisinin görev kalitesini düşürdüğüne dair review bulguları; satır içi kaynakların paket boyutunu anlamlı biçimde büyütmesi.
