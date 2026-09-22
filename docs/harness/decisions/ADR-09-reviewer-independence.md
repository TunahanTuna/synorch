# ADR-09: Reviewer bağımsızlığı

## Status

Accepted

## Date

2026-09-22

## Context

Bir modelin "bitti" demesi teslim için yeterli değildir; reviewer implementer sonucunu kendi kanıtıyla değerlendirmelidir ([orkestrasyon sözleşmeleri](../design/orchestration-contracts.md), [karşılaştırma](../research/comparison.md)). "Tainted reviewer" tehdidi ayrı context ve sabit artifact gerektirir ([araçlar ve güvenlik](../design/tools-and-security.md)).

## Decision

- Reviewer ayrı bir attempt ve ayrı context'te çalışır; girdisi taze bir packet'tir: sabitlenmiş artifact digest'i, completion packet'i ve kabul ölçütleri. Implementer transkripti asla verilmez.
- Review packet'inde `independence.separate_context` her zaman `true`'dur; bir attempt kendini inceleyemez.
- Her `met` kararı reviewer'ın kendi ürettiği en az bir kanıta (`produced_by: reviewer`) dayanır; `accept` tüm ölçütler `met` ve blocker bulgu yokken mümkündür (şema uygular).
- Router mümkünse farklı model/provider tercih eder; aynıysa `same_provider`/`same_model` kaydedilir.
- `standard` ve `high-risk` görevlerde review zorunlu; `trivial` görevlerde isteğe bağlıdır.

## Alternatives

- **Implementer'ın kendi testlerini kabul etmek:** Bağımsız doğrulama ilkesine aykırı. Reddedildi.
- **Farklı provider zorunluluğu:** Tek provider'lı kullanıcıyı engeller; kalite garantisi de değil. Tercih olarak tutuldu.

## Consequences

- Review maliyeti risk sınıfına orantılıdır; trivial işte gereksiz review yok.
- Kanıtsız kabul şema düzeyinde imkânsızdır.

## Evidence

- `src/harness/contracts/packets.ts` (`reviewPacketSchema` refinement'ları, `completionPacketSchema` reviewer kanıtı yasağı).
- Maliyet ve bulgu kalitesi ölçümü **yok**; I4 sonrası ölçülecek.
- Sözleşme: [task packet'leri](../contracts/task-packets.md).

## Verification

- `tests/harness-contracts.test.ts`: yalnız worker kanıtlı `met` reddi, `not_met` ile `accept` reddi, blocker ile `accept` reddi, self-review reddi, `separate_context: false` reddi.
- I4: reviewer'a implementer transkriptinin geçmediğini gösteren context testi; standard görevin review olmadan `completed` olamaması.

## Revisit trigger

Reviewer'ın yakaladığı bulgu oranının çok düşük veya maliyetin orantısız çıkması.
