# ADR-06: Sandbox tabanı

## Status

Accepted

## Date

2026-09-22

## Context

Policy, approval ve sandbox ayrı kavramlardır; approval paterni process sandbox yerine geçmez ([araçlar ve güvenlik](../design/tools-and-security.md), [karşılaştırma](../research/comparison.md)). Platformlar arasında gerçek OS enforcement farklıdır; `partial` koruma açıkça raporlanmalıdır.

## Decision

- v1 enforcement'ın birinci katmanı `ToolGateway` içindeki policy uygulamasıdır: eylem anında lexical normalize + `realpath`/junction/symlink çözümü, argv tabanlı yıkıcı komut sınıflandırması, cwd'nin çalışma alanına hapsedilmesi, env temizliği, çıktı üst sınırları, timeout ve iptal.
- İkinci katman OS backend'idir; `SandboxRunner.probe()` sonucu `full | partial | unavailable` raporlar:
  - Linux: `bubblewrap` varsa kullanılır.
  - macOS: `sandbox-exec` varsa kullanılır.
  - Windows: v1'de `partial` (job object/AppContainer sonraki sürüm).
- `partial` durumu TUI başlığında, JSONL `tool/execution_started.sandbox_enforcement` alanında ve `doctor --runtime` çıktısında görünür.
- `require_full_sandbox` işaretli görev, enforcement `full` değilse `workspace-write` ve `exec` etkileri `deny` alır ve durur.
- Probe hatası fail-closed davranır: backend `unavailable` sayılır.

## Alternatives

- **Yalnız policy (OS backend yok):** Shell ile kapsam dışı yazma engellenemez. Reddedildi.
- **Her platformda tam OS sandbox şartı:** Windows v1'de karşılanamaz; ürünü Windows'ta kullanılamaz kılar. Reddedildi; açık `partial` raporuyla ilerlenir.
- **Container/VM:** Ağır, yerel CLI deneyimine uygun değil. Sonraki aşamaya bırakıldı.

## Consequences

- Güvenlik iddiası pazarlama cümlesi değil, platform bazlı raporlanmış invariant'tır.
- Windows kullanıcıları yüksek riskli ve `require_full_sandbox` görevlerde durur; bu açıkça söylenir.

## Evidence

- `src/harness/contracts/tools.ts` (`SandboxRunner`, `sandboxReportSchema`, `SANDBOX_ENFORCEMENT`), `policy.ts` (`require_full_sandbox` refinement'ı, `HARD_RAILS`).
- Platform deneyleri (junction, hard link, TOCTOU) **henüz yapılmadı**; I3 kabul ölçütüdür.
- Sözleşme: [araçlar](../contracts/tools.md), [policy ve onay](../contracts/policy-and-approval.md).

## Verification

- `tests/harness-contracts.test.ts`: `require_full_sandbox` + `partial` altında yazma/exec izinli policy'nin reddi.
- I3: symlink/junction kaçışı, `..`, mutlak yol, büyük/küçük harf farkı, hard link, yarış senaryoları; read-only rolün shell üzerinden yazamaması; probe hatasında `unavailable`.

## Revisit trigger

Windows'ta güvenilir bir OS backend'inin (AppContainer, job object + ACL) prototiplenmesi; bubblewrap/sandbox-exec'in kullanımdan kalkması.
