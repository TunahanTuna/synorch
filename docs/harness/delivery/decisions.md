# Açık kararlar ve ADR kuyruğu

> Statü: hiçbir madde onaylanmış teknik karar sayılmaz. Karar verirken prototip, tehdit testi, bakım maliyeti ve kullanıcı etkisi kaydedilmeli.

| ID | Karar | Önerilen başlangıç | Kapatmak için kanıt |
| --- | --- | --- | --- |
| ADR-01 | Runtime mevcut pakette mi ayrı workspace paketinde mi? | Aynı monorepoda ayrı runtime paketi | Canonical şema paylaşımı, npm dağıtımı ve eski `syn` komut uyumu |
| ADR-02 | Agent loop/plugin sınırı | Sabit küçük loop + provider/tool/storage interface'leri | İkinci implementasyon ihtiyacı ve test seam'leri |
| ADR-03 | Session depolama | Yerel SQLite/WAL adayı; JSONL alternatifi | Windows crash/locking, replay, migration ve okunabilirlik deneyi |
| ADR-04 | Terminal renderer | Node TUI kütüphanesi veya minimal ANSI | Windows/SSH/CI, screen reader, resize ve stream testi |
| ADR-05 | İlk provider ve resmi auth | Kullanıcının erişebildiği resmi API | SDK şartları, cancellation, usage ve streaming deneyi |
| ADR-06 | Sandbox tabanı | OS bazlı probe + fail-closed policy | Windows junction/hardlink, macOS/Linux test matrisi |
| ADR-07 | Worker izolasyonu | Yazabilen worker'a worktree; explorer read-only | Merge maliyeti, untracked dosyalar, Windows performansı |
| ADR-08 | Approval sıklığı | Plan digest + etki kapsamı; aynı onayı tekrar isteme | Mevcut “her görev onayı” kuralıyla uyum ve trivial iş UX testi |
| ADR-09 | Reviewer bağımsızlığı | Ayrı context ve sabit artifact; farklı model tercih | Maliyet ve bulgu kalitesi ölçümü |
| ADR-10 | Debugger yazma yetkisi | Varsayılan RCA-only | Gerçek hata giderme akışları ve role policy testi |
| ADR-11 | Başlangıç compaction | Tek özet yöntemi + kaynak aralığı | Replay ve uzun task kalite testi |
| ADR-12 | Plugin/extension dağıtımı | İlk sürümde yalnızca yerleşik adaptörler | Üçüncü taraf kod güvenliği ve sürüm uyumu |
| ADR-13 | MCP/ACP kapsamı | MCP tool client sonra, ACP host daha sonra | CLI kullanım talebi ve protokol uyumluluk testi |
| ADR-14 | Bütçe aşımı | Yeni istekleri durdur, aktif isteği politika ile bitir/iptal et | Sağlayıcı usage gecikmesi ve maliyet simülasyonu |
| ADR-15 | Headless approval | Varsayılan `unavailable → deny` | CI senaryosu ve makine API tasarımı |

## ADR şablonu

Her karar dosyasında şu alanlar bulunmalı: `Status`, `Date`, `Context`, `Decision`, `Alternatives`, `Consequences`, `Evidence`, `Verification`, `Revisit trigger`. Örnek karşılaştırma, tahmini performans yerine ölçülmüş veri içermeli. Yeni karar, eski tasarım metnindeki varsayımı değiştiriyorsa bağlantılı belgeler aynı değişiklikte güncellenmeli.

## Ürün sahibinden netleştirilecek tercihler

1. İlk kullanıcı: bireysel geliştirici mi, ekip/CI mı? İlk tasarım bireysel yerel CLI kabul ediyor.
2. İlk sağlayıcı/model erişim yolu ve bütçe beklentisi nedir? Resmi API varsayılacak; abonelik erişimi otomatik varsayılmayacak.
3. “Claude Code'daki sıkıntılar” arasında sizin için ilk üçü hangisi? [Claude Code incelemesindeki](../research/claude-code.md) sürtünme listesi şu an hipotezdir.
4. İlk sürümde her task planı için açık onay mı, yoksa daha önce yetkilendirilmiş kapsamda otomatik devam mı? Bu, bugünkü Synorch protokolüyle beraber çözülmeli.

Bu sorular uygulamadan önce ürün kararı gerektirir; araştırma belgelerinin yazılmasını durdurmaz.
