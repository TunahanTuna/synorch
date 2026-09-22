# ADR-10: Debugger yazma yetkisi

## Status

Accepted

## Date

2026-09-22

## Context

Debugger rolü RCA yapar; "izin verilirse sınırlı düzeltme" yapabilir ve yazma modu task'ta ayrıca belirtilmelidir ([orkestrasyon sözleşmeleri](../design/orchestration-contracts.md) "Rol yetkileri").

## Decision

- Debugger packet'lerinin varsayılanı `write_mode: rca-only`'dir; `owned_paths` boştur.
- Yazma yalnızca plan görevi açıkça `owned_paths` verdiğinde mümkündür; packet `write_mode: owned-paths` taşır ve diğer yazan rollerle aynı izolasyon kurallarına uyar.
- `rca-only` yalnız debugger için geçerlidir; completion packet'inde `root_cause` beklenir.

## Alternatives

- **Debugger'a varsayılan yazma yetkisi:** Teşhis ile düzeltmeyi karıştırır, review zincirini atlatabilir. Reddedildi.
- **Debugger'ın hiç yazamaması:** Küçük, iyi anlaşılmış düzeltmeler için gereksiz ek görev. Reddedildi.

## Consequences

- Düzeltme gerektiren RCA genellikle implementer görevine dönüşür; bu, plan sürümünde görünür olur.

## Evidence

- `src/harness/contracts/packets.ts` (`write_mode` refinement'ları).
- Sözleşme: [task packet'leri](../contracts/task-packets.md).

## Verification

- `tests/harness-contracts.test.ts`: `owned_paths` ile `rca-only` çelişkisinin ve debugger dışı `rca-only`'nin reddi.
- I4: `rca-only` debugger'ın yazma aracının policy tarafından reddedilmesi.

## Revisit trigger

Gerçek hata giderme akışlarında debugger→implementer devrinin ölçülebilir gecikme yaratması.
