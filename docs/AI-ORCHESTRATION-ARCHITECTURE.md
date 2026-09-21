# Synorch — Architecture and Implemented Structure

> Status: The executable core is implemented
> Last updated: 2026-09-20
> Purpose: Establish an orchestrator-centric, agent/skill/protocol-based and token-efficient development organization that runs on Codex and Claude Code.

## 1. Product Definition

This project is not a model runtime, a continuously running agent harness, or an alternative coding assistant.

The product name is **Synorch**. The NPM package name is `synorch`, the primary terminal command is `syn`, and the discoverable long executable alias is `synorch`.

The product is a CLI that, when run against an empty folder, an existing repository, or a workspace containing multiple repositories, installs an AI development working system. After installation, day-to-day development continues directly inside Codex or Claude Code.

Responsibilities of the CLI:

- Install provider-neutral agent, skill and protocol definitions.
- Adapt those definitions to the structures Codex and Claude Code support.
- Support the empty-folder, existing-repository and multi-repository workspace scenarios.
- Register new repositories into the system through manually triggered discovery/synchronization operations.
- Audit the consistency of the structure and the provider capabilities.

What the CLI is not responsible for:

- Being an orchestration runtime that runs continuously during development.
- Operating its own model conversation loop or tool-calling infrastructure.
- Choosing a project architecture, framework or technology without the user asking.
- Fabricating imaginary project information in an empty folder.
- Presenting features that Codex or Claude Code do not support as if they existed, using prompt files alone.

## 2. Core Design Principles

1. **A single decision center:** The user communicates only with the orchestrator.
2. **The orchestrator does not write code:** Analysis, planning, delegation, monitoring and the final decision belong to the orchestrator; implementation belongs to the worker agents.
3. **Every piece of work is planned:** Before implementation starts, there is an analysis and a plan presented to the user.
4. **Evidence-driven work:** Unknown information is not guessed; facts are recorded together with their sources.
5. **Progressive disclosure:** An agent receives only the instructions and context required for its own task.
6. **Prevent rediscovery:** Workers receive a task-specific context package that cites its sources.
7. **Independent verification:** The agent that produced an implementation cannot be the sole final auditor of its own work.
8. **Provider-neutral core:** Roles and protocols are defined in common; adapters are generated for Codex and Claude Code.
9. **Cost-aware model selection:** A powerful model is used only when powerful reasoning is required.
10. **Explicit boundaries:** Behavior the provider cannot technically guarantee is reported by `doctor`.

## 3. Operating Scopes

### 3.1 Workspace mode

The shared AI system lives in a parent folder and the repositories live in subfolders:

```text
workspace/
├── AGENTS.md
├── CLAUDE.md
├── .ai/
├── repo-a/
└── repo-b/
```

When the agent is started with Codex or Claude Code at the workspace root, it uses the shared protocols and skills. Repositories are treated as separate project records.

### 3.2 Repository mode

The AI structure lives directly inside the repository:

```text
my-repo/
├── .git/
├── AGENTS.md
├── CLAUDE.md
├── .ai/
└── src/
```

This structure can be shared through Git and used across the whole team.

### 3.3 Empty folder behavior

In an empty folder, no project analysis or AI-based architecture generation is performed. Only the generic orchestration core is installed, and the workspace project list starts out empty.

```yaml
schema_version: 1
scope: workspace
projects: []
```

## 4. CLI Lifecycle

Implemented commands:

```text
syn inspect
syn init
syn sync [--force]
syn doctor
```

- `init`: Installs the agent/skill/protocol core and the provider adapters.
- `inspect`: Shows the structure that would be created or changed, without writing anything.
- `sync`: Manually triggered; discovers modules and evidence, and synchronizes the project records and skill registries. It preserves differentiated generated technology skills by default; it refreshes them only with an explicit `--force`.
- `doctor`: Validates the canonical configuration, the project → record → skill registry → skill file reference chain, and the file system boundaries.

No background watcher or daemon is planned. When a new repository is added, the user can run `sync`. A full re-`init` is not required.

## 5. Implemented Initial File Structure

```text
.ai/
├── manifest.yaml
├── constitution.md
├── workspace.yaml
├── projects/
│   ├── <project-id>.yaml
│   └── <project-id>.skills.yaml
├── protocols/
│   ├── registry.yaml
│   ├── core/
│   │   ├── orchestration.md
│   │   ├── planning-and-approval.md
│   │   ├── delegation.md
│   │   ├── model-routing.md
│   │   ├── context-handoff.md
│   │   ├── verification.md
│   │   ├── failure-recovery.md
│   │   └── user-communication.md
├── agents/
│   ├── orchestrator/AGENT.md
│   ├── explorer/AGENT.md
│   ├── implementer/AGENT.md
│   ├── reviewer/AGENT.md
│   └── debugger/AGENT.md
├── skills/
│   ├── planning/SKILL.md
│   ├── project-discovery/SKILL.md
│   ├── codebase-exploration/SKILL.md
│   ├── implementation/SKILL.md
│   ├── verification/SKILL.md
│   ├── debugging/SKILL.md
│   ├── code-review/SKILL.md
│   └── technology/
│       └── <selected-skill>/SKILL.md
├── model-profiles/
│   ├── openai.yaml
│   └── claude.yaml
├── tasks/
│   └── .gitkeep
└── providers/
    ├── codex.md
    └── claude-code.md
```

Whether the records under `tasks/` are persistent or temporary, and whether they are included in Git, will be finalized later.

## 6. The Orchestrator Model

The orchestrator is the control plane. Worker agents are the execution plane.

```text
User
   │
   ▼
Orchestrator
   ├── Explorer
   ├── Implementer
   ├── Debugger
   └── Reviewer
```

### 6.1 Responsibilities of the orchestrator

- Take the work from the user and clarify the goal.
- Perform the analysis required about the repository or workspace, or have the explorer perform it.
- Make the architectural and implementation decisions.
- Prepare a plan for every piece of work and present it to the user.
- Split the work into independent tasks and build a task dependency graph.
- Choose the right worker type and model tier for every task.
- Hand workers sufficient and bounded context.
- Coordinate parallel work and prevent file ownership conflicts.
- Evaluate worker reports, diffs and verification evidence.
- Create/update only the plan, context packets, decision log and orchestration metadata under `.ai/tasks/**`.
- Be the only party that reports the final result to the user.

### 6.2 Prohibitions of the orchestrator

- Writing or editing production, test, config or documentation code directly.
- Writing directly to project files outside `.ai/tasks/**`.
- Taking on a worker role on the grounds that "the work is small".
- Silently moving a plan that requires user approval into execution.
- Accepting a worker's claim without evidence.
- Finishing a failed worker's work itself.
- Directing implementation workers to communicate with the user directly.

The orchestrator may read files, run searches, examine diffs and test results, and keep control-plane artifacts under `.ai/tasks/**`. Whether write access to product files can be constrained at the prompt level or technically through provider permissions will be decided per adapter.

## 7. The Main Orchestration Protocol

The main protocol must have `constitutional` priority, be mandatory, and be non-overridable by lower-level protocols.

Example invariants:

```yaml
id: core.orchestration
version: 1.0.0
priority: constitutional
mandatory: true
overridable: false

invariants:
  - orchestrator_never_writes_code
  - only_orchestrator_communicates_with_user
  - every_task_is_planned
  - execution_requires_user_approval
  - all_implementation_is_delegated
  - implementation_requires_independent_verification
  - worker_uncertainty_is_escalated_to_orchestrator
```

### 7.1 Task state machine

```text
SESSION_BOOTSTRAP
  ↓
MODEL_PROFILE_CONFIRMATION
  ↓
INTAKE
  ↓
DISCOVERY
  ↓
CLARIFICATION
  ↓
PLAN
  ↓
USER_APPROVAL
  ↓
DECOMPOSITION
  ↓
DISPATCH
  ↓
MONITORING
  ↓
VERIFICATION
  ↓
REVIEW
  ↓
FINAL_REPORT
```

`MODEL_PROFILE_CONFIRMATION` is mandatory in every new session before the first task begins. The orchestrator shows the user the active provider, its own model, the worker model mappings, the routing mode and any applicable overrides. The user can continue with the current profile or request a change.

This confirmation is taken once per session. The gate reopens if provider/model availability changes, if a profile override is applied during the session, or if a mismatch regarding the orchestrator model is detected.

Default approval policy:

```yaml
approval:
  before_execution: always
```

## 8. Agent and Skill Separation

### 8.1 Agent

An agent answers the question "who is working, with what authority and with what responsibility?"

An agent definition contains:

- Role and purpose
- Permitted/forbidden operations
- The responsibility it owns
- The skills it may use
- Delegation and escalation boundaries
- The expected report format
- Completion conditions

Initial roles:

- `orchestrator`: Decisions, planning and coordination.
- `explorer`: Read-only research and evidence gathering.
- `implementer`: Implementation within the given scope.
- `debugger`: Symptom, hypothesis, evidence and root cause analysis.
- `reviewer`: Assessment independent of the implementation.

If a new way of working is needed, a skill is created first. However, if different authority, independence or responsibility is needed, a new agent is defined.

### 8.2 Skill

A skill answers the question "how is a particular piece of work done reliably and repeatably?"

Every skill must contain at least:

- Explicit trigger conditions
- Purpose and out-of-scope points
- Required inputs
- A step-by-step procedure
- The tools that may be used
- The verification method
- Stop and escalation conditions
- The expected output contract

Skills are loaded on demand; not every skill's content is included in every session.

## 9. The Protocol System

A protocol is an organizational rule that sits above agents and skills. New protocols can be added later.

The expected priority:

```text
Platform and security rules
        ↓
Constitution / core protocols
        ↓
The task plan approved by the user
        ↓
Domain and custom protocols
        ↓
Agent definitions
        ↓
Skill procedures
```

Protocols mandatory from the start:

- Orchestration
- Planning and user approval
- Delegation and task ownership
- Model routing and budget
- Context handoff
- Verification and independent review
- Failure, retry and escalation
- User communication

## 10. Model Routing

Core protocols must not depend directly on provider model names. Capability tiers are used instead:

```yaml
model_tiers:
  orchestrator:
    requires:
      - strongest_reasoning
      - delegation
      - long_context

  complex_worker:
    requires:
      - strong_coding
      - autonomous_execution

  fast_worker:
    requires:
      - low_latency
      - low_cost
```

The initial mapping for OpenAI:

```yaml
provider: openai
defaults:
  orchestrator: gpt-6-astra
  complex_worker: gpt-5.6-sol
  fast_worker: gpt-5.6-luna
```

The initial mapping for Claude, as determined by the user:

```yaml
provider: claude
defaults:
  orchestrator: fable-5
  complex_worker: opus-5
  fast_worker: sonnet-5
```

These names are the desired logical model identities in the canonical structure. The adapter must verify the installed provider's real model IDs and the accessibility of those models. If a model is not available, no silent fallback may occur; the mismatch and the available alternatives must be shown to the user.

### 10.1 Configuration layers

Model profiles must be changeable afterwards. The proposed override priority:

```text
Session override
      ↓
Project override
      ↓
Workspace override
      ↓
Provider default
```

Example canonical configuration:

```yaml
model_profiles:
  openai:
    orchestrator: gpt-6-astra
    complex_worker: gpt-5.6-sol
    fast_worker: gpt-5.6-luna

  claude:
    orchestrator: fable-5
    complex_worker: opus-5
    fast_worker: sonnet-5

routing:
  mode: automatic
  require_session_confirmation: true
  silent_fallback: false
```

Project or workspace profiles may persist in a file. A session override applies only to the current session and does not change the canonical default. Unless the user explicitly says "save as default", a temporary choice is not written into persistent settings.

### 10.2 The session model confirmation protocol

Before the first task, the orchestrator must display at least the following:

```text
Active provider: OpenAI or Claude
Orchestrator: <model>
Complex worker: <model>
Fast worker: <model>
Routing: automatic/manual
Fallback: disabled/enabled
Override source: default/workspace/project/session
```

It then asks the user whether they want to continue with this profile or change it. It does not move into the discovery/planning stage of a task until approval is given.

The main session model may not be changeable after the session has started on some providers. In such a case the orchestrator:

1. Displays the currently active model correctly.
2. Explains the mismatch with the requested model.
3. States that a new session/restart is required, if necessary.
4. Does not behave as if the change had taken place.

Worker models are likewise applicable only if the provider supports per-subagent model selection. Unsupported model routing is surfaced as a missing capability by `doctor` and during session confirmation.

The core routing principles:

- Architectural analysis and the final decision: the orchestrator.
- Complex implementation/debugging: the complex worker.
- Small, local and low-risk changes: the fast worker.
- Even on small work, the orchestrator does not write code; it picks an economical worker.

The provider adapter maps the same capability tiers onto the real model identities of the relevant environment. Cases where the provider does not support model or subagent selection are not silently imitated; they are explicitly reported by `doctor`.

## 11. Context Handoff Architecture

### 11.1 The problem

A freshly started worker agent usually does not have the main session's context. Having the worker rescan the repository leads to:

- The same tokens being consumed again,
- Latency,
- Different agents reaching different conclusions,
- Orchestrator decisions being lost,
- Unnecessary tool calls.

At the other extreme, copying the entire conversation history to every worker is also expensive and distracts with unnecessary detail.

The goal is not to share all the context, but to share **the smallest evidenced context sufficient for the task**.

### 11.2 Context layers

Context is divided into four layers:

1. **Constitution context:** Immutable orchestration and security rules.
2. **Project context:** Stack, commands, architectural boundaries and verified project facts.
3. **Task context:** The user goal, the approved plan, the task scope and the acceptance criteria.
4. **Evidence context:** Relevant files, symbols, snippets, command output and previous worker reports.

A worker receives the necessary summary of the constitution, the relevant project slice, its own task context and only the required evidence.

### 11.3 The Task Context Packet

Every delegation must carry a schema'd task packet rather than a short free-form message:

```yaml
task_id: auth-refresh-fix-implementation
parent_task_id: auth-refresh-fix
assigned_role: implementer
model_tier: complex_worker

objective: >
  Fix the session loss that occurs during refresh token renewal.

why:
  user_goal: The user's active session must not close unexpectedly
  plan_reference: .ai/tasks/auth-refresh-fix/plan.md

scope:
  owned_paths:
    - src/auth/**
    - tests/auth/**
  read_paths:
    - src/session/**
  forbidden_paths:
    - src/billing/**

known_facts:
  - statement: Token rotation is active on the refresh operation
    source: src/auth/refresh-service.ts
    confidence: verified

decisions:
  - The public API contract will not change
  - No database migration will be created

relevant_symbols:
  - file: src/auth/refresh-service.ts
    symbols:
      - rotateRefreshToken
      - revokeTokenFamily

acceptance_criteria:
  - When an old refresh token is reused, the current token family is revoked
  - A normal renewal does not terminate the active session
  - The relevant tests pass

verification:
  commands:
    - pnpm test auth
    - pnpm typecheck

non_goals:
  - Redesigning the auth API
  - Changing the session storage layer

open_questions: []
expected_report:
  - root_cause
  - changed_files
  - decisions_made
  - commands_run
  - verification_results
  - unresolved_risks
```

### 11.4 Who produces the context packet?

The orchestrator compiles the task packet from the discovery outputs and the approved plan. The orchestrator is not expected to copy the raw conversation history to the worker.

The workflow:

```text
User conversation
      ↓
The orchestrator's canonical task ledger
      ↓
Task-specific context packet
      ↓
Worker
      ↓
Structured completion report
      ↓
Orchestrator task ledger update
```

### 11.5 The worker discovery budget

A full repository rescan by the worker is forbidden by default. However, for accuracy, it may verify critical information it was handed in place when needed.

The proposed policy:

- The context packet must be used first.
- Only files within the task scope should be read.
- If the context is insufficient, additional context should be requested from the orchestrator instead of running unbounded discovery.
- Small local verifications are allowed.
- A finding that changes the task scope requires escalation.
- Before a critical or hard-to-reverse operation, the source is re-verified.

This balance sits between the extremes of "the worker must not research anything" and "every worker must read everything from scratch".

### 11.6 Content or reference in the context packet?

Not every piece of information should be embedded directly in the packet:

- Short and critical decisions are added directly to the packet.
- Large files are given as path and symbol references.
- If a few sensitive lines of code are needed, a limited snippet is included.
- Large terminal outputs are summarized; the raw output is referenced as an artifact.
- Unchanging project context is linked to a versioned source rather than copied again.

### 11.7 Context freshness and provenance

Every packet must carry the following information:

```yaml
context:
  project_snapshot: project-api@sha256:...
  plan_version: 3
  created_at: 2026-09-20T00:00:00+03:00
  sources:
    - package.json
    - src/auth/refresh-service.ts
```

If the worker notices that the files its context is based on have changed significantly, it does not continue with the old decision; it goes back to the orchestrator.

### 11.8 Delta handoff

When follow-up work is given to the same worker, the entire packet is not sent again. The previous `task_id` is referenced and only the changes are handed over:

```yaml
extends: auth-refresh-fix-implementation
delta:
  new_acceptance_criteria:
    - Add a regression test for two concurrent refresh requests
  new_evidence:
    - tests/auth/refresh-race.test.ts
```

### 11.9 The worker completion packet

The worker's return must be schema'd as well:

```yaml
task_id: auth-refresh-fix-implementation
status: completed
summary: The refresh rotation race condition was resolved
changed_files:
  - src/auth/refresh-service.ts
  - tests/auth/refresh-service.test.ts
commands_run:
  - command: pnpm test auth
    result: passed
decisions_made: []
unresolved_risks: []
recommended_context_updates: []
```

The orchestrator records this report in the canonical task ledger and produces a new, narrowed context packet for the reviewer.

### 11.10 The provider adapter strategy

Providers may have different context-sharing capabilities:

- Forking the full conversation history
- Sharing the last few turns
- Starting a subagent with zero context
- Giving file or artifact references in the task prompt
- Reading shared workspace files

The default preference should be **zero/minimal inherited context + an explicit task packet**, rather than duplicating the entire history. For very context-heavy and short-lived work, sharing the last few turns may be chosen. A full history fork should be exceptional.

The adapter chooses the most economical method the provider supports, but the task packet contract does not change.

## 12. Project Discovery and Manual Synchronization

The implemented `sync` deterministically scans the project candidates and modules inside a repository or workspace. Module directories containing a manifest are discovered recursively; so that the normal depth limit does not cut off a typical Java source tree, the `src`, `test`, `tests` and generated source trees go through a separate, limited deep scan. Reaching a safety limit raises an explicit error instead of silently producing an incomplete snapshot.

For every module, the following verified evidence types are recorded together with their source path:

- `manifest`
- `language`
- `framework`
- `package_manager`
- `build_tool`
- `dependency`

JavaScript/TypeScript manifests and Maven and Gradle definitions are parsed; comments and coordinates that sit only under dependency/plugin management do not count as evidence of an active framework. Module commands are kept together with the `cwd` they must run in, their source and a `verified` confidence level.

```yaml
test:
  value: pnpm test
  cwd: frontend
  source: package.json
  confidence: verified
```

Every project registry records the eight canonical base skills:

- `planning`
- `project-discovery`
- `codebase-exploration`
- `implementation`
- `verification`
- `debugging`
- `code-review`
- `task-conductor`

Alongside these, a technology pack is selected only for matching verified evidence. The current pack → skill mappings:

| Pack | Generated skill |
| --- | --- |
| TypeScript | `typescript-patterns` |
| React | `react-patterns`, Ingenium `react-modern`, `frontend-craft` |
| Java | `java-patterns`, Ingenium `java-backend` |
| Spring Boot | `spring-boot-patterns` |
| JPA/Hibernate | `jpa-patterns`, Ingenium `db-schema-craft`, `query-tuning` |
| Maven | `maven-build` |
| Gradle | `gradle-build` |
| Express/Fastify/NestJS | Ingenium `node-backend` |
| Vue/Nuxt | Ingenium `vue-modern`, `frontend-craft` |
| Tailwind CSS | Ingenium `tailwind-v4-tokens` |

The selections, their rationale, source id and matched evidence are kept in `.ai/projects/<project-id>.skills.yaml`. Local technology skills are materialized under `.ai/skills/technology/**`, and the bundled pool under `.ai/skills/library/<source-id>/**`. `.ai/skills/catalog.yaml` carries the skill descriptions, the activation mode and the source provenance/license information. Automatic skills in the registry take priority; an `on-demand` skill is loaded only when its description matches the current task directly. The entire pool is never taken into context at once.

The first bundled source is a project-owned Ingenium snapshot containing 32 available skills and their script/reference files. Task Conductor was separated from that snapshot and made a canonical base skill. Anthropic Agent Skills, Superpowers and Microsoft Agent Skills are catalogued as `reference-only` sources with a repository URL, license and pinned commit id. External repository content is not automatically imported or executed without a separate security and license review.

Whenever `sync` sees any generated skill/catalog file that has been modified by the user, it stops; `sync --force` allows only that conflicting generated file to be refreshed with the canonical content.

The activation order is safe: the skill registry is written last, after the technology skill files, project records and the workspace record have been prepared. If one of the prerequisite writes fails, the previously active registry is preserved.

The implemented flow when a new repo is added:

```text
git clone
   ↓
syn sync
   ↓
deterministic discovery
   ↓
project record and skill resolution
   ↓
writing technology skills, records and the workspace
   ↓
activating the skill registry last
```

`doctor` validates end to end the workspace entries, the canonical `.ai/projects/<id>.yaml` records, the module directories, the manifest/source paths, the command `cwd` values, the skill registry schema, the canonical set of eight base skills, and the selected technology skill files. The checks cover both lexical traversal/absolute path variants and `realpath`-based symlink/junction escapes; the structure is not reported `healthy` while any missing, broken, duplicate or out-of-root reference exists.

## 13. Provider Compatibility and Boundaries

The shared structure targets the same behavioral semantics; it does not guarantee an identical technical execution model.

- The Codex adapter translates the shared roles into Codex's agent, skill and instruction mechanisms.
- The Claude Code adapter translates the same roles into the mechanisms Claude Code supports.
- Selecting the main model cannot be guaranteed by a markdown file alone; the session must actually be started with the right model.
- If the provider does not support per-subagent model selection, this gap is reported explicitly.
- Codex calling Claude models, or Claude Code calling OpenAI models, cannot be achieved with structure files alone. Such a requirement needs a separate runtime/bridge and is outside the current product scope.

## 14. Token and Time Optimization

- Root instructions are kept short.
- Skills are loaded only when triggered.
- Workers are sent a task packet, not the whole conversation.
- Project context is kept versioned and reusable.
- Large content is not copied; path/symbol/artifact references are used.
- Follow-up tasks use delta handoff.
- Small work is routed to the fast worker, complex work to the complex worker.
- Non-independent work is not artificially parallelized.
- Workers that would modify the same files are not started concurrently.
- Worker reports are schema'd; the orchestrator is not forced to re-summarize raw conversations.
- The canonical task ledger is preserved to prevent "summary of summary" information loss.

## 15. Open Design Decisions

Points still to be finalized:

1. The exact schema and file format of the canonical definitions.
2. Whether provider outputs are produced as copies, generated files or references.
3. How far the orchestrator's write prohibition can technically be enforced on each provider.
4. Whether task ledger and context packet files will be included in Git.
5. Token budgets and compression thresholds for context packets.
6. The exact limits of the local discovery a worker may do on its own.
7. Whether the user approval gate applies to every task or only to new top-level work.
8. How the reviewer model will be chosen based on risk level.
9. The shared working tree and worktree policy for multiple workers.
10. Conflict resolution between custom protocols and core protocols.
11. Official verification of the Codex and Claude Code feature matrix.

## 16. Proposed Design Order

1. The constitution and the main orchestration protocol
2. The protocol schema and priority system
3. The task lifecycle and the user approval gate
4. The context packet and completion packet schemas
5. The agent manifest standard
6. The skill standard
7. The model tier and routing policy
8. The verification/review protocol
9. The failure/retry/escalation protocol
10. The Codex capability adapter
11. The Claude Code capability adapter
12. The CLI `init`, `sync`, `inspect` and `doctor` commands

## 17. Success Criteria

The system should be considered successful if:

- The user can carry work through from start to finish by talking only to the orchestrator,
- The orchestrator can conclude the work without writing any implementation code,
- Every worker can start its task with only the context it needs,
- Workers do not rescan the repository unnecessarily,
- Model selection can be made according to a quality/cost balance,
- Plans, decisions, delegations and verification evidence are traceable,
- The same canonical structure can be reliably adapted to both Codex and Claude Code,
- Provider constraints are not hidden from the user.

## 18. Decision Log

### 2026-09-20 — Orchestration and model profiles

- The system will not be a standard coding assistant structure, but a hierarchical agent organization managed by a central orchestrator.
- The orchestrator will not write any product code; it will only do analysis, planning, decision-making, delegation, coordination and final reporting.
- The orchestrator will be able to create or update control-plane records only under `.ai/tasks/**`.
- Workers will operate on versioned task context packets prepared by the orchestrator instead of scanning the repository from scratch.
- Broad discovery will be done once, and the resulting evidence will be reused by multiple workers.
- Worker returns will be delivered to the orchestrator as structured completion packets.
- OpenAI initial profile: orchestrator `gpt-6-astra`, complex worker `gpt-5.6-sol`, fast worker `gpt-5.6-luna`.
- Claude initial profile: orchestrator `fable-5`, complex worker `opus-5`, fast worker `sonnet-5`.
- Model profiles will be configurable at the provider, workspace, project and session levels.
- Before the first task of every new session, the active model profile will be shown to the user and explicit approval will be taken.
- Session overrides will not change the canonical defaults unless the user explicitly asks to persist them.
- No silent fallback will occur when a model cannot be found or when the provider does not support the required routing capability.
- If the main orchestrator model cannot be changed within a session, the system will state this explicitly and, if necessary, ask for a new session to be started.

### 2026-09-20 — The Node.js CLI core

- The CLI will be developed as a Node.js 24+ and strict-TypeScript-based ESM application.
- pnpm will be used as the package manager.
- Source development and test runs will use Node 24's built-in TypeScript type-stripping support; no unnecessary runtime transpiler dependency will be carried.
- The `inspect`, `init`, `sync` and `doctor` commands were created in the first executable vertical slice.
- `inspect` shows the generation plan and file conflicts without writing.
- `init` preserves existing differing files by default; it updates them only with an explicit `--force`.
- `sync` records repository/project facts with their evidence sources on manual trigger.
- `doctor` validates the canonical structure, the model profiles, session confirmation and the silent-fallback prohibition.
- The generated structure includes the constitution, eight core protocols, five agent roles, eight canonical base skills including Task Conductor, a curated skill catalog, OpenAI/Claude model profiles, and the context/completion packet schemas.

### 2026-09-20 — Recursive discovery, the skill registry and path safety

- Manifest-based modules inside the repository are discovered recursively; nested `src`/test source trees are scanned with separate safety limits.
- Language, framework, package manager, build tool and dependency selections are made only through verified evidence carrying a source path.
- The eight base skills are kept canonical and complete in every project registry; technology skills are activated only with matching pack evidence.
- `sync` does not overwrite modified generated technology skills without an explicit `--force`, and writes the active skill registry last, after the prerequisite outputs.
- `doctor` validates reference integrity from the workspace down to the skill file, the canonical base set, module/command paths, and lexical + symlink/junction root containment rules.

### 2026-09-20 — Curated skill sources and the Ingenium pool

- Ingenium's project-owned snapshot of 32 skills and 35 files was turned into a bundled source with its supporting script/reference files preserved; Task Conductor was moved into an independent canonical base skill.
- Skill sources are catalogued with repository, revision, license and trust level; in generated projects the catalog is written as `.ai/skills/catalog.yaml`.
- React, Java, Node, Vue, JPA/Hibernate and Tailwind matches are activated automatically through verified repository evidence.
- Debugging, refactoring, documentation, release, performance, design, game and other specialist skills remain on-demand; the orchestrator does not load them without a description match.
- Anthropic Agent Skills, Superpowers and Microsoft Agent Skills were researched, recorded as `reference-only` with pinned commit ids, and automatic third-party code/instruction execution was left out of scope.
- Loading the entire source pool into context is forbidden; catalog metadata is used for cheap discovery, and `SKILL.md` plus supporting resources for progressive disclosure.

### 2026-09-21 — Proportional execution and the canonical Task Conductor

- Optimization is defined as reducing token/context cost and elapsed time together, while preserving the accuracy boundary.
- Every task is classified as `trivial`, `standard` or `high-risk` before execution; the tier is escalated if the scope or the findings change.
- Trivial work runs with one fast worker, a compact user-approved plan and claim-specific evidence; broad discovery, full-project checks, a reviewer and a browser are not the default.
- Standard work uses targeted checks and a reviewer only on material/boundary-crossing changes; high-risk work mandates a complex worker, comprehensive evidence and independent review.
- A headed browser may not be used unless the user requests it or separate approval is given for a named criterion that cheaper evidence cannot settle.
- Task Conductor was separated from the Ingenium snapshot and made the eighth canonical base skill; it provides central decomposition and just-in-time skill routing on non-trivial briefs.
- Skill state is separated into `available`, `active` through the project registry, and `loaded` in the task context; bootstrap does not scan the whole catalog.

### 2026-09-20 — Synorch packaging and release safety

- The product will be distributed on npm as the `synorch` package, with the `syn` and `synorch` executable aliases after installation.
- The first pre-stable version was defined as `0.1.0` with the Git tag `v0.1.0`; version history will be kept with Keep a Changelog and Semantic Versioning.
- Before every packaging run, typecheck, test and build pass through a mandatory `prepack` gate; package contents are restricted with an allowlist.
- The CI and npm publish workflows use read-only default permissions, pinned action commit SHAs, and a release-tag/version match check.
- The first npm release is done manually with 2FA; subsequent releases are performed through GitHub Actions via npm Trusted Publishing/OIDC without storing a token.
- The MIT license, a private security reporting channel, a changelog and human-focused release notes are part of the public distribution contract.

### 2026-09-22 — Skill Creator and the observation ledger

- The system will improve itself by distilling repeatedly confirmed project knowledge into skills, rather than generating skills on first contact with a project.
- No project skill is generated at bootstrap; the project record already holds verified facts, and generic procedure is already covered by the technology packs.
- Non-obvious discoveries are recorded as cheap, evidence-carrying observations in `.ai/tasks/observations.yaml`, which is Git-tracked and lives inside the orchestrator's only writable area.
- An observation is promoted to a proposed skill after three confirmations from distinct task ids; a user correction promotes immediately.
- Unpromoted observations expire after 90 days or 20 tasks without reconfirmation, so one-off incidents never become procedures.
- Skill authoring is delegated to an implementer and verified by an independent reviewer; no new agent role is introduced and the orchestrator write boundary is unchanged.
- `skill-creator` becomes the ninth canonical base skill.
- Generated skills live in `.ai/skills/project/**`, are never touched by `sync --force`, and carry their evidence, source digests and confirming task ids in frontmatter.
- Active project skills are capped at twelve, and each `SKILL.md` at 15KB; promotion beyond the cap requires retiring an existing skill first.
- A generated skill can never hold `constitutional` priority or override a core protocol; `doctor` enforces this as a prompt-injection defense.
- Skills are never auto-deleted. Staleness, non-use and supersession only ever produce a proposal.
- `doctor` treats contract violations as errors and shape heuristics as warnings; no new CLI command is introduced in the first slice.
- The observation ledger is Git-tracked while per-task working directories are not, which settles open decision §15.4.

### 2026-09-22 — Canonical content depth

- A measured audit of `syn init` output showed the generated core satisfies roughly a third of the agent and skill contracts defined in §8.1 and §8.2 of this document.
- Six required elements are satisfied by zero generated files: the skills an agent may use, its expected report format, its completion conditions, and a skill's required inputs, permitted tools and output contract.
- `task-conductor` is 3 694 bytes while the other seven canonical base skills total 3 021 bytes; an eleven-fold spread inside one category is treated as a defect, and `task-conductor` is adopted as the reference quality standard.
- Token budget is allocated per load frequency rather than uniformly: the unconditionally loaded entrypoint and constitution hold their current size, while agent manifests and base skills — which load conditionally and only when about to be used — grow to 3KB and 6KB ceilings respectively.
- Genuine depth beyond those ceilings goes into `references/` files that are fetched only when a procedure step needs them, rather than into the hot path.
- Skill frontmatter gains a `not_for` negative trigger, and agent frontmatter gains `allowed_skills` and `reports`, so §8.1 and §8.2 become machine-checkable by `doctor` instead of remaining prose.
- `doctor` treats contract violations as errors and size ceiling overruns as warnings.
- No new agent roles are introduced; five roles remain sufficient and the work is depth, not breadth.
- Canonical Agent Manifest v1 and Canonical Skill Contract v1 are shared prerequisites for both this work and the Skill Creator, and are built once before either.
