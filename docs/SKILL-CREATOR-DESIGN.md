# Synorch Skill Creator — Design Decisions

> Status: First slice implemented — observation ledger, generated-skill contract and its doctor checks, the `skill-creator` base skill and the `sync` protections. Wiring into `doctor-service.ts` and `createStructureFiles` is pending integration.
> Decided: 2026-09-22
> Related: [Architecture](./AI-ORCHESTRATION-ARCHITECTURE.md), [Hermes research](./research/HERMES-SKILL-SYSTEM.md), [Harness vision](./FUTURE-MULTI-PROVIDER-HARNESS.md) §22 Phase 0
> Purpose: Let the system improve itself by turning repeatedly confirmed project knowledge into durable skills, without accumulating context debt.

## 1. The One-Paragraph Version

Synorch does not generate project skills on first contact. It watches completed work, records each non-obvious discovery as a cheap **observation** with its evidence, and proposes a skill only after the same discovery has been independently confirmed **three times**. Proposals require user approval, are written by a delegated worker and verified by an independent reviewer, live in their own namespace, carry their evidence in frontmatter, and are subject to a hard budget: **twelve active project skills, 15KB each**. Nothing is ever auto-deleted, but the system continuously proposes retirement for what has gone stale or unused.

Distillation is the feature. The budget is what makes it safe.

## 2. Decision Table

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| D1 | When is generation triggered? | On task completion, by distillation. Never on first session. | Cold-scanning a repo produces generic content the Ingenium packs already cover. Real project knowledge only surfaces while working. |
| D2 | Does bootstrap generate anything? | No. | The project record already holds verified facts. A "project facts skill" would duplicate it. There is legitimately no procedural knowledge on day one. |
| D3 | Who writes the skill file? | A delegated implementer; an independent reviewer verifies. | No constitutional change needed, and permanent instructions are exactly what deserves independent review. |
| D4 | New agent role? | No. Existing implementer + reviewer, driven by a new `skill-creator` base skill. | Role proliferation costs maintenance; the authority model already fits. |
| D5 | Promotion threshold | 3 distinct task IDs. | Two can be coincidence. Three is a pattern and still reachable within a normal week of work. |
| D6 | Fast path | A user correction promotes immediately. | The user explicitly saying "not that way, this way" is the highest-signal evidence available. Waiting for three is disrespectful of their time. |
| D7 | Where do observations live? | `.ai/tasks/observations.yaml`, Git-tracked. | Inside the orchestrator's only writable area, so no constitutional change; persistent across sessions; shared with the team. |
| D8 | Unpromoted observation expiry | 90 days or 20 tasks without reconfirmation, whichever comes first. | A one-off oddity is not a procedure. Structural immunity to `incident-log-shape`. |
| D9 | Skill namespace | `.ai/skills/project/<id>/SKILL.md` | Must never be touched by `sync --force`; authorship is agent + user, not canonical. |
| D10 | Active project skill budget | **12**. Promotion beyond the cap requires retiring one. | The single strongest defense against the accumulation Hermes does not solve. Skill count is context cost. |
| D11 | Size ceiling | 15KB per `SKILL.md`, blocking. | Adopted from the Hermes evolution repo's constraint gates. |
| D12 | Auto-deletion | Never. Retirement is always proposed, never executed silently. | Deleting user-approved content without asking violates the approval-first principle. |
| D13 | `doctor` severity | Contract violations are errors; shape heuristics are warnings. | Matches the existing diagnostic model and avoids a linter that blocks on taste. |
| D14 | Priority ceiling | A generated skill can never hold `constitutional` priority or override a core protocol. Enforced by `doctor`. | Prompt-injection defense: a malicious repo comment must not be able to write itself into permanent policy. |
| D15 | New CLI command? | Not in the first slice. `sync` and `doctor` absorb the work. | The CLI stays lightweight and predictable; a `syn skill` surface can come later if it earns itself. |
| D16 | Base skill count | `skill-creator` becomes the ninth canonical base skill. | It must exist in every project for the loop to run at all. |

## 3. The Observation Ledger

Observations are the cheap half of the system. Recording one costs a few lines of YAML and requires no user interaction.

```yaml
# .ai/tasks/observations.yaml
schema_version: 1
observations:
  - id: api-test-execution
    claim: >
      API tests must run with cwd services/api and
      TESTCONTAINERS_RYUK_DISABLED=true, or they fail on startup.
    kind: command-behavior
    sources:
      - path: services/api/package.json
        digest: sha256:9f2c...
      - path: .github/workflows/ci.yml
        digest: sha256:41ab...
    confirmed_by: [task-141, task-156, task-173]
    count: 3
    origin: worker-discovery
    first_seen_at: 2026-09-14
    last_seen_at: 2026-09-22
    status: ready-to-propose
```

`status` is one of `collecting`, `ready-to-propose`, `proposed`, `promoted`, `declined`, `expired`.

`kind` exists to make deduplication tractable; the initial set is `command-behavior`, `convention`, `ordering-constraint`, `pitfall`, `boundary`.

### Rules

- An observation is recorded only when it carries at least one source path. No source, no observation.
- Confirmation must come from a **distinct** `task_id`. The same task hitting the same wall twice counts once.
- `declined` is permanent for that observation id. The user is not asked twice.
- At most **one** promotion proposal per final report. If several are ready, the highest `count` goes first and the rest wait.

## 4. Lifecycle

```text
worker discovers something non-obvious, with evidence
        ↓
orchestrator records/increments an observation      ← no user interaction, ~2 lines
        ↓
count reaches 3  (or: user correction → immediate)
        ↓
orchestrator proposes at the end of the final report
        ↓
user approves ──── declines → status: declined, never asked again
        ↓
budget check: 12 active? → must retire one first
        ↓
orchestrator delegates authoring to an implementer
        ↓
independent reviewer verifies claims against sources
        ↓
skill written to .ai/skills/project/<id>/SKILL.md, activated in the registry
```

## 5. Generated Skill Contract

```yaml
---
name: api-test-execution
description: How to run and debug the API test suite in this repository.
version: 1.0.0
origin: generated
status: active
priority: skill
generated_at: 2026-09-22
verified_at: 2026-09-22
confirmations: 3
confirmed_by: [task-141, task-156, task-173]
evidence:
  - claim: Tests require cwd services/api
    source: services/api/package.json
    digest: sha256:9f2c...
  - claim: TESTCONTAINERS_RYUK_DISABLED=true is required locally
    source: .github/workflows/ci.yml
    digest: sha256:41ab...
supersedes: []
---
```

Blocking contract rules enforced by `doctor`:

1. `origin: generated` requires a non-empty `evidence` list, and every entry needs `source` plus `digest`.
2. Every `source` must exist and stay inside the root, under both lexical and `realpath` checks.
3. `priority` must be `skill`. `constitutional`, `core` or any protocol-level value is rejected.
4. `SKILL.md` must be ≤ 15KB.
5. Active project skills must be ≤ 12.
6. Every id in `confirmed_by` must exist in the observation ledger.

## 6. Retirement

Three signals, none of which delete anything on their own.

**Stale.** A worker loads the skill and reports that a claim no longer holds, or `doctor` finds a `source` whose current digest differs from the recorded one. Status flips to `stale` immediately, the skill stops being auto-loaded, and re-verification is proposed. This is the negative feedback loop Hermes has no mechanism for; Synorch can build it because completion packets are structured.

**Unused.** Not loaded in 60 days *and* 30 tasks. `doctor` emits a warning and the orchestrator offers retirement at the next natural pause.

**Superseded.** A new proposal overlaps an existing skill on `kind` plus source paths. The orchestrator proposes a **merge into the existing skill**, not a second skill. `supersedes` records the lineage.

Retirement moves the file to `.ai/skills/project/<id>/RETIRED.md` and drops it from the registry. Nothing is deleted from Git history.

## 7. Shape Heuristics (Warnings)

Adapted from the `incident-log-shape` check that Hermes's linter names. These warn, never block:

- **incident-log-shape** — the body narrates a single past event (past tense, a specific task id, a specific date) instead of stating a repeatable procedure.
- **no-trigger** — no explicit activation condition, so the skill can never be matched cheaply.
- **restates-generic** — the content substantially overlaps a bundled Ingenium skill already active on this project.
- **unsourced-claim** — a body claim that no `evidence` entry backs.

## 8. What Changes in the Codebase

The first implementation slice touches:

| Area | Change |
| --- | --- |
| `src/domain/skill-packs.ts` | Add `skill-creator` to `BASE_SKILLS` (eight → nine). |
| `src/templates/` | New canonical `skill-creator` base skill template. |
| `src/domain/` | New observation ledger and generated-skill frontmatter schemas (zod). |
| `src/application/doctor-service.ts` | Contract validation, budget and size checks, digest staleness, priority ceiling, canonical set count. |
| `src/application/project-discovery.ts` | Never overwrite `.ai/skills/project/**`; prune expired observations; report counts. |
| `.gitignore` / templates | Track `.ai/tasks/observations.yaml`; ignore per-task working directories. |
| Docs | Architecture §12 skill section, decision log entry, README skill table. |

This also resolves architecture open decision §15.4 (whether task files are Git-tracked): the observation ledger is tracked, per-task working directories are not.

## 9. Deliberate Non-Goals

- No model call inside the CLI, ever. Generation happens in the host agent; `syn` only provides the contract, the validation and the budget.
- No automatic import of skills from external sources. The `reference-only` trust level is unchanged.
- No evolutionary optimization (DSPy/GEPA style). Interesting, but it needs an evaluation dataset Synorch does not have.
- No cross-project skill sharing in this slice. A project skill stays in its project.
- No silent anything: no silent creation, no silent activation, no silent deletion.

## 10. Why This Beats Simply Copying Hermes

Hermes proved the loop works and shipped the parts worth copying — `SKILL.md` as procedural memory, three-level progressive loading, an approval gate, hash-based protection of user edits. Its documented design has no promotion threshold, no deduplication, no pruning, and no negative feedback from use, so skills accumulate monotonically and the only brake is human review load.

Synorch closes all four gaps, and can do so because of an asset Hermes lacks: workers already return **structured completion packets** carrying `commands_run`, `decisions_made` and `unresolved_risks` with source paths. That is a far better distillation input than a raw conversation trace, and it is what makes a confirmation counter, an evidence digest and a staleness signal cheap to implement rather than speculative.
