# ADR-03: Oturum deposu — segmentli append-only JSONL

## Status

Accepted

## Date

2026-09-22

## Context

Session'ın kalıcı aslı tipli, sıralı, append-only olay günlüğüdür; SQLite/WAL ile segmentli JSONL arasındaki seçim açıktı ([oturum ve bağlam](../design/session-and-context.md)). Gereksinimler: tek yazıcı, crash sonrası deterministik replay, Windows kilitleme davranışı, insan tarafından incelenebilirlik, büyük tool çıktılarının ayrı tutulması. pi/OMP JSONL kullanıyor ([pi agent kalıpları](../research/tui/pi-agent-patterns.md) §6).

## Decision

- Kök: `~/.synorch/` (veya `$SYNORCH_HOME`). Yerleşim:
  - `sessions/<project-id>/<session-id>/session.json` — oluşturulurken bir kez yazılan manifest.
  - `sessions/<project-id>/<session-id>/lock.json` — tek yazıcı lease'i; TTL 30 s, heartbeat 10 s.
  - `sessions/<project-id>/<session-id>/segments/000001.jsonl` — ilk satır segment header'ı, sonraki her satır bir event envelope'u; 8 MiB'da yeni segment.
  - `blobs/sha256/<2 hex>/<62 hex>` — içerik adresli blob deposu.
- Satır içi payload üst sınırı 16 KiB; daha büyüğü blob'a yazılır ve `BlobRef` ile referanslanır.
- `seq` oturum başına yoğun ve kesin artandır; sıra kaynağı saat değil `seq`'tir.
- `EventStore.append` satır diske flush (fsync) edildikten sonra resolve olur; append başarısızsa yeni yan etkili tool çağrısı başlatılmaz.
- Son satırın yarım kalması `torn-tail` olarak saptanır; bilinmeyen `type` veya daha yeni `event_version` `unsupported` döner, sessizce atlanmaz.
- İkinci process yazma için açarsa `session_locked` hatası lease sahibini adıyla bildirir.

## Alternatives

- **SQLite/WAL (`node:sqlite` veya native modül):** `node:sqlite` Node 24'te hâlâ gelişim aşamasında; native modül prebuild ve lisans yükü getirir; dosya daha az incelenebilir; Windows'ta kilit/antivirüs etkileşimi riski. Reddedildi.
- **Tek JSONL dosyası:** Uzun oturumlarda büyüme, rotasyon ve kısmi okuma zorluğu. Reddedildi.

## Consequences

- Oturum dosyaları `cat`/`jq` ile incelenebilir; `syn show` ve replay aynı okuyucuyu kullanır.
- Projection'lar (görev tablosu, sohbet geçmişi) her açılışta log'dan hesaplanır; gerekirse ileride snapshot eklenir.
- Blob çöp toplama `syn delete-session` tasarımına bırakılır ([audit ve işletim](../design/audit-and-operations.md)).

## Evidence

- `src/harness/contracts/store.ts` (`SEGMENT_MAX_BYTES`, `INLINE_PAYLOAD_MAX_BYTES`, `LEASE_TTL_MS`, `LEASE_HEARTBEAT_MS`, `sessionManifestSchema`, `segmentHeaderSchema`, `sessionLeaseSchema`), `events.ts` (`parseSessionEvent`).
- Windows crash/kilitleme deneyi **henüz yapılmadı**; I1 kabul ölçütüdür.
- Ayrıntı: [olaylar ve depolama sözleşmesi](../contracts/events-and-storage.md).

## Verification

- `tests/harness-contracts.test.ts`: envelope şeması, bilinmeyen tip/sürüm → `unsupported`.
- I1: yarım satır, fsync sonrası kill, iki process'in aynı oturumu açması, segment rotasyonu, bozuk blob digest'i testleri Windows/macOS/Linux'ta.

## Revisit trigger

Replay süresinin 100k olayda kabul edilemez olması, sorgu ihtiyacının (çapraz oturum arama) projection ile karşılanamaması veya Windows'ta fsync/rename güvenilirlik sorunu.
