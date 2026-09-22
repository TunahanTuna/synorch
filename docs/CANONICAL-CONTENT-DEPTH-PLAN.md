# Canonical Content Depth — Analysis and Work Plan

> Status: Implemented (W1–W7). Contracts in `src/domain/canonical-contracts.ts`, enforced by `doctor`.
> Analysed: 2026-09-22
> Related: [Architecture](./AI-ORCHESTRATION-ARCHITECTURE.md) §8.1, §8.2, [Skill Creator design](./SKILL-CREATOR-DESIGN.md), [Hermes research](./research/HERMES-SKILL-SYSTEM.md) §5
> Purpose: The agent manifests and base skills produced by `syn init` are too thin to carry the behavior the architecture specifies. This document measures the gap, resolves it against the token budget, and defines the work.

## 1. The Finding, Stated Precisely

The generated core is not shallow as a matter of taste. It **fails the contract this repository's own architecture document defines** for agents (§8.1) and skills (§8.2).

Measured from a real `syn init --scope repository` run:

### Agent manifests

| Agent | Size | Lines | Body lines after frontmatter and heading |
| --- | --- | --- | --- |
| debugger | 265 B | 9 | 2 |
| explorer | 293 B | 9 | 2 |
| implementer | 316 B | 9 | 2 |
| reviewer | 316 B | 9 | 2 |
| orchestrator | 505 B | 10 | 2 |
| **Total** | **1 695 B** | | |

Every agent role in the system is defined in roughly two sentences.

### Base skills

| Skill | Size | Lines |
| --- | --- | --- |
| debugging | 323 B | 8 |
| codebase-exploration | 366 B | 8 |
| implementation | 367 B | 8 |
| code-review | 382 B | 8 |
| project-discovery | 434 B | 8 |
| planning | 567 B | 15 |
| verification | 582 B | 8 |
| **task-conductor** | **3 694 B** | **48** |

`task-conductor` alone is larger than the other seven canonical base skills **combined** (3 021 B), and 11× the size of `debugging`. Two files in the same category, produced by the same command, carrying the same authority, differ by an order of magnitude.

That is the clearest statement of the problem: **the quality bar already exists in this repository.** `task-conductor` has classification rules, a numbered procedure, a context-economy section, a verification ladder and a completion contract. Seven canonical skills of equal standing have none of it.

## 2. Contract Compliance Audit

### Against §8.1 — what an agent definition must contain

| Requirement | Agents satisfying it |
| --- | --- |
| Role and purpose | 5 / 5 |
| Permitted and forbidden operations | 3 / 5 partially, explicit in 1 |
| The responsibility it owns | 5 / 5 |
| **The skills it may use** | **0 / 5** |
| Delegation and escalation boundaries | 2 / 5 partially |
| **The expected report format** | **0 / 5** — referenced, never specified |
| **Completion conditions** | **0 / 5** |

### Against §8.2 — what a skill must contain

| Requirement | Skills satisfying it |
| --- | --- |
| Explicit trigger conditions | 8 / 8 via `description`; negative triggers only in `task-conductor` |
| Purpose and out-of-scope points | 2 / 8 |
| **Required inputs** | **0 / 8** |
| Step-by-step procedure | 2 / 8 — the other six are single prose paragraphs |
| **Tools that may be used** | **0 / 8** |
| Verification method | 2 / 8 |
| Stop and escalation conditions | 2 / 8 |
| **Expected output contract** | **1 / 8** |

Six of the fifteen required elements are satisfied by **zero** generated files. Overall the generated core meets roughly a third of its own specification.

The practical consequence is not abstract. An agent dispatched as `explorer` is told "do not modify files" but never told which skills it may load, what shape its report must take, or when it is allowed to consider itself done. Those gaps are filled by model improvisation, and improvisation is exactly what a canonical structure exists to remove.

## 3. Resolving Depth Against the Token Budget

The objection to depth is token cost. That objection is correct only for content that loads unconditionally — and the current budget is allocated **backwards**.

Per session, a Codex orchestrator unconditionally loads `AGENTS.md` (2 128 B) plus `constitution.md` (1 040 B) = **3 168 B**. All five agent manifests together are **1 695 B**. The always-loaded layer is roughly **1.9× the size of the entire conditional role layer**.

Load frequency differs by an order of magnitude between layers, so the budget must too:

| Layer | Loaded | Current | Target ceiling | Direction |
| --- | --- | --- | --- | --- |
| Provider entrypoint | every session | 2 128 B | 2 500 B | hold |
| Constitution | every session | 1 040 B | 1 500 B | hold |
| Core protocol | when applicable | 361–1 231 B | 2 000 B each | modest growth |
| Agent manifest | once per dispatch, one role only | 265–505 B | 3 000 B each | **grow substantially** |
| Base skill `SKILL.md` | just in time, on match | 323–582 B | 6 000 B each | **grow substantially** |
| Skill `references/*.md` | only when a question needs it | none exist | 15 000 B each | **introduce** |

The key asymmetry: a worker dispatched as `implementer` loads **only** the implementer manifest. Taking it from 316 B to 3 KB costs roughly 700 extra tokens, once, for that dispatch — and it is paid precisely when the content is about to be used. One prevented out-of-scope edit or one correctly shaped completion packet repays it immediately. Growing `AGENTS.md` by the same amount would be paid on every session forever, whether it helps or not.

**Depth is cheap where it is conditional and expensive where it is unconditional.** The current structure has it exactly the wrong way round.

### The references pattern

The Hermes research documents "knowledge-base skills": a lean `SKILL.md` plus distilled `references/` files, on the principle that *reference files cost nothing until a question needs one*. Synorch's directory layout already supports this and nothing uses it.

This is how genuine depth is added without touching the hot path. `SKILL.md` carries the procedure and the decision rules; `references/` carries worked examples, failure catalogues and edge cases that are only fetched when a step actually needs them.

## 4. Target Shape

### Agent manifest

```markdown
---
name: implementer
role: product-change
writes_product_files: true
model_tier: complex_worker | fast_worker
allowed_skills: [implementation, verification, <technology skills from the packet>]
forbidden_skills: [planning, task-conductor]
reports: completion-packet
---

# Implementer

## Purpose
## Authority            — may do / must never do, as two explicit lists
## Required inputs       — what must be in the packet before work starts
## Procedure             — numbered, the happy path
## Escalation            — the named conditions that return control to the orchestrator
## Report contract       — the completion-packet fields this role must populate
## Completion conditions — when this role is allowed to declare itself done
```

`allowed_skills` and `reports` become machine-checkable, which is what turns §8.1 from prose into something `doctor` can enforce.

### Base skill

```markdown
---
name: debugging
description: <positive trigger>
not_for: <negative trigger — when NOT to load this>
inputs: [...]
tools: [...]
outputs: <output contract reference>
references: [references/hypothesis-patterns.md]
---

# Debugging

## When this applies / When it does not
## Required inputs
## Procedure          — numbered steps
## Tools
## Verification       — how to prove this skill's own output is correct
## Stop and escalate
## Output contract
```

`not_for` is a small addition with real value: it is what stops a skill being loaded on a task that merely sounds similar, which is the main waste channel in just-in-time loading.

## 5. Work Plan

Ordered by dependency. Each item is independently shippable.

| # | Work | Touches |
| --- | --- | --- |
| W1 | Define Canonical Agent Manifest v1 and Canonical Skill Contract v1 as zod schemas, including the new frontmatter fields. | `src/domain/` |
| W2 | Rewrite five agent manifests to the target shape against the schema. | `src/templates/structure-templates.ts` |
| W3 | Rewrite seven base skills to the target shape, using `task-conductor` as the reference standard. | `src/templates/structure-templates.ts` |
| W4 | Introduce `references/` support: generation, path containment, and catalog awareness. | templates, `project-discovery`, `doctor` |
| W5 | Extend `doctor` with contract validation and per-layer size ceilings; contract violations are errors, size overruns are warnings. | `src/application/doctor-service.ts` |
| W6 | Cross-check protocols against the deepened agents and skills; remove duplication so a rule lives in exactly one layer. | `src/templates/structure-templates.ts` |
| W7 | Update architecture §5 and §8, the README structure section, and the decision log. | `docs/`, `README.md` |

W1 is shared with the [Skill Creator](./SKILL-CREATOR-DESIGN.md) work — that design needs the same Canonical Skill Contract v1, and the harness roadmap already lists it as Phase 0. Doing W1 once serves both, so it should be built first regardless of which feature ships first.

### Acceptance criteria

1. Every generated agent manifest satisfies all seven §8.1 elements; `doctor` fails the build otherwise.
2. Every generated base skill satisfies all eight §8.2 elements; `doctor` fails the build otherwise.
3. No layer exceeds its ceiling in the table above.
4. Unconditionally loaded bytes per session do not increase beyond the entrypoint and constitution ceilings.
5. The size spread across canonical base skills is within roughly 3×, not the current 11×.
6. Existing structures can adopt the new content through `syn init --force` with the documented migration note.

## 6. Non-Goals

- No new agent roles. Five roles are sufficient; this is about depth, not breadth.
- No growth in the always-loaded layer beyond its stated ceiling. If a rule is not needed every session, it does not belong there.
- No prose padding. Every added section must be something a worker can act on or be checked against; length is a consequence of the contract, never a target.
- No duplication across layers. A rule stated in a protocol is referenced by the agent, not restated.
