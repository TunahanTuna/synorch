# ADR-17: Hafıza yazma politikası ve review kuyruğu

## Status

Accepted

## Date

2026-09-22

## Context

Hangi bilgi türlerinin kullanıcı onayı olmadan kalıcı hale gelebileceği açıktı ([Obsidian ile yerel hafıza](../obsidian/README.md) §10). Otomatik ilişki ve çelişki çıkarımı kanıt ve değerlendirme olmadan gerçek kabul edilmemelidir. ADR-08 ile orchestrator otonom modda tam yetkilidir.

## Decision

- Review olmadan yazılan türler (`AUTO_PERSIST_KINDS`): `evidence`, `concept`, `assumption`, `question`. Bu türlerin durumları yapısı gereği yetkili değildir (`assumption` `open`, `question` `open` vb.).
- Review kuyruğuna giden türler (`REVIEW_REQUIRED_KINDS`): `decision`, `preference`; ayrıca `contradiction` ve `relation` önerileri.
- Orchestrator otonom modda kuyruk öğelerini kabul edebilir; bu `memory/proposal_decided` olayında `decided_by: orchestrator` ve karar veren `run_id` ile audit edilir. Kullanıcı kararı geri alabilir.
- Synorch'un yazdığı yetkili `decision`/`preference` notu, kabul eden review'ı `reviewed_at` ile kaydetmek zorundadır (şema uygular).
- Her öneri en az bir kanıt referansı taşır.
- Semantik katman (embedding/benzerlik) ve Obsidian eklentisi v1 dışıdır.

## Alternatives

- **Her yazma için insan onayı:** Otonom kararla çelişir, kuyruk birikir. Reddedildi.
- **Her şeyi otomatik yazmak:** Yanlış karar/tercih kalıcılaşır. Reddedildi.

## Consequences

- Görev sonunda kullanıcı hafıza değişikliklerinin farkını ve kimin kabul ettiğini görebilir.
- Yanlış çelişki önerisi reddedilince karar notları değişmez.

## Evidence

- `src/harness/contracts/memory.ts` (`AUTO_PERSIST_KINDS`, `REVIEW_REQUIRED_KINDS`, `memoryNoteFrontmatterSchema`, `memoryProposalSchema`), `events.ts` (`memory/*`).
- [Obsidian ile yerel hafıza](../obsidian/README.md) §6, §7.2.
- Sözleşme: [hafıza](../contracts/memory.md).

## Verification

- `tests/harness-contracts.test.ts`: `reviewed_at`'sız yetkili Synorch kararının reddi, `run_id`'siz orchestrator kararının reddi, yanlış ilişki tipli çelişki önerisinin reddi.
- I6: `MemoryStore.persist`'in review gerektiren türleri reddetmesi; kabul/geri alma akışı; sır içeren tool çıktısının vault'a yazılmaması.

## Revisit trigger

Orchestrator kabullerinde kullanıcı geri alma oranının yüksek çıkması; semantik katmanın ölçülebilir fayda göstermesi.
