# Plan ve görev paketleri

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/packets.ts`; uygulama: `src/harness/orchestration/`, `src/harness/context/` (I4). Kararlar: [ADR-07](../decisions/ADR-07-worker-isolation.md), [ADR-09](../decisions/ADR-09-reviewer-independence.md), [ADR-10](../decisions/ADR-10-debugger-write.md). Kaynak: [mevcut Synorch bağlam aktarımı](../../AI-ORCHESTRATION-ARCHITECTURE.md) §11.

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
| `context{created_at, project_snapshot?, sources[]{path, digest}}` | Freshness girdisi |
| `expected_report[]` | Completion packet'ta beklenen alanlar |

Şemanın reddettiği yetki genişletmeleri: read-only rolün path sahipliği; owned ∩ forbidden; tüm workspace veya rezerve path; `write_mode` ile `owned_paths` uyumsuzluğu; debugger dışı `rca-only`; yazan worker için `shared-read-only`; `high-risk` yazan görevde worktree dışı izolasyon; `context.sources`'ta aynı digest ile yer almayan `known_fact`. Paket yalnız başına yetki vermez: etkin yazma kapsamı packet ∩ policy ∩ sandbox'tır.

**Dispatch kapısı:** `findStaleSources(packet, currentDigests)` boş değilse dispatch durur, `context/source_changed` yazılır ve orchestrator yeniden paketler. Worker çalışırken aynı durum `needs_context` ile orchestrator'a döner.

## 3. Delta packet (`kind: delta`)

Aynı task'a ek iş: `extends_digest` (önceki paketin digest'i), `plan_digest`, `delta{new_acceptance_criteria, new_known_facts, new_evidence, notes}`. Delta **scope, rol, limit veya write_mode içeremez** (strict şema); yetki genişletmek yeni tam paket ister. Boş delta reddedilir.

## 4. Completion packet

`task_id`, `attempt_id`, `packet_digest`, `status (completed|partial|failed|blocked|needs_context)`, `summary`, `changed_paths[]{path, before, after}`, `artifact_digest?` (değişiklik varsa zorunlu; izole çalışma alanının sabitlenmiş diff'i), `tool_call_ids[]`, `acceptance_evidence[]{criterion_id, evidence[]}`, `commands_run[]{command, exit_code, evidence}`, `decisions_made[]`, `skipped_checks[]{check, reason}`, `unresolved_risks[]`, `recommended_context_updates[]`, `root_cause?`. Kurallar: rezerve path değişmiş raporlanamaz; `completed` en az bir kanıt ister; worker reviewer kanıtı atfedemez. Orchestration ayrıca her `AC`'nin kanıtlandığını ve `changed_paths ⊆ owned_paths` olduğunu gerçek diff'e karşı doğrular.

Completion'ın anlatı kısmı (status, summary, kanıt işaretçileri, komutlar, kararlar) worker'ın `task_report` aracı çağrısından gelir; reviewer'ın hükümleri `review_report`'tan, planın gövdesi `plan_propose`'dan (bkz. §7 "Rapor aracı girdileri"). Kimlik, `changed_paths`, `artifact_digest` ve `tool_call_ids` her zaman harness tarafından doldurulur.

`EvidenceRef` = `kind (tool-call|test-run|artifact|file|event|review)`, `ref`, `digest?`, `produced_by (worker|reviewer|orchestrator|user)`. Kanıt serbest metin değildir; log'un çözebileceği bir şeyi işaret eder.

## 5. Review packet

`task_id`, `reviewed_attempt_id`, `reviewer_attempt_id` (farklı olmalı), `completion_digest`, `reviewed_artifact_digest`, `reviewer_route{provider_id, model_id}`, `independence{separate_context: true, same_provider, same_model}`, `criteria[]{criterion_id, verdict (met|not_met|unverifiable), evidence[], note?}`, `findings[]{id: F-n, severity (blocker|major|minor|info), summary, path?, line?, reproduction?, recommendation?}`, `decision (accept|revise|block)`.

Kurallar: her `met` hükmü reviewer'ın **kendi ürettiği** en az bir kanıta dayanır; `accept` tüm ölçütlerin `met` olmasını ve blocker olmamasını gerektirir; `separate_context` her zaman `true`. Reviewer'a implementer transkripti verilmez; sabitlenmiş artifact + completion + kriterler verilir (ADR-09). Implementer'ın raporu tek başına nihai kabul değildir.

## 6. Durum eşlemesi

| Olay | Task geçişi |
| --- | --- |
| Plan onaylandı, bağımlılıklar tamam | `draft → ready` |
| `task/packet_issued` + `attempt/started` | `ready → running` |
| Completion `completed` | `running → verifying` |
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
