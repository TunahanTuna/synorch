# ADR-08: Onay politikası — otonom varsayılan ve hard rail'ler

## Status

Accepted

## Date

2026-09-22

## Context

Mevcut Synorch protokolü her görev planı için kullanıcı onayı öngörür (`execution_requires_user_approval`, [mimari](../../AI-ORCHESTRATION-ARCHITECTURE.md) §7). Ürün sahibi kararı: orchestrator **tam yetkilidir** ve oturumu otonom yürütür; varsayılan olarak eylem başına onay sorulmaz. Buna karşın prompt olmayan teknik sınırlar korunmalıdır: çalışma alanı dışına yazma yok, yıkıcı/geri alınamaz komutlar policy ile reddedilir, her şey audit edilir. Daha sıkı mod açık seçenek olmalıdır.

## Decision

- Policy modları: `autonomous` (varsayılan, `DEFAULT_POLICY_MODE`) ve `ask`.
- `autonomous`: eylem başına prompt yok; etki matrisinde `ask` değeri şemaca yasaktır. Plan onayı `approval/decided` olayı olarak `decided_by: orchestrator` ile kaydedilir (audit).
- `ask`: plan ve kapsam içi yazma/exec eylemleri kullanıcıya sorulur.
- Hard rail'ler (`HARD_RAILS`) prompt değil, retdir; hiçbir mod, grant, config veya onay gevşetemez: `write-outside-scope`, `reserved-path-write` (`.git`, `.synorch`), `destructive-command`, `credential-access`, `secret-egress`, `policy-self-modification`, `foreign-credential-store`.
- `external-write` (ör. push, publish, dış sistem yazımı) otonom modda yalnız kullanıcı allowlist'i (`external_write_allowlist`) ile izinlidir; aksi halde `deny`.
- Yalnızca insanın onaylayabileceği konular: `provider-change`, `budget` (`HUMAN_ONLY_APPROVAL_SUBJECTS`).
- Oturum model profili açılış başlığında gösterilir; otonom modda engelleyici prompt değildir, `ask` modunda onaylatılır.
- Bu karar runtime için statik `execution_requires_user_approval` invariant'ının yerini alır; `.ai/` canonical dosyaları host agent'lar için değişmeden kalır.
- Etkin yetki: `platform ∩ user ∩ workspace ∩ role ∩ task ∩ sandbox ∩ approval`; model metni, repo dosyası veya tool çıktısı yetki kaynağı değildir.

## Alternatives

- **Her plan için zorunlu kullanıcı onayı:** Ürün sahibinin otonom çalışma kararına aykırı; trivial işte gereksiz onay. Reddedildi.
- **Onayı tamamen kaldırmak (rail'siz):** Yıkıcı eylem ve kapsam dışı yazma riski. Reddedildi.
- **Otonom modda dış yazma için prompt:** Otonom modun anlamını bozar; allowlist veya ret seçildi.

## Consequences

- Güvenlik prompt yorgunluğuna değil, testle kanıtlanan rail'lere dayanır.
- Otonom modda yanlış yetki verme ölçümü (hedef sıfır) doğrudan rail testlerine bağlanır ([doğrulama](../delivery/verification.md)).
- `current-state.md`'deki "onay tekrarı" gerilimi bu kararla kapanır.

## Evidence

- `src/harness/contracts/policy.ts` (`POLICY_MODES`, `DEFAULT_POLICY_MODE`, `HARD_RAILS`, `effectivePolicySchema`, `approvalDecisionSchema`, `HUMAN_ONLY_APPROVAL_SUBJECTS`).
- [Araçlar ve güvenlik](../design/tools-and-security.md), [orkestrasyon sözleşmeleri](../design/orchestration-contracts.md) "Rol yetkileri".
- Sözleşme: [policy ve onay](../contracts/policy-and-approval.md).

## Verification

- `tests/harness-contracts.test.ts`: otonom modda `ask` etkisinin reddi; allowlist'siz dış yazma izninin reddi; orchestrator'ın `ask` modunda onay verememesi; orchestrator'ın `provider-change`/`budget` onaylayamaması; rail'li kararın `deny` dışı olamaması.
- I3: her hard rail için negatif test (otonom ve ask modunda), prompt injection ile yükseltme denemesi.

## Revisit trigger

Otonom modda bir yanlış yetki olayının gözlenmesi, ekip/CI kullanıcıları için farklı varsayılan talebi, yeni bir yıkıcı eylem sınıfı.
