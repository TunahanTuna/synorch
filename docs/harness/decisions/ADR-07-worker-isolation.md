# ADR-07: Worker izolasyonu

## Status

Accepted. Kısmen değiştirildi: [ADR-19](./ADR-19-workspace-fidelity.md) (2026-09-23). Aşağıdaki karar maddeleri geçerlidir; ADR-19 şunları ekler veya değiştirir:

- Worktree oluşturma başarısız olursa `high-risk` olmayan görev kayıtlı bir yedekle (`fallback.reason`) `scoped-dir`'e düşer; `core.longpaths` açıktır; öksüz worktree/owner dosyası kalmaz.
- Aynı görevin retry/onarım/revizyon attempt'leri çalışma alanını sıfırlayarak yeniden kullanır (`IsolationCreateOptions.reuse`); çalışma alanı görev sonuçlanınca atılır.
- Ana ağaçta kirli/izlenmeyen okuma girdileri worktree'ye overlay edilir; ignore edilen bağımlılık dizinleri salt okunur bağlanır; submodule içi owned path reddedilir.
- Integrate çakışmayı ham baytla değil `ContentIdentity` (filtreli git blob kimliği) ile saptar ve içeriği ana ağacın EOL/filtre gösterimine çevirir.
- Paket kaynak digest'leri izolasyondan sonra attempt çalışma alanında `workspaceDigest` ile hesaplanır.
- "Kullanıcının commit edilmemiş değişiklikleri `owned_paths` ile çakışıyorsa `scoped-dir`" kuralı değişmedi.

## Date

2026-09-22

## Context

Aynı path'e iki implementer eşzamanlı yazmamalı; yazabilen worker'ın etkin kapsamı packet `owned_paths`, onay ve sandbox'ın kesişimidir ([runtime mimarisi](../design/runtime-architecture.md), [orkestrasyon sözleşmeleri](../design/orchestration-contracts.md)). Worktree maliyeti, untracked dosyalar ve Windows performansı değerlendirilmeliydi ([açık kararlar](../delivery/decisions.md)).

## Decision

- Çalışma alanı git deposuysa yazabilen her attempt için `~/.synorch/worktrees/<project-id>/<attempt-id>` altında git worktree açılır; taban `HEAD`'dir.
- Kullanıcının commit edilmemiş değişiklikleri `owned_paths` ile çakışıyorsa veya çalışma alanı git değilse `scoped-dir` kullanılır: yazma yerinde ama yalnız `owned_paths` içinde, her yazmadan önce önceki içerik blob olarak saklanır.
- Explorer ve reviewer `shared-read-only` çalışır.
- `high-risk` yazan görevler `worktree` zorunludur (packet şeması uygular).
- Kabul edilmiş artifact'ın ana çalışma alanına uygulanması açık ve kayıtlı bir orchestrator adımıdır (`IsolationProvider.integrate`, beklenen artifact digest'iyle).
- Plan şeması, bağımlılıkla sıralanmamış iki görevin çakışan `owned_paths` taşımasını reddeder.

## Alternatives

- **Her attempt için worktree (git dışı dahil):** Git olmayan çalışma alanında mümkün değil. Reddedildi.
- **Tamamen paylaşılan çalışma alanı + kilit:** Kullanıcı değişikliklerini ve geri alma yolunu korumaz. Reddedildi.
- **Tam kopya dizin:** Büyük depolarda maliyetli. Reddedildi.

## Consequences

- Worktree'de bağımlılık kurulumu (ör. `node_modules`) tekrar gerekebilir; maliyet ölçülecek.
- Birleştirme çakışması orchestrator'a yükselir; worker başka worker'ın değişikliğini geri alamaz.

## Evidence

- `src/harness/contracts/runtime.ts` (`IsolationProvider`, `IsolatedWorkspace`), `packets.ts` (`isolation` refinement'ları, plan paralel sahiplik denetimi), `paths.ts` (`pathPatternsOverlap`).
- Windows worktree performansı **ölçülmedi**; I4'te ölçülecek.
- Sözleşme: [task packet'leri](../contracts/task-packets.md).

## Verification

- `tests/harness-contracts.test.ts`: paralel çakışan sahiplik, `high-risk` + `scoped-dir` reddi, read-only rolün sahiplik reddi.
- I4: iki çakışan görevin seri yürütülmesi, worktree oluşturma/temizleme, untracked dosya koruması, integrate'in yanlış digest'le reddi.

## Revisit trigger

Worktree kurulum süresinin kabul edilemez olması, monorepo'larda sparse checkout ihtiyacı, git dışı VCS talebi.
