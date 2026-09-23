# Plan ve görev paketleri

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/packets.ts`; uygulama: `src/harness/orchestration/`, `src/harness/context/` (I4). Kararlar: [ADR-07](../decisions/ADR-07-worker-isolation.md), [ADR-09](../decisions/ADR-09-reviewer-independence.md), [ADR-10](../decisions/ADR-10-debugger-write.md), [ADR-18](../decisions/ADR-18-harness-computed-evidence.md), [ADR-19](../decisions/ADR-19-workspace-fidelity.md), [ADR-20](../decisions/ADR-20-context-efficiency.md). Kaynak: [mevcut Synorch bağlam aktarımı](../../AI-ORCHESTRATION-ARCHITECTURE.md) §11.

Orchestrator ile worker'lar arasındaki tek dil bu paketlerdir. Ham ebeveyn transkripti worker'a devredilmez. Her paket `digestOf` ile özetlenir; event'ler, onaylar ve freshness kontrolü bu digest'e bağlanır. Paketler blob olarak saklanır, event yalnız digest + `BlobRef` taşır.

## 1. Plan

Alanlar: `schema_version: 1`, `plan_id`, `run_id`, `version`, `goal`, `risk`, `scope[]`, `tasks[]`, `expected_external_effects[]`, `verification[]`, `budget{max_wall_time_seconds, max_steps, max_cost_usd?}`, `assumptions[]`, `created_at`. Görev: `key` (kebab), `role` (worker rolü), `objective`, `depends_on[]` (key), `owned_paths[]`, `read_paths[]`, `risk`, `model_tier`, `acceptance_criteria[]{id: AC-n, statement}`, `verification[]`.

Şema kuralları:

- Task key'leri benzersiz; bağımlılıklar mevcut; DAG çevrimsiz (çevrim mesajda gösterilir).
- Explorer/reviewer path sahibi olamaz; tüm workspace (`**`, `.`) veya `.git`/`.synorch` sahiplenilemez.
- **Paralel yazım yasağı:** aralarında (geçişli) bağımlılık olmayan iki görevin `owned_paths`'leri kesişemez. Kesişim testi muhafazakârdır (`pathPatternsOverlap`, büyük/küçük harf duyarsız): şüphede sıralama zorunlu kılınır.
- Onay `planDigest(plan)`'a bağlanır. Kapsam/risk artışı yeni `version` ve yeni onay gerektirir; eski onay `invalidated` olur.

## 2. Task Context Packet v2 (`kind: full`)

| Alan | Anlam |
| --- | --- |
| `task_id`, `parent_task_id?`, `run_id`, `plan_id`, `plan_version`, `plan_digest` | Bağlantı ve onaylı plan sürümü |
| `role`, `model_tier`, `risk` | Worker rolü (orchestrator değil), tier, risk |
| `write_mode` | `read-only` \| `owned-paths` \| `rca-only` (debugger varsayılanı, ADR-10) |
| `isolation` | `worktree` \| `scoped-dir` \| `shared-read-only` (ADR-07) |
| `objective`, `why{user_goal, plan_reference?}` | Amaç |
| `scope{owned_paths, read_paths, forbidden_paths}` | Yazma/okuma/yasak |
| `known_facts[]{statement, source, source_digest, confidence}` | Kaynaklı bilgiler |
| `decisions[]`, `relevant_symbols[]`, `non_goals[]`, `open_questions[]`, `stop_conditions[]` | Bağlam |
| `acceptance_criteria[]` | `AC-n`, en az bir, benzersiz |
| `verification.commands[]` | Worker'ın koşacağı doğrulama |
| `limits{max_steps, max_wall_time_seconds, max_tool_calls?, max_cost_usd?}` | Sınırlar |
| `context{created_at, project_snapshot?, sources[]{path, digest}, digest_scheme?, inline_sources?[]}` | Freshness girdisi. `digest_scheme: workspace-raw-v1` (ADR-19): digest'ler izolasyondan **sonra** attempt'in kendi çalışma alanındaki ham baytlardan (`workspaceDigest`) hesaplanır ve orada geçerli yazma önkoşuludur; yoksa eski `text-lf-v1` (`digestText`). `inline_sources` (ADR-20): küçük read_paths içerikleri (dosya başına ≤ 8 KiB, toplam ≤ 32 KiB); her biri aynı digest'le `sources`'ta yer alır |
| `expected_report[]` | Completion packet'ta beklenen alanlar |

Şemanın reddettiği yetki genişletmeleri: read-only rolün path sahipliği; owned ∩ forbidden; tüm workspace veya rezerve path; `write_mode` ile `owned_paths` uyumsuzluğu; debugger dışı `rca-only`; yazan worker için `shared-read-only`; `high-risk` yazan görevde worktree dışı izolasyon; `context.sources`'ta aynı digest ile yer almayan `known_fact`. Paket yalnız başına yetki vermez: etkin yazma kapsamı packet ∩ policy ∩ sandbox'tır.

**Dispatch kapısı:** `findStaleSources(packet, currentDigests)` boş değilse dispatch durur, `context/source_changed` yazılır ve orchestrator yeniden paketler. Worker çalışırken aynı durum `needs_context` ile orchestrator'a döner.

## 3. Delta packet (`kind: delta`)

Aynı task'a ek iş: `extends_digest` (önceki paketin digest'i), `plan_digest`, `delta{new_acceptance_criteria, new_known_facts, new_evidence, notes}`. Delta **scope, rol, limit veya write_mode içeremez** (strict şema); yetki genişletmek yeni tam paket ister. Boş delta reddedilir.

## 4. Completion packet

`task_id`, `attempt_id`, `packet_digest`, `status (completed|partial|failed|blocked|needs_context)`, `summary`, `changed_paths[]{path, before, after}`, `artifact_digest?` (değişiklik varsa zorunlu; izole çalışma alanının sabitlenmiş diff'i), `tool_call_ids[]`, `acceptance_evidence[]{criterion_id, evidence[]}`, `commands_run[]{command, exit_code, evidence}`, `decisions_made[]`, `skipped_checks[]{check, reason}`, `unresolved_risks[]`, `recommended_context_updates[]`, `root_cause?`. Kurallar: rezerve path değişmiş raporlanamaz; `completed` en az bir kanıt ister; worker reviewer kanıtı atfedemez. Orchestration ayrıca her `AC`'nin kanıtlandığını ve `changed_paths ⊆ owned_paths` olduğunu gerçek diff'e karşı doğrular.

Completion'ın anlatı kısmı (status, summary, kanıt işaretçileri, kararlar, atlanan kontroller) worker'ın `task_report` aracı çağrısından gelir; reviewer'ın hükümleri `review_report`'tan, planın gövdesi `plan_propose`'dan (bkz. §7 "Rapor aracı girdileri"). Kimlik, `changed_paths`, `artifact_digest`, `tool_call_ids` ve `commands_run` (attempt günlüğündeki `exec` çağrılarından: argv, çıkış kodu, ToolCallId; modelin yazdığı çıkış kodu yok sayılır) her zaman harness tarafından doldurulur. ADR-18 ek alanları (hepsi opsiyonel, eski paketler geçerli kalır): `harness_evidence{verification[], diff?}` (harness'in worker turundan sonra kendisinin koştuğu doğrulama komutları ve sabitlenmiş diff), `evidence_resolution[]` (her işaretçinin nasıl çözüldüğü), `repairs{report_corrections, evidence_repairs, verification_repairs}`. Ayrıntı §8.

`EvidenceRef` = `kind (tool-call|test-run|artifact|file|event|review|harness-verification|harness-diff)`, `ref`, `digest?`, `produced_by (worker|reviewer|orchestrator|user|harness)`. Kanıt serbest metin değildir; log'un çözebileceği bir şeyi işaret eder. `harness-*` türlerini yalnız `harness` üretir, `harness` başka tür üretmez (şema uygular).

## 5. Review packet

`task_id`, `reviewed_attempt_id`, `reviewer_attempt_id` (farklı olmalı), `completion_digest`, `reviewed_artifact_digest`, `reviewer_route{provider_id, model_id}`, `independence{separate_context: true, same_provider, same_model}`, `criteria[]{criterion_id, verdict (met|not_met|unverifiable), evidence[], note?}`, `findings[]{id: F-n, severity (blocker|major|minor|info), summary, path?, line?, reproduction?, recommendation?}`, `decision (accept|revise|block)`.

Kurallar: her `met` hükmü reviewer'ın **kendi ürettiği** veya **harness'in hesapladığı** (`produced_by: harness`; ADR-09'un ADR-18 değişikliği) en az bir kanıta dayanır — worker'ın iddiası hiçbir zaman yetmez; `accept` tüm ölçütlerin `met` olmasını ve blocker olmamasını gerektirir; `separate_context` her zaman `true`. Opsiyonel `evidence_resolution[]` ve `repairs{report_corrections}` reviewer işaretçilerinin çözümünü kaydeder. Reviewer'a implementer transkripti verilmez; sabitlenmiş artifact + completion + kriterler verilir (ADR-09). Implementer'ın raporu tek başına nihai kabul değildir.

## 6. Durum eşlemesi

| Olay | Task geçişi |
| --- | --- |
| Plan onaylandı, bağımlılıklar tamam | `draft → ready` |
| `task/packet_issued` + `attempt/started` | `ready → running` |
| Completion `completed` | `running → verifying` (harness önce `verification.commands`'ı attempt çalışma alanında koşar ve `attempt/verification_ran` yazar) |
| Doğrulama yalnız kanıt eksik (`revise`, iş sağlam) veya harness doğrulaması başarısız | Aynı attempt session'ı artifact korunarak sürdürülür (`attempt/repair_requested`, `evidence_repairs` bütçesi); görev durumu değişmez. Bütçe bitince orchestrator triyajı (`task_triage`), doğrudan `failed` değil |
| Completion `needs_context` | `running → needs_context` (kaynak değiştiyse yeniden paketleme; worker'ın kendi bildirimiyse orchestrator triyajı) |
| Completion `partial` | Orchestrator triyajı: `accept` (yalnız hiçbir şey değiştirmemiş salt okunur görev) `running → verifying`, `retry` `running → failed → retry_pending → ready` (delta önceki raporu taşır), `fail` `running → failed` |
| Completion `blocked` / `failed` | `running → blocked` / `failed` |
| Doğrulama geçti, risk `standard`/`high-risk` | `verifying → reviewing` |
| Doğrulama geçti, risk `trivial` | `verifying → completed` |
| Review `accept` + integrate (`task/integrated`) | `reviewing → completed` |
| Review `revise` | `reviewing → changes_requested → ready` (delta packet) |
| Review `block` | `reviewing → failed` |

## 7. Örnekler

```yaml example=plan
schema_version: 1
plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
version: 1
goal: Fix the session loss during refresh token renewal.
risk: standard
scope: [src/auth/**, tests/auth/**]
tasks:
  - key: explore-refresh
    role: explorer
    objective: Map the refresh rotation flow and existing tests.
    depends_on: []
    owned_paths: []
    read_paths: [src/auth/**, src/session/**]
    risk: trivial
    model_tier: fast_worker
    acceptance_criteria: [{ id: AC-1, statement: "Report lists every call site of rotateRefreshToken" }]
    verification: []
  - key: fix-rotation
    role: implementer
    objective: Revoke the token family on reuse without ending normal renewals.
    depends_on: [explore-refresh]
    owned_paths: [src/auth/**, tests/auth/**]
    read_paths: [src/session/**]
    risk: standard
    model_tier: complex_worker
    acceptance_criteria:
      - { id: AC-1, statement: "Reusing an old refresh token revokes the current family" }
      - { id: AC-2, statement: "A normal renewal keeps the session" }
    verification: [pnpm test auth, pnpm typecheck]
  - key: review-rotation
    role: reviewer
    objective: Independently verify the rotation fix.
    depends_on: [fix-rotation]
    owned_paths: []
    read_paths: [src/auth/**, tests/auth/**]
    risk: standard
    model_tier: complex_worker
    acceptance_criteria: [{ id: AC-1, statement: "Each implementer criterion has reviewer evidence" }]
    verification: [pnpm test auth]
expected_external_effects: []
verification: [pnpm check]
budget: { max_wall_time_seconds: 3600, max_steps: 200, max_cost_usd: 5 }
assumptions: ["Public auth API does not change"]
created_at: "2026-09-22T10:01:00Z"
```

Reddedilenler: bağımsız paralel görevlerin aynı path'e yazması; bağımlılık çevrimi; path sahibi explorer.

```yaml example=plan invalid
- schema_version: 1
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  version: 1
  goal: Two writers on one tree.
  risk: standard
  scope: [src/**]
  tasks:
    - { key: a, role: implementer, objective: A, depends_on: [], owned_paths: [src/auth/**], read_paths: [], risk: standard, model_tier: complex_worker, acceptance_criteria: [{ id: AC-1, statement: a }], verification: [] }
    - { key: b, role: implementer, objective: B, depends_on: [], owned_paths: [src/Auth/token.ts], read_paths: [], risk: standard, model_tier: complex_worker, acceptance_criteria: [{ id: AC-1, statement: b }], verification: [] }
  expected_external_effects: []
  verification: []
  budget: { max_wall_time_seconds: 60, max_steps: 10 }
  assumptions: []
  created_at: "2026-09-22T10:01:00Z"
- schema_version: 1
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  version: 1
  goal: Cycle.
  risk: trivial
  scope: [docs/**]
  tasks:
    - { key: a, role: implementer, objective: A, depends_on: [b], owned_paths: [docs/a.md], read_paths: [], risk: trivial, model_tier: fast_worker, acceptance_criteria: [{ id: AC-1, statement: a }], verification: [] }
    - { key: b, role: implementer, objective: B, depends_on: [a], owned_paths: [docs/b.md], read_paths: [], risk: trivial, model_tier: fast_worker, acceptance_criteria: [{ id: AC-1, statement: b }], verification: [] }
  expected_external_effects: []
  verification: []
  budget: { max_wall_time_seconds: 60, max_steps: 10 }
  assumptions: []
  created_at: "2026-09-22T10:01:00Z"
- schema_version: 1
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  version: 1
  goal: Writing explorer.
  risk: trivial
  scope: [src/**]
  tasks:
    - { key: a, role: explorer, objective: A, depends_on: [], owned_paths: [src/a.ts], read_paths: [], risk: trivial, model_tier: fast_worker, acceptance_criteria: [{ id: AC-1, statement: a }], verification: [] }
  expected_external_effects: []
  verification: []
  budget: { max_wall_time_seconds: 60, max_steps: 10 }
  assumptions: []
  created_at: "2026-09-22T10:01:00Z"
```

```yaml example=task-packet
schema_version: 2
kind: full
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
plan_version: 1
plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
role: implementer
model_tier: complex_worker
risk: standard
write_mode: owned-paths
isolation: worktree
objective: Revoke the token family on reuse without ending normal renewals.
why: { user_goal: "The user's active session must not close unexpectedly", plan_reference: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5@1 }
scope:
  owned_paths: [src/auth/**, tests/auth/**]
  read_paths: [src/session/**]
  forbidden_paths: [src/billing/**]
known_facts:
  - statement: Token rotation is active on the refresh operation
    source: src/auth/refresh-service.ts
    source_digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777"
    confidence: verified
decisions: ["The public API contract will not change", "No database migration"]
relevant_symbols: [{ file: src/auth/refresh-service.ts, symbols: [rotateRefreshToken, revokeTokenFamily] }]
acceptance_criteria:
  - { id: AC-1, statement: "Reusing an old refresh token revokes the current family" }
  - { id: AC-2, statement: "A normal renewal keeps the session" }
verification: { commands: [pnpm test auth, pnpm typecheck] }
non_goals: ["Redesigning the auth API"]
open_questions: []
stop_conditions: ["A change outside owned paths is required"]
limits: { max_steps: 40, max_wall_time_seconds: 1800, max_tool_calls: 200 }
context:
  created_at: "2026-09-22T10:02:00Z"
  sources:
    - { path: src/auth/refresh-service.ts, digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777" }
    - { path: package.json, digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888" }
expected_report: [root_cause, changed_files, commands_run, verification_results, unresolved_risks]
```

Yetki genişletmeye çalışan paketler (hepsi reddedilir):

```yaml example=task-packet invalid
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: explorer
  model_tier: fast_worker
  risk: trivial
  write_mode: owned-paths
  isolation: scoped-dir
  objective: Explore and quietly fix.
  why: { user_goal: g }
  scope: { owned_paths: [src/auth/**], read_paths: [], forbidden_paths: [] }
  known_facts: []
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: implementer
  model_tier: complex_worker
  risk: standard
  write_mode: owned-paths
  isolation: worktree
  objective: Escape the workspace.
  why: { user_goal: g }
  scope: { owned_paths: ["../other-repo/**"], read_paths: [], forbidden_paths: [] }
  known_facts: []
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: implementer
  model_tier: complex_worker
  risk: standard
  write_mode: owned-paths
  isolation: worktree
  objective: Own everything including git internals.
  why: { user_goal: g }
  scope: { owned_paths: ["**", .git/hooks/**], read_paths: [], forbidden_paths: [] }
  known_facts: []
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: implementer
  model_tier: complex_worker
  risk: standard
  write_mode: owned-paths
  isolation: worktree
  objective: Own a forbidden area.
  why: { user_goal: g }
  scope: { owned_paths: [src/**], read_paths: [], forbidden_paths: [src/billing/**] }
  known_facts: []
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: orchestrator
  model_tier: orchestrator
  risk: trivial
  write_mode: read-only
  isolation: shared-read-only
  objective: Orchestrator dispatched as a worker.
  why: { user_goal: g }
  scope: { owned_paths: [], read_paths: [], forbidden_paths: [] }
  known_facts: []
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
- schema_version: 2
  kind: full
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  plan_version: 1
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  role: implementer
  model_tier: complex_worker
  risk: high-risk
  write_mode: owned-paths
  isolation: scoped-dir
  objective: High-risk write without a worktree, citing an unlisted source.
  why: { user_goal: g }
  scope: { owned_paths: [src/auth/**], read_paths: [], forbidden_paths: [] }
  known_facts:
    - { statement: s, source: src/auth/a.ts, source_digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777", confidence: verified }
  decisions: []
  relevant_symbols: []
  acceptance_criteria: [{ id: AC-1, statement: s }, { id: AC-1, statement: dup }]
  verification: { commands: [] }
  non_goals: []
  open_questions: []
  stop_conditions: []
  limits: { max_steps: 5, max_wall_time_seconds: 60 }
  context: { created_at: "2026-09-22T10:02:00Z", sources: [] }
  expected_report: [summary]
```

```yaml example=delta-packet
schema_version: 2
kind: delta
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
extends_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
created_at: "2026-09-22T11:00:00Z"
delta:
  new_acceptance_criteria: [{ id: AC-3, statement: "Add a regression test for two concurrent refresh requests" }]
  new_known_facts: []
  new_evidence: [{ kind: review, ref: "review:F-1", produced_by: reviewer }]
  notes: []
```

```yaml example=delta-packet invalid
- schema_version: 2
  kind: delta
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  extends_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  created_at: "2026-09-22T11:00:00Z"
  scope: { owned_paths: [src/**], read_paths: [], forbidden_paths: [] }
  delta: { new_acceptance_criteria: [], new_known_facts: [], new_evidence: [], notes: [widen] }
- schema_version: 2
  kind: delta
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  extends_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  created_at: "2026-09-22T11:00:00Z"
  delta: { new_acceptance_criteria: [], new_known_facts: [], new_evidence: [], notes: [], limits: { max_steps: 500 } }
```

```yaml example=completion-packet
schema_version: 2
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
status: completed
summary: Token family is revoked on reuse; normal renewals unaffected.
changed_paths:
  - { path: src/auth/refresh-service.ts, before: "sha256:7777777777777777777777777777777777777777777777777777777777777777", after: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  - { path: tests/auth/refresh-race.test.ts, before: null, after: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
tool_call_ids: [call_01K5T3Q8Z4X9V2M6N7P0R1S2TE]
acceptance_evidence:
  - { criterion_id: AC-1, evidence: [{ kind: test-run, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker }] }
  - { criterion_id: AC-2, evidence: [{ kind: test-run, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker }] }
commands_run:
  - { command: pnpm test auth, exit_code: 0, evidence: { kind: tool-call, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker } }
decisions_made: []
skipped_checks: []
unresolved_risks: []
recommended_context_updates: []
root_cause: Rotation did not mark the previous token as consumed before issuing a new one.
```

```yaml example=completion-packet invalid
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  status: completed
  summary: Done, trust me.
  changed_paths: [{ path: .git/hooks/pre-commit, before: null, after: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]
  tool_call_ids: []
  acceptance_evidence: []
  commands_run: []
  decisions_made: []
  skipped_checks: []
  unresolved_risks: []
  recommended_context_updates: []
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  status: completed
  summary: Claims reviewer approval.
  changed_paths: []
  tool_call_ids: []
  acceptance_evidence: [{ criterion_id: AC-1, evidence: [{ kind: review, ref: "review:ok", produced_by: reviewer }] }]
  commands_run: []
  decisions_made: []
  skipped_checks: []
  unresolved_risks: []
  recommended_context_updates: []
```

```yaml example=review-packet
schema_version: 2
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
reviewed_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
reviewer_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T9
completion_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
reviewed_artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
reviewer_route: { provider_id: anthropic, model_id: opus-5 }
independence: { separate_context: true, same_provider: false, same_model: false }
criteria:
  - criterion_id: AC-1
    verdict: met
    evidence:
      - { kind: test-run, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TW, produced_by: reviewer }
      - { kind: tool-call, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker }
  - criterion_id: AC-2
    verdict: met
    evidence: [{ kind: file, ref: "tests/auth/refresh-race.test.ts#L12", produced_by: reviewer }]
findings:
  - { id: F-1, severity: minor, summary: "Missing comment on revocation ordering", path: src/auth/refresh-service.ts, line: 88 }
decision: accept
```

Reddedilenler: yalnız worker kanıtıyla `met`; karşılanmamış ölçütle `accept`; kendi kendini inceleme; ortak bağlam.

```yaml example=review-packet invalid
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  reviewed_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  reviewer_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T9
  completion_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  reviewed_artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  reviewer_route: { provider_id: openai, model_id: gpt-5.6-sol }
  independence: { separate_context: true, same_provider: true, same_model: true }
  criteria: [{ criterion_id: AC-1, verdict: met, evidence: [{ kind: tool-call, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker }] }]
  findings: []
  decision: accept
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  reviewed_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  reviewer_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T9
  completion_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  reviewed_artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  reviewer_route: { provider_id: openai, model_id: gpt-5.6-sol }
  independence: { separate_context: true, same_provider: true, same_model: false }
  criteria: [{ criterion_id: AC-1, verdict: not_met, evidence: [] }]
  findings: [{ id: F-1, severity: blocker, summary: "Race still reproducible" }]
  decision: accept
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  reviewed_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  reviewer_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  completion_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  reviewed_artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  reviewer_route: { provider_id: openai, model_id: gpt-5.6-sol }
  independence: { separate_context: false, same_provider: true, same_model: true }
  criteria: [{ criterion_id: AC-1, verdict: unverifiable, evidence: [] }]
  findings: []
  decision: revise
```

### Rapor aracı girdileri

`task_report`, `review_report` ve `plan_propose` araçlarının girdileri ([runtime-seams.md](./runtime-seams.md#5-yapılandırılmış-rapor-araçları)). Opsiyonel listeler boş varsayılır; bilinmeyen alan reddedilir — worker `changed_paths`, `artifact_digest` veya kimlik iddia edemez.

```yaml example=task-report
- status: completed
  summary: Serialized refresh token rotation behind the per-profile lock.
  acceptance_evidence:
    - criterion_id: AC-1
      evidence: [{ kind: test-run, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker }]
  commands_run:
    - { command: pnpm test auth, exit_code: 0, evidence: { kind: tool-call, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker } }
- status: needs_context
  summary: src/auth/refresh-service.ts changed since the packet was issued.
```

```yaml example=task-report invalid
- status: done
  summary: finished
- status: completed
  summary: finished
  changed_paths: [src/auth/refresh-service.ts]
```

```yaml example=review-report
criteria:
  - criterion_id: AC-1
    verdict: met
    evidence: [{ kind: test-run, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TW, produced_by: reviewer }]
findings:
  - { id: F-1, severity: minor, summary: "Missing comment on revocation ordering", path: src/auth/refresh-service.ts, line: 88 }
decision: accept
```

```yaml example=review-report invalid
- criteria: []
  decision: accept
- criteria: [{ criterion_id: AC-1, verdict: met, evidence: [] }]
  decision: approve
```

```yaml example=plan-proposal
goal: Fix refresh token rotation race
risk: standard
scope: [src/auth/**, tests/auth/**]
tasks:
  - key: fix-rotation
    role: implementer
    objective: Serialize refresh token rotation
    depends_on: []
    owned_paths: [src/auth/refresh-service.ts]
    read_paths: [src/auth/**]
    risk: standard
    model_tier: complex_worker
    acceptance_criteria: [{ id: AC-1, statement: "Concurrent refreshes rotate the token exactly once" }]
    verification: [pnpm test auth]
expected_external_effects: []
verification: [pnpm test]
budget: { max_wall_time_seconds: 1800, max_steps: 100 }
assumptions: []
```

Kimlik alanları modelden gelmez:

```yaml example=plan-proposal invalid
goal: Fix refresh token rotation race
plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
risk: standard
scope: [src/auth/**]
tasks: []
expected_external_effects: []
verification: []
budget: { max_wall_time_seconds: 1800, max_steps: 100 }
assumptions: []
```

## 8. Harness kanıtı, çözümleme ve onarım (ADR-18)

Harness doğruyu hesaplar, model anlatıyı verir. Şemalar: `src/harness/contracts/evidence.ts`.

**Kısa referans (`[#n]`).** Modele gösterilen her tool sonucu `[#n] ` ile başlar (`renderToolResultText`); `n`, çağrının attempt'i içindeki (attempt yoksa session içindeki) 1'den başlayan sırasıdır, `tool/call_proposed` sırasıyla atanır ve `tool/call_proposed.ref` (v2) içine yazılır. `#n` tam olarak bir `ToolCallId`'ye eşlenir. Model kanıt olarak `#n` yazar.

**Toleranslı çözümleme.** `tool-call`, `test-run` ve `file` işaretçileri sırayla (`TOOL_EVIDENCE_RESOLUTION_ORDER`) şu yöntemlerle eşlenir; ilk eşleşme kazanır ve `evidence_resolution[].method` olarak kaydedilir:

1. `tool-call-id` — harness `ToolCallId` (`call_…`) aynen;
2. `short-ref` — baştaki `#n` / `[#n]` (`parseToolRef`; ardından düz yazı gelebilir);
3. `provider-call-id` — sağlayıcının çağrı kimliği (`fc_…`, `toolu_…`);
4. `tool-name-args` — baştaki `functions.` / `mcp__synorch__` öneki atılır; ilk sözcük attempt'te çağrılmış bir araç adıdır ve kalan sözcüklerden en az biri o çağrının argüman değerleriyle (argv, path) örtüşür; en çok örtüşen, eşitlikte en son başarılı çağrı seçilir;
5. `path-token` — ilk yol benzeri sözcük (`:L…`, `#L…`, ` (…)` ve `—`/` - ` sonrası atılır), NFC + platform katlama politikasıyla normalize edilir; attempt'in değiştirdiği veya okuduğu bir dosyaysa `file` kanıtı olarak çözülür.

`artifact` işaretçisi `artifact-digest`, `event` işaretçisi `event-ref` (`<session>#<seq>`), `harness-*` işaretçileri `harness-record` ile çözülür. `kind` bir ipucudur: `tool-call` yazılmış bir `#n` çıkış kodu 0 olan bir `exec`'e çözülürse kanıt geçerlidir. Başarısız, reddedilmiş veya kesintiye uğramış çağrı; sıfırdan farklı çıkan `test-run`; compaction özeti asla kanıt değildir (ADR-11).

**Rapor aracında tek düzeltme turu.** `task_report` ve `review_report` kanıtı **araç çağrısının içinde** çözer. Çözülmeyen işaretçi varsa araç `invalid_arguments` döner: `error.message` tek satırlık özet, `text` `formatEvidenceCorrection` çıktısıdır (her sorunlu işaretçi ve geçerli `#n` listesi, ör. `#5 exec node check.mjs -> exit 0`). Model aynı session'da `REPORT_CORRECTION_ROUNDS` (= 1) kez düzeltebilir; ikinci ret de kayda geçer ve rapor olduğu gibi kabul edilir (çözülmeyenler `evidence_resolution`'da `unresolved` olarak durur). Başarılı rapor turu bitirir (ADR-20, `ends_turn`).

**Harness doğrulaması.** Worker turu bitince harness, paketin `verification.commands` listesini attempt çalışma alanında policy'nin `verification_commands` allowlist'i ve sandbox'la kendisi koşar; her komut için `attempt/verification_ran` yazar ve completion'a `harness_evidence.verification[]` kaydı ekler (`evidence`: `kind: harness-verification`, `produced_by: harness`, `ref: <session_id>#<seq>`). Değişiklik varsa `harness_evidence.diff` (`kind: harness-diff`, `ref` = `artifact_digest`, `changed_paths` = gerçek diff) eklenir. Worker'ın `commands_run`/`skipped_checks` iddiası tavsiye niteliğindedir; zorunlu komutun sonucu harness kaydıdır.

**Ölçüt kararı.** Bir ölçüt, modelin işaretçilerinden en az biri çözülürse kanıtlıdır. Düzeltme turundan sonra hiçbiri çözülmezse ve harness doğrulamasının tüm komutları `passed` ise (en az bir komut varsa) ve yazan görevde diff kapsam içindeyse, ölçüt harness kanıtıyla kanıtlanır: `acceptance_evidence`'a harness kayıtları eklenir, `evidence_resolution`'da `method: harness-substitute` görünür ve reviewer bunu paketinde görür. Aksi halde doğrulama `revise` (yalnız kanıt) verir ve **aynı attempt** onarılır.

**Onarım ve bütçeler.** `evidence-repair` (iş sağlam, işaretçi eksik) ve `verification-repair` (harness doğrulaması `failed`) aynı attempt session'ını sorunlar listesiyle sürdürür, çalışma alanı ve artifact korunur, `attempt/repair_requested` yazılır. Bütçeler görev başınadır ve ayrıdır (`orchestrationBudgetsSchema`): `triage_retries` (yeni attempt, varsayılan 1), `evidence_repairs` (session içi onarım, varsayılan 2), `review_revisions` (review sonrası revizyon, varsayılan 2). Bir bütçe bitince orchestrator `task_triage` ile danışılır; görev kendiliğinden `failed` olmaz.

**Reviewer.** Aynı mekanizma: `review_report` işaretçileri tolerant çözülür, tek düzeltme turu vardır. Düzeltmeden sonra çözülmeyen reviewer işaretçisi review'ü `invalid` yapmaz; işaretçi düşer (kayıtlı) ve reviewer/harness kanıtı kalmayan `met` hükmü `unverifiable` sayılır → review sonucu `revise` geri bildirimidir. `invalid` yalnız bağ ihlallerinde (başka görev/attempt/artifact/completion) kalır.

```yaml example=evidence-resolution
- { criterion_id: AC-1, kind: test-run, ref: "#5", produced_by: worker, status: resolved, method: short-ref, tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE }
- { criterion_id: AC-1, kind: tool-call, ref: "functions.exec node check.mjs: exit code 0", produced_by: worker, status: resolved, method: tool-name-args, tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE }
- { criterion_id: AC-2, kind: file, ref: "src-add.mjs:1-3 — adds the numbers", produced_by: worker, status: resolved, method: path-token, path: src-add.mjs }
- { criterion_id: AC-2, kind: tool-call, ref: "the tests pass", produced_by: worker, status: unresolved, reason: "names no tool call, ref or path of this attempt" }
- { criterion_id: AC-2, kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness, status: resolved, method: harness-substitute }
```

```yaml example=evidence-resolution invalid
- { kind: tool-call, ref: "#9", produced_by: worker, status: resolved }
- { kind: tool-call, ref: "#9", produced_by: worker, status: unresolved, reason: "no call #9", tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE }
- { kind: tool-call, ref: "#9", produced_by: worker, status: resolved, method: short-ref, reason: "also a reason" }
```

```yaml example=harness-evidence
verification:
  - ordinal: 1
    command: node check.mjs
    status: passed
    termination: exited
    exit_code: 0
    evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness }
  - ordinal: 2
    command: "pnpm test && pnpm lint"
    status: not-run
    exit_code: null
    reason: "a shell expression cannot run as argv"
    evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#42", produced_by: harness }
diff:
  evidence: { kind: harness-diff, ref: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", produced_by: harness }
  changed_paths: [src-add.mjs]
```

Reddedilenler: çıkış kodu 1 olan `passed`; worker'ın ürettiği harness kaydı; tekrar eden sıra numarası; `harness-verification` türünde diff kaydı.

```yaml example=harness-evidence invalid
- verification:
    - { ordinal: 1, command: node check.mjs, status: passed, termination: exited, exit_code: 1, evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness } }
- verification:
    - { ordinal: 1, command: node check.mjs, status: passed, termination: exited, exit_code: 0, evidence: { kind: harness-verification, ref: "x", produced_by: worker } }
- verification:
    - { ordinal: 1, command: a, status: failed, termination: exited, exit_code: 2, evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness } }
    - { ordinal: 1, command: b, status: failed, termination: timeout, exit_code: null, evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#42", produced_by: harness } }
- verification: []
  diff: { evidence: { kind: harness-verification, ref: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", produced_by: harness }, changed_paths: [] }
```

Harness kanıtlı completion (ikinci live run'ın düzeltilmiş hali): worker işaretçileri `#n` ile çözüldü, AC-2 ayrıca harness doğrulamasına dayanıyor.

```yaml example=completion-packet
schema_version: 2
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
status: completed
summary: add() now returns the sum; check.mjs prints ok.
changed_paths:
  - { path: src-add.mjs, before: "sha256:7777777777777777777777777777777777777777777777777777777777777777", after: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
tool_call_ids: [call_01K5T3Q8Z4X9V2M6N7P0R1S2TE]
acceptance_evidence:
  - { criterion_id: AC-1, evidence: [{ kind: file, ref: "src-add.mjs", produced_by: worker }, { kind: harness-diff, ref: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", produced_by: harness }] }
  - { criterion_id: AC-2, evidence: [{ kind: test-run, ref: "#5", produced_by: worker }, { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness }] }
commands_run:
  - { command: node check.mjs, exit_code: 0, evidence: { kind: tool-call, ref: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, produced_by: worker } }
decisions_made: []
skipped_checks: []
unresolved_risks: []
recommended_context_updates: []
harness_evidence:
  verification:
    - ordinal: 1
      command: node check.mjs
      status: passed
      termination: exited
      exit_code: 0
      evidence: { kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness }
  diff:
    evidence: { kind: harness-diff, ref: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", produced_by: harness }
    changed_paths: [src-add.mjs]
evidence_resolution:
  - { criterion_id: AC-1, kind: file, ref: "src-add.mjs", produced_by: worker, status: resolved, method: path-token, path: src-add.mjs }
  - { criterion_id: AC-2, kind: test-run, ref: "#5", produced_by: worker, status: resolved, method: short-ref, tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE }
repairs: { report_corrections: 1, evidence_repairs: 0, verification_repairs: 0 }
```

Reddedilenler: `harness_evidence`'ta olmayan harness işaretçisi; artifact'a bağlanmayan harness diff'i.

```yaml example=completion-packet invalid
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  status: completed
  summary: Cites a verification the harness never ran.
  changed_paths: []
  tool_call_ids: []
  acceptance_evidence: [{ criterion_id: AC-1, evidence: [{ kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#99", produced_by: harness }] }]
  commands_run: []
  decisions_made: []
  skipped_checks: []
  unresolved_risks: []
  recommended_context_updates: []
  harness_evidence: { verification: [] }
- schema_version: 2
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  status: completed
  summary: Diff record bound to another artifact.
  changed_paths: [{ path: src-add.mjs, before: null, after: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]
  artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  tool_call_ids: []
  acceptance_evidence: [{ criterion_id: AC-1, evidence: [{ kind: harness-diff, ref: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", produced_by: harness }] }]
  commands_run: []
  decisions_made: []
  skipped_checks: []
  unresolved_risks: []
  recommended_context_updates: []
  harness_evidence:
    verification: []
    diff: { evidence: { kind: harness-diff, ref: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", produced_by: harness }, changed_paths: [src-add.mjs] }
```

Harness kanıtı reviewer için bağımsızdır (ADR-09 değişikliği):

```yaml example=review-packet
schema_version: 2
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
reviewed_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
reviewer_attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T9
completion_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
reviewed_artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
reviewer_route: { provider_id: openai, model_id: gpt-6-astra }
independence: { separate_context: true, same_provider: true, same_model: false }
criteria:
  - criterion_id: AC-1
    verdict: met
    evidence: [{ kind: tool-call, ref: "#2", produced_by: reviewer }]
  - criterion_id: AC-2
    verdict: met
    evidence: [{ kind: harness-verification, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#41", produced_by: harness }]
findings: []
decision: accept
evidence_resolution:
  - { criterion_id: AC-1, kind: tool-call, ref: "#2", produced_by: reviewer, status: resolved, method: short-ref, tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TW }
repairs: { report_corrections: 0 }
```

Bütçeler (`orchestrationBudgetsSchema`; eksik alanlar varsayılanı alır):

```yaml example=orchestration-budgets
- {}
- { triage_retries: 1, evidence_repairs: 2, review_revisions: 2 }
- { triage_retries: 0, evidence_repairs: 5 }
```

```yaml example=orchestration-budgets invalid
- { triage_retries: 9 }
- { evidence_repairs: -1 }
- { report_corrections: 3 }
```

Attempt çalışma alanında hesaplanmış (ADR-19) ve küçük okuma girdisi satır içine alınmış (ADR-20) paket; ikinci örnek, `sources`'ta olmayan satır içi kaynak nedeniyle reddedilir:

```yaml example=task-packet
schema_version: 2
kind: full
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
plan_version: 1
plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
role: implementer
model_tier: fast_worker
risk: standard
write_mode: owned-paths
isolation: worktree
objective: Make add() return the sum.
why: { user_goal: "check.mjs must print ok" }
scope: { owned_paths: [src-add.mjs], read_paths: [check.mjs], forbidden_paths: [] }
known_facts:
  - { statement: "check.mjs imports add from src-add.mjs", source: check.mjs, source_digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212", confidence: verified }
decisions: []
relevant_symbols: []
acceptance_criteria: [{ id: AC-1, statement: "add(a, b) returns a + b" }, { id: AC-2, statement: "node check.mjs exits 0" }]
verification: { commands: [node check.mjs] }
non_goals: []
open_questions: []
stop_conditions: []
limits: { max_steps: 25, max_wall_time_seconds: 900 }
context:
  created_at: "2026-09-23T12:00:00Z"
  sources:
    - { path: check.mjs, digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212" }
    - { path: src-add.mjs, digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777" }
  digest_scheme: workspace-raw-v1
  inline_sources:
    - { path: check.mjs, digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212", content: "import { add } from './src-add.mjs';\nconsole.log(add(1, 2) === 3 ? 'ok' : 'fail');\n", truncated: false }
expected_report: [changed_files, verification_results]
```

```yaml example=task-packet invalid
schema_version: 2
kind: full
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
plan_id: plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5
plan_version: 1
plan_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
role: implementer
model_tier: fast_worker
risk: standard
write_mode: owned-paths
isolation: worktree
objective: Make add() return the sum.
why: { user_goal: "check.mjs must print ok" }
scope: { owned_paths: [src-add.mjs], read_paths: [check.mjs], forbidden_paths: [] }
known_facts: []
decisions: []
relevant_symbols: []
acceptance_criteria: [{ id: AC-1, statement: "add(a, b) returns a + b" }]
verification: { commands: [node check.mjs] }
non_goals: []
open_questions: []
stop_conditions: []
limits: { max_steps: 25, max_wall_time_seconds: 900 }
context:
  created_at: "2026-09-23T12:00:00Z"
  sources: []
  digest_scheme: workspace-raw-v1
  inline_sources:
    - { path: check.mjs, digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212", content: "x", truncated: false }
expected_report: [changed_files]
```
