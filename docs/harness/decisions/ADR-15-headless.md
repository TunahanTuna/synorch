# ADR-15: Headless çalışma ve onay

## Status

Accepted

## Date

2026-09-22

## Context

Önceki öneri headless onay için `unavailable → deny` idi ([açık kararlar](../delivery/decisions.md)). ADR-08 ile varsayılan mod otonom oldu; headless run'ların da otonom çalışması, ancak dış etkili eylemlerin policy'ye bağlı kalması gerekir. Makine modu sürümlü JSONL ve kesin exit code'lar ister ([CLI deneyimi](../design/cli-experience.md)).

## Decision

- Headless run'lar da varsayılan olarak `autonomous` moddadır.
- Headless `ApprovalBroker` her soruya `unavailable` yanıtı verir (`decided_by: broker`); bu, insan gerektiren her şeyi reddeder: `ask` modu prompt'ları ve insan-only konular (`provider-change`, `budget`). Sonuç exit code 3'tür.
- Dış etkiler policy'ye bağlıdır: `external-write` yalnız allowlist ile.
- Makine çıktısı [CLI ve JSONL sözleşmesindeki](../contracts/cli-and-jsonl.md) frame'lerle: ilk `hello`, son tek `result` veya `error`; stdout yalnız JSONL.
- Exit code'lar (`EXIT_CODES`): `0` başarı, `1` iç hata, `2` kullanım, `3` onay, `4` provider/tool, `5` doğrulama/review, `6` policy, `7` auth, `8` oturum kilitli, `9` bütçe, `130` iptal.
- Stdin üzerinden onay/steer (RPC modu) v1 kapsamı dışıdır.

## Alternatives

- **Headless'ta her şeyi reddetmek:** Otonom kararla çelişir; CI kullanımını engeller. Reddedildi.
- **Headless'ta stdin ile onay:** JSONL ile RPC'yi karıştırır. Ayrı mod olarak ertelendi.

## Consequences

- CI senaryoları exit code ile dallanabilir; `ask` modunda headless run kasıtlı olarak onay adımında 3 ile biter.

## Evidence

- `src/harness/contracts/errors.ts` (`EXIT_CODES`, `HARNESS_ERROR_EXIT`), `jsonl.ts` (`jsonlFrameSchema`, `validateFrameSequence`), `policy.ts` (broker refinement'ları).
- [pi agent kalıpları](../research/tui/pi-agent-patterns.md) §9 (LF-only framing, stdout koruması).

## Verification

- `tests/harness-contracts.test.ts`: frame örnekleri, dizi invariant'ları, broker'ın izin verememesi, exit code eşlemesinin tamlığı.
- I5: `syn run --mode jsonl` uçtan uca; pipe'a yazma, stdout'a insan metni sızmaması, onay bekleme senaryosunda exit 3.

## Revisit trigger

CI kullanıcılarının stdin RPC veya uzaktan onay ihtiyacı bildirmesi.
