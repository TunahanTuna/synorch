# ADR-14: Bütçe aşımı

## Status

Accepted

## Date

2026-09-22

## Context

Bütçe aşıldığında yeni çağrı başlatılmamalı, aktif çağrının davranışı açık politikayla belirlenmelidir; token, USD tahmini ve abonelik kotası aynı alan gibi gösterilmemelidir ([sağlayıcılar ve yapılandırma](../design/providers-and-configuration.md), [çok sağlayıcılı vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md) §17).

## Decision

- Her model isteğinden önce kalan run/task bütçesi kontrol edilir.
- Limite ulaşılınca yeni istek başlatılmaz (`budget/exceeded`, `action: stop-new-requests`); aktif istek bitebilir.
- Limitin %120'si veya wall-time sınırı aşılırsa aktif istek iptal edilir (`action: cancel-active`).
- Bütçe artırımı yalnızca insan onayıyla (`budget` insan-only konu, [ADR-08](./ADR-08-approval-policy.md)).
- Usage kaynağı etiketlidir: `provider-reported`, `adapter-estimated`, `unknown`. Abonelik kotası (`QuotaSnapshot`) token ve USD'den ayrı gösterilir.

## Alternatives

- **Aktif isteği limit anında kesmek:** Usage gecikmesi nedeniyle yanlış pozitif; yarım çıktı. %120 toleransı seçildi.
- **Yalnız uyarı:** Bütçe anlamsızlaşır. Reddedildi.

## Consequences

- Abonelik kullanımında USD tahmini fatura değildir; UI bunu belirtir.
- Headless run bütçe aşımında exit code 9 ile biter.

## Evidence

- `src/harness/contracts/events.ts` (`budget/exceeded`), `model.ts` (`usageSchema`, `quotaSnapshotSchema`), `errors.ts` (`budget_exceeded` → exit 9).
- Maliyet simülasyonu **yapılmadı**; I1/I2'de fixture ile.

## Verification

- `tests/harness-contracts.test.ts`: `budget/exceeded` örneği, exit code eşlemesi.
- I1: limit anında yeni isteğin başlamaması, %120'de iptal, usage kaynağı etiketinin korunması.

## Revisit trigger

Provider usage raporlarının gecikmesinin %120 toleransını yetersiz kılması; ekip bütçesi gereksinimi.
