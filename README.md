<div align="center">

# Synorch

**Turn any repository into an orchestrator-led AI development organization — in one command.**

[![npm version](https://img.shields.io/npm/v/synorch.svg?color=0b7285&label=npm)](https://www.npmjs.com/package/synorch)
[![license](https://img.shields.io/badge/license-MIT-0b7285.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-0b7285.svg)](https://nodejs.org)

`npx synorch init` · works with **Codex** and **Claude Code** · zero runtime, zero lock-in

</div>

---

## Why Synorch exists

Coding agents are already good at writing code. What they are bad at is *running a project*.

Left alone, a single agent session drifts in predictable ways. It starts implementing before anyone agreed on a plan. It re-reads the same repository from scratch in every subagent, burning tokens on facts it already knew. It grades its own homework, so the review is never independent. It guesses your stack instead of proving it. And every new session starts from zero, because nothing it learned was written down anywhere durable.

Synorch fixes the *organization* around the model, not the model itself.

It is a CLI that installs a provider-neutral **orchestration system** into a folder, a repository, or a multi-repo workspace: one decision-making orchestrator, a set of specialized worker roles, constitutional protocols they cannot override, evidence-backed project facts, and a skill library that loads only when it is actually needed. After `syn init` and `syn sync`, you keep working exactly as before — inside Codex or Claude Code — except the agent now operates inside a structure with rules, memory, and receipts.

### What it is not

Synorch is deliberately small in scope, and honest about it:

- It is **not** a model runtime. It never calls an API, never holds your keys, never runs a conversation loop.
- It is **not** a background daemon. Nothing watches your files. Every action is a command you type.
- It is **not** another coding assistant. It makes the one you already pay for behave like a team.
- It **never invents** your architecture. Empty folder in, generic core out — no hallucinated project facts.
- It **never fakes** provider capabilities. If Codex or Claude Code can't do something, `syn doctor` tells you instead of pretending a markdown file solved it.

---

## Quick start

```bash
# Inside an existing repository — no install needed
npx synorch init      # install the orchestration core
npx synorch sync      # discover the real stack from evidence
npx synorch doctor    # verify every reference end to end
```

Prefer a global install and the short command:

```bash
npm install --global synorch
syn init && syn sync && syn doctor
```

Other package managers work the same way:

```bash
pnpm dlx synorch init
yarn dlx synorch init
```

Then just open Codex or Claude Code in that folder. The generated `AGENTS.md` and `CLAUDE.md` become the entry point, and the orchestrator takes it from there.

> **Requires Node.js 24+.** Synorch ships as strict-TypeScript ESM and relies on Node's built-in type stripping — no transpiler in your dependency tree.

---

## The 60-second tour

```bash
$ syn inspect          # dry run: exactly what would be written, and what would conflict
Target: /home/dev/acme-api
Scope: repository
+ create    AGENTS.md
+ create    CLAUDE.md
+ create    .ai/constitution.md
+ create    .ai/protocols/core/orchestration.md
...
! conflict  .ai/skills/planning/SKILL.md

1 conflict(s) found. Existing files will not be overwritten without --force.
```

```bash
$ syn sync             # evidence-driven discovery, then registry refresh
Discovered 3 project(s).
  acme-api: services/api
  acme-web: apps/web
  acme-jobs: services/jobs
```

```bash
$ syn doctor           # integrity check from workspace entry down to skill file
ERROR skill.registry.missing_file: Registered skill has no file on disk (.ai/skills/technology/react-patterns/SKILL.md)
```

`doctor` exits non-zero on any error, so it drops straight into CI.

---

## How the system works

### One decision center

You talk to the orchestrator. Only the orchestrator talks back to you. Everything else happens below the waterline.

```text
                        You
                         │
                         ▼
                  ┌─────────────┐
                  │ Orchestrator│  plans · decides · delegates · verifies
                  └──────┬──────┘
         ┌───────────┬───┴───────┬────────────┐
         ▼           ▼           ▼            ▼
     Explorer   Implementer   Debugger    Reviewer
    (read-only)  (scoped      (root       (independent
                  writes)      cause)      of the author)
```

The orchestrator is a control plane, not a contributor. It is forbidden from writing production, test, config, or documentation code — even when the change is one line. It may only write orchestration artifacts under `.ai/tasks/**`. The agent that implemented something can never be the final judge of it.

### Every task gets planned, approved, and proven

```text
SESSION_BOOTSTRAP → MODEL_PROFILE_CONFIRMATION → INTAKE → DISCOVERY
→ CLARIFICATION → PLAN → USER_APPROVAL → DECOMPOSITION → DISPATCH
→ MONITORING → VERIFICATION → REVIEW → FINAL_REPORT
```

Two gates are non-negotiable. Before the first task of a session, the orchestrator shows you the active provider and the model assigned to every role and waits for confirmation. Before any execution, it shows you a plan and waits for approval. Nothing starts silently.

### Effort scales with risk

Full ceremony on a typo fix is just expensive theater. Synorch classifies every task before execution:

| Tier | Workers | Verification | Independent review |
| --- | --- | --- | --- |
| **trivial** | one fast worker | claim-specific evidence only | not by default |
| **standard** | matched to scope | targeted checks | on material or boundary-crossing changes |
| **high-risk** | complex worker | comprehensive evidence | mandatory |

Tiers can only be escalated — if a finding widens the scope mid-flight, the task moves up, never down. Headed-browser verification is opt-in: it needs either your explicit request or a named criterion that cheaper evidence genuinely cannot settle.

### Context packets instead of re-reading the repo

The expensive failure mode of multi-agent setups is that every worker rediscovers the same codebase. Synorch's answer is a schema'd handoff: the orchestrator does broad discovery **once**, then compiles a minimal, sourced packet per task.

```yaml
task_id: auth-refresh-fix-implementation
assigned_role: implementer
model_tier: complex_worker

objective: Fix the session loss that occurs during refresh token rotation.

scope:
  owned_paths: [src/auth/**, tests/auth/**]
  read_paths: [src/session/**]
  forbidden_paths: [src/billing/**]

known_facts:
  - statement: Token rotation is active on refresh
    source: src/auth/refresh-service.ts
    confidence: verified

acceptance_criteria:
  - Replaying an old refresh token revokes the whole token family
  - A normal refresh does not terminate the active session

verification:
  commands: [pnpm test auth, pnpm typecheck]
```

Workers report back in the same structured shape — changed files, commands run, decisions made, unresolved risks. Follow-up work uses **delta handoff** (`extends:` plus only what changed) rather than resending the whole packet. If a worker notices that the files its context was built on have shifted, it stops and escalates instead of acting on stale truth.

### Facts, not guesses

`syn sync` walks your repository or workspace deterministically and records what it can *prove*, with a source path attached to every claim:

```yaml
test:
  value: pnpm test
  cwd: frontend
  source: package.json
  confidence: verified
```

It parses JavaScript/TypeScript manifests plus Maven and Gradle definitions, and it is careful about false positives: commented-out coordinates and entries sitting only under dependency/plugin *management* do not count as evidence of an active framework. Nested module trees are discovered recursively, with a separate depth budget so a deep Java source tree isn't silently truncated. When a safety limit is genuinely reached, sync fails loudly rather than handing you an incomplete snapshot.

### Skills load just in time

Every project registry gets the same eight canonical base skills:

`planning` · `project-discovery` · `codebase-exploration` · `implementation` · `verification` · `debugging` · `code-review` · `task-conductor`

Technology skills are added **only** when matching verified evidence exists:

| Detected | Activated skills |
| --- | --- |
| TypeScript | `typescript-patterns` |
| React | `react-patterns`, `react-modern`, `frontend-craft` |
| Vue / Nuxt | `vue-modern`, `frontend-craft` |
| Java | `java-patterns`, `java-backend` |
| Spring Boot | `spring-boot-patterns` |
| JPA / Hibernate | `jpa-patterns`, `db-schema-craft`, `query-tuning` |
| Express / Fastify / NestJS | `node-backend` |
| Maven · Gradle | `maven-build` · `gradle-build` |
| Tailwind CSS | `tailwind-v4-tokens` |

Beyond that, `sync` materializes a bundled 32-skill Ingenium library under `.ai/skills/library/ingenium/`, with source, license, and provenance recorded in `.ai/skills/catalog.yaml`. Those entries stay `available`, not loaded — the orchestrator pulls one into context only when a task description actually matches its description. Loading the whole pool at once is explicitly forbidden, which is the difference between a useful library and a context bill.

Three states, kept distinct: **available** (in the catalog) → **active** (in a project registry) → **loaded** (in a task context). Session bootstrap never scans the catalog.

Anthropic Agent Skills, Superpowers, and Microsoft Agent Skills are catalogued `reference-only` with pinned commit IDs. Third-party content is never auto-imported or executed without a separate security and license review.

### Provider-neutral core, honest adapters

Protocols are written against capability tiers, not vendor model names:

```yaml
model_tiers:
  orchestrator: [strongest_reasoning, delegation, long_context]
  complex_worker: [strong_coding, autonomous_execution]
  fast_worker: [low_latency, low_cost]
```

Adapters map those tiers onto the real model IDs of whichever provider you're running, with overrides resolving session → project → workspace → provider default. **Silent fallback is banned.** If a requested model isn't available, or the provider doesn't support per-subagent model selection, or the main session model can't be changed mid-flight, you are told — by `doctor` and again at session confirmation. Synorch will never let a markdown file imply a capability the host doesn't actually have.

---

## Commands

```bash
syn inspect [--target <path>] [--scope workspace|repository]
syn init    [--target <path>] [--scope workspace|repository] [--force]
syn sync    [--target <path>] [--force] [--json]
syn doctor  [--target <path>] [--json]
```

| Command | What it does |
| --- | --- |
| `inspect` | Dry run. Prints every file that would be created, updated, left unchanged, or flagged as a conflict. Writes nothing. |
| `init` | Installs the canonical structure and provider entrypoints. Never touches your source code. Existing differing files are preserved unless `--force`. |
| `sync` | Manually triggered discovery. Records project facts with evidence, resolves skills, writes registries. Refuses to clobber hand-edited generated files without `--force`. |
| `doctor` | Validates the full reference chain — workspace entry → project record → module dirs → manifests → command `cwd` → skill registry → skill file — plus canonical base-skill completeness and path containment (both lexical traversal and `realpath` symlink/junction escapes). |

`--json` on `sync` and `doctor` gives machine-readable output for CI pipelines.

**Safety defaults that actually hold:** existing differing files are never overwritten without an explicit `--force`; the active skill registry is written *last*, after every prerequisite output, so a failed write leaves the previous working registry intact; and nothing is reported `healthy` while a single reference is missing, broken, duplicated, or pointing outside the root.

---

## Generated structure

```text
.ai/
├── manifest.yaml
├── constitution.md              # constitutional, non-overridable rules
├── workspace.yaml
├── projects/
│   ├── <project-id>.yaml        # evidence-backed project facts
│   └── <project-id>.skills.yaml # skill selections + rationale + matched evidence
├── protocols/
│   ├── registry.yaml
│   └── core/
│       ├── orchestration.md          planning-and-approval.md
│       ├── delegation.md             model-routing.md
│       ├── context-handoff.md        verification.md
│       ├── failure-recovery.md       user-communication.md
├── agents/
│   └── orchestrator · explorer · implementer · reviewer · debugger
├── skills/
│   ├── <eight canonical base skills>/SKILL.md
│   ├── technology/<selected>/SKILL.md
│   ├── library/ingenium/**            # bundled, on-demand
│   └── catalog.yaml                   # provenance, license, activation mode
├── model-profiles/
│   ├── openai.yaml
│   └── claude.yaml
├── tasks/                        # plans, context packets, decision log
└── providers/
    ├── codex.md
    └── claude-code.md
```

Plus `AGENTS.md` and `CLAUDE.md` at the root as provider entrypoints.

### Workspace mode vs. repository mode

**Repository mode** puts the structure inside a single repo, so it travels through Git and the whole team shares it.

**Workspace mode** puts one shared system in a parent folder above several repositories, each tracked as its own project record:

```text
workspace/
├── AGENTS.md
├── CLAUDE.md
├── .ai/
├── repo-a/
└── repo-b/
```

Cloned a new repo into the workspace? Run `syn sync`. There is no watcher and no full re-`init`.

On an empty folder, Synorch installs the generic orchestration core and stops. No invented stack, no imaginary architecture, `projects: []`.

---

## Contributing

```bash
pnpm install
pnpm check          # typecheck + test + build
pnpm dev -- inspect # run the CLI from source
```

`pnpm check` also runs as a `prepack` gate, so nothing ships without passing typecheck, tests, and build. Package contents are restricted by an explicit allowlist, CI uses read-only default permissions with pinned action SHAs, and npm releases go out through Trusted Publishing (OIDC) — no long-lived tokens stored anywhere.

---

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](./docs/AI-ORCHESTRATION-ARCHITECTURE.md) | The full design: orchestration model, protocol system, context architecture, model routing, discovery, open decisions, and the dated decision log. |
| [Multi-provider harness vision](./docs/FUTURE-MULTI-PROVIDER-HARNESS.md) | Where this goes next — running different providers in different roles under one orchestrator. Proposal stage, not implemented. |
| [CHANGELOG](./CHANGELOG.md) | Version history, Keep a Changelog + SemVer. |
| [Release notes v0.2.0](./docs/releases/v0.2.0.md) | Human-readable notes for the current release. |
| [Security policy](./SECURITY.md) | Report vulnerabilities through the private channel, not a public issue. |

---

## Roadmap

Today Synorch generates and validates the structure; your host agent executes it. The [multi-provider harness proposal](./docs/FUTURE-MULTI-PROVIDER-HARNESS.md) sketches a future layer that could connect authorized provider accounts, run different models in different roles under one orchestrator, persist task state, and manage the implementation-to-review flow across vendors. That layer is not implemented, and this README will not pretend otherwise.

---

## License

MIT © [Tunahan Tuna](https://github.com/TunahanTuna) — see [LICENSE](./LICENSE).
