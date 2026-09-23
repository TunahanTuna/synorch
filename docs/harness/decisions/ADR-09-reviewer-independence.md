# ADR-09: Reviewer bağımsızlığı

## Status

Accepted. Kısmen değiştirildi: [ADR-18](./ADR-18-harness-computed-evidence.md) (2026-09-23; bağımsız inceleme R1 ile daraltıldı). Değişen madde: her `met` hükmü reviewer'ın kendi ürettiği **veya o ölçütü kanıtlayan, `passed` bir harness doğrulama çalıştırmasına** (`kind: harness-verification`: build/test sınıfı bir komut ya da ölçütün aynen andığı komut; salt okunur komutlar asla) dayanır. Sabitlenmiş diff (`harness-diff`) yalnız destekleyicidir, tek başına asla yetmez: bir değişikliğin var olduğunu gösterir, incelenen şeyin kendisidir. Worker kanıtı tek başına yine yetmez. Reviewer işaretçileri toleranslı çözülür, tek düzeltme turu vardır; düzeltmeden sonra çözülmeyen işaretçi review'ü `invalid` yapmaz, bağımsız kanıtı kalmayan `met` `unverifiable` sayılır ve sonuç `revise` geri bildirimidir. Diğer maddeler geçerlidir.

K1.6-P2 değişikliği (2026-09-24, canlı run 01M381W6): reviewer (ve explorer) tüm çalışma alanını salt okunur okur (`.git`, `.synorch`, env dosyaları hariç); harness doğrulaması geçmiş bir görevde `revise` veya `block` bulgularla bir düzeltme turudur, `review_revisions` bütçesi bitince orchestrator notlarla kabul edebilir (blocker bulgu yoksa), yeniden deneyebilir veya düşürebilir; okuma kapsamı yüzünden `unverifiable` hükmü bir kez yeniden gönderilir. Çok bağımlılıklı reviewer görevi, görev review'lerine kriter eklemek yerine birleşik sonuç üzerinde ayrı bir entegrasyon review'ü olarak koşar ([task packet'leri](../contracts/task-packets.md) §1, §6).

## Date

2026-09-22

## Context

Bir modelin "bitti" demesi teslim için yeterli değildir; reviewer implementer sonucunu kendi kanıtıyla değerlendirmelidir ([orkestrasyon sözleşmeleri](../design/orchestration-contracts.md), [karşılaştırma](../research/comparison.md)). "Tainted reviewer" tehdidi ayrı context ve sabit artifact gerektirir ([araçlar ve güvenlik](../design/tools-and-security.md)).

## Decision

- Reviewer ayrı bir attempt ve ayrı context'te çalışır; girdisi taze bir packet'tir: sabitlenmiş artifact digest'i, completion packet'i ve kabul ölçütleri. Implementer transkripti asla verilmez.
- Review packet'inde `independence.separate_context` her zaman `true`'dur; bir attempt kendini inceleyemez.
- Her `met` kararı bağımsız en az bir kanıta dayanır: reviewer'ın kendi ürettiği kanıt (`produced_by: reviewer`; reviewer'ın kendi araç okumaları dahil) veya — ADR-18 ile — o ölçütü kanıtlayan `passed` bir harness doğrulama çalıştırması (`verificationProves`). `harness-diff` yalnız destekleyicidir. `verification.commands` boş olan standard/high-risk görevde reviewer kanıtı kendisi üretir; yalnız diff'e dayanan `met` → `unverifiable` → `revise`. `accept` tüm ölçütler `met` ve blocker bulgu yokken mümkündür (şema tür düzeyinde, orchestration çalıştırma sonucuyla uygular).
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

- `tests/harness-contracts.test.ts`: yalnız worker kanıtlı `met` reddi, yalnız `harness-diff` kanıtlı `met` reddi (belge örneği), `not_met` ile `accept` reddi, blocker ile `accept` reddi, self-review reddi, `separate_context: false` reddi.
- `tests/harness-orchestration-review.test.ts` (review R1): doğrulama komutu olmayan standard görevde yalnız diff'e dayanan reviewer `revise` alır, hiçbir şey integrate edilmez; `verifyReview` reviewer kanıtını ve `passed` build/test çalıştırmasını bağımsız sayar, salt okunur veya başarısız çalıştırmayı ve diff'i saymaz.
- `tests/harness-e2e-integration-review.test.ts` (K1.6-P2 replay): görevler arası kriter entegrasyon review'üne taşınır, reviewer paketleri `**` okur, kapsam kaynaklı hüküm bir kez yeniden gönderilir, `block` düzeltme turudur, entegrasyon review'ü üç görev entegre edildikten sonra ana çalışma alanında koşar.
- I4: reviewer'a implementer transkriptinin geçmediğini gösteren context testi; standard görevin review olmadan `completed` olamaması.

## Revisit trigger

Reviewer'ın yakaladığı bulgu oranının çok düşük veya maliyetin orantısız çıkması.
