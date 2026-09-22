# ADR-11: Başlangıç compaction yöntemi

## Status

Accepted

## Date

2026-09-22

## Context

Compaction özeti kaynak olay aralığıyla saklanmalı, orijinal olaylar silinmemeli ve özet kanıt yerine geçmemelidir ([oturum ve bağlam](../design/session-and-context.md)). pi'nin tek yöntemli, `firstKeptEntryId`'li compaction'ı test edilebilir bir referanstır ([pi agent kalıpları](../research/tui/pi-agent-patterns.md) §7).

## Decision

- Tek yöntem: `summary-v1`.
- Tetikler: `threshold` (bağlam > pencere − 16k rezerv), `overflow` (provider `context_overflow`), `manual` (`/compact`).
- Son ~20k token korunur; öncesi yapılandırılmış biçimde özetlenir.
- `context/compacted` olayı `from_seq`, `to_seq`, `first_kept_seq`, `method`, `tokens_before/after`, `trigger` ve özet blob'unu taşır.
- Orijinal olaylar silinmez; özet asla kabul kanıtı değildir, kabul için test/artifact kaydına dönülür.
- Thrash: 3 step içinde ilerleme olmadan iki compaction → açık hata (`compaction-thrash`).
- Tek tool çıktısı bağlamı dolduruyorsa önce bounded output uygulanır.

## Alternatives

- **Birden çok strateji (kayan pencere, seçici budama):** v1 için test yüzeyini büyütür. Reddedildi.
- **Compaction yok, yalnız kesme:** Uzun görevlerde bağlam kaybı sessizleşir. Reddedildi.

## Consequences

- Replay, özetten sonra da deterministiktir: model girdisi `system + özet + first_kept_seq sonrası`dır.

## Evidence

- `src/harness/contracts/events.ts` (`context/compacted`), `runtime.ts` (`ContextBuildResult.reason: "compaction-thrash"`).
- Uzun görev kalite testi **yapılmadı**; I4'te ölçülecek.
- Sözleşme: [olaylar ve depolama](../contracts/events-and-storage.md).

## Verification

- `tests/harness-contracts.test.ts`: `context/compacted` örneği.
- I4: compaction sonrası envelope replay eşitliği, kabul kanıtının korunması, thrash hatası.

## Revisit trigger

Uzun görevlerde özet kaynaklı hata oranının yüksek çıkması veya provider tarafı compaction'ının (Claude köprüsü) çakışması.
