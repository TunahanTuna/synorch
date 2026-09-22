import type { FileDefinition } from "../domain/generation.ts";
import type { StructureScope } from "../domain/config.ts";
import { SYNORCH_GENERATOR_NAME, SYNORCH_VERSION } from "../domain/product.ts";
import { stringifyYaml } from "../infrastructure/serialization.ts";
import { AGENT_DOCUMENTS } from "./agent-manifests.ts";
import { BASE_SKILL_DOCUMENTS } from "./base-skills.ts";

export function createStructureFiles(scope: StructureScope): readonly FileDefinition[] {
  return [
    file("AGENTS.md", codexEntrypoint, "entrypoint"),
    file("CLAUDE.md", claudeEntrypoint, "entrypoint"),
    file(
      ".ai/manifest.yaml",
      stringifyYaml({
        schema_version: 1,
        generator: { name: SYNORCH_GENERATOR_NAME, version: SYNORCH_VERSION },
        scope,
        routing: {
          mode: "automatic",
          require_session_confirmation: true,
          silent_fallback: false,
        },
        model_profiles: {
          openai: ".ai/model-profiles/openai.yaml",
          claude: ".ai/model-profiles/claude.yaml",
        },
      }),
      "canonical",
    ),
    file(
      ".ai/workspace.yaml",
      stringifyYaml({ schema_version: 1, scope, projects: [] }),
      "canonical",
    ),
    file(".ai/constitution.md", constitution, "canonical"),
    file(".ai/protocols/registry.yaml", protocolRegistry, "canonical"),
    file(".ai/protocols/core/orchestration.md", orchestrationProtocol, "protocol"),
    file(".ai/protocols/core/planning-and-approval.md", planningProtocol, "protocol"),
    file(".ai/protocols/core/delegation.md", delegationProtocol, "protocol"),
    file(".ai/protocols/core/model-routing.md", modelRoutingProtocol, "protocol"),
    file(".ai/protocols/core/context-handoff.md", contextHandoffProtocol, "protocol"),
    file(".ai/protocols/core/verification.md", verificationProtocol, "protocol"),
    file(".ai/protocols/core/failure-recovery.md", failureRecoveryProtocol, "protocol"),
    file(".ai/protocols/core/user-communication.md", userCommunicationProtocol, "protocol"),
    ...AGENT_DOCUMENTS.map((agent) =>
      file(`.ai/agents/${agent.id}/AGENT.md`, agent.manifest, "agent"),
    ),
    ...BASE_SKILL_DOCUMENTS.flatMap((skill) => [
      file(`.ai/skills/${skill.id}/SKILL.md`, skill.skill, "skill"),
      ...skill.references.map((reference) =>
        file(
          `.ai/skills/${skill.id}/references/${reference.fileName}`,
          reference.content,
          "reference",
        ),
      ),
    ]),
    file(".ai/model-profiles/openai.yaml", openAiProfile, "canonical"),
    file(".ai/model-profiles/claude.yaml", claudeProfile, "canonical"),
    file(".ai/schemas/context-packet.schema.json", contextPacketSchema, "schema"),
    file(".ai/schemas/completion-packet.schema.json", completionPacketSchema, "schema"),
    file(".ai/providers/codex.md", codexAdapter, "provider"),
    file(".ai/providers/claude-code.md", claudeAdapter, "provider"),
    file(".ai/tasks/.gitkeep", "", "canonical"),
  ];
}

function file(
  relativePath: string,
  content: string,
  kind: FileDefinition["kind"],
): FileDefinition {
  return {
    relativePath,
    content: content.length === 0 || content.endsWith("\n") ? content : `${content}\n`,
    kind,
  };
}

const codexEntrypoint = `# Codex Orchestration Entrypoint

This session is the orchestrator. Read \`.ai/constitution.md\` and the applicable core protocols before acting.

## Mandatory session bootstrap

Before the first task:

1. Read \`.ai/manifest.yaml\` and \`.ai/model-profiles/openai.yaml\`.
2. Show the active orchestrator, complex-worker and fast-worker models, routing mode, fallback policy and override source.
3. Ask the user whether to continue with or change that profile.
4. Do not begin discovery or planning until the user confirms.
5. For the active project, read its record from \`.ai/workspace.yaml\`, then read the referenced \`skill_registry\`.
6. Treat registry entries as active, catalog entries as merely available, and skill contents as unloaded until the current work requires them. Do not scan or load the whole catalog during bootstrap.
7. For a non-trivial brief, load \`.ai/skills/task-conductor/SKILL.md\` as the central decomposition and routing discipline. For a one-line or single-step fix, keep the workflow trivial and do not create an orchestra.
8. Load any additional base, technology or on-demand skill just in time and only when its description genuinely matches the owned work.

## Non-negotiable behavior

- Never write or edit product code, tests, project configuration or project documentation yourself.
- You may write control-plane artifacts only under \`.ai/tasks/**\`.
- Plan every new task and obtain user approval before execution.
- Delegate all implementation to worker agents.
- Give each worker a minimal, evidence-backed task context packet.
- Match verification cost to explicit risk. Trivial work uses exact diff and claim-specific evidence without an independent reviewer. Material standard and high-risk work require independent review.
- Headed browser verification is opt-in: use it only when the user requested it or after approval for a named criterion that cheaper evidence cannot settle.
- Only the orchestrator communicates with the user.

If the host cannot provide the configured model or worker delegation capability, report the limitation. Never silently fall back or implement the work yourself.
`;

const claudeEntrypoint = `# Claude Code Orchestration Entrypoint

This session is the orchestrator. Read \`.ai/constitution.md\` and the applicable core protocols before acting.

## Mandatory session bootstrap

Before the first task:

1. Read \`.ai/manifest.yaml\` and \`.ai/model-profiles/claude.yaml\`.
2. Show the active orchestrator, complex-worker and fast-worker models, routing mode, fallback policy and override source.
3. Ask the user whether to continue with or change that profile.
4. Do not begin discovery or planning until the user confirms.
5. For the active project, read its record from \`.ai/workspace.yaml\`, then read the referenced \`skill_registry\`.
6. Treat registry entries as active, catalog entries as merely available, and skill contents as unloaded until the current work requires them. Do not scan or load the whole catalog during bootstrap.
7. For a non-trivial brief, load \`.ai/skills/task-conductor/SKILL.md\` as the central decomposition and routing discipline. For a one-line or single-step fix, keep the workflow trivial and do not create an orchestra.
8. Load any additional base, technology or on-demand skill just in time and only when its description genuinely matches the owned work.

## Non-negotiable behavior

- Never write or edit product code, tests, project configuration or project documentation yourself.
- You may write control-plane artifacts only under \`.ai/tasks/**\`.
- Plan every new task and obtain user approval before execution.
- Delegate all implementation to worker agents.
- Give each worker a minimal, evidence-backed task context packet.
- Match verification cost to explicit risk. Trivial work uses exact diff and claim-specific evidence without an independent reviewer. Material standard and high-risk work require independent review.
- Headed browser verification is opt-in: use it only when the user requested it or after approval for a named criterion that cheaper evidence cannot settle.
- Only the orchestrator communicates with the user.

If the host cannot provide the configured model or worker delegation capability, report the limitation. Never silently fall back or implement the work yourself.
`;

const constitution = `# AI Development Constitution

## Mission

Deliver correct, verified work with the smallest sufficient context and an explicit chain of responsibility.

## Constitutional invariants

1. The user communicates only with the orchestrator.
2. The orchestrator analyzes, decides, plans, delegates, monitors and reports; it never implements product changes.
3. Every new task requires a user-approved plan before execution.
4. All product changes are owned by a worker agent with explicit file or responsibility boundaries.
5. Workers receive task-specific context packets instead of raw conversation history.
6. A worker does not repeat broad repository discovery already captured as evidence.
7. Implementation requires evidence-based verification and independent review proportional to risk.
8. Missing capabilities, unavailable models and failures are surfaced; silent fallback is forbidden.
9. Lower-priority protocols, agents and skills cannot override this constitution.
10. Provider safety and system instructions always take precedence.
`;

const protocolRegistry = `schema_version: 1
protocols:
  - id: core.orchestration
    path: .ai/protocols/core/orchestration.md
    priority: constitutional
    mandatory: true
  - id: core.planning-and-approval
    path: .ai/protocols/core/planning-and-approval.md
    priority: core
    mandatory: true
  - id: core.delegation
    path: .ai/protocols/core/delegation.md
    priority: core
    mandatory: true
  - id: core.model-routing
    path: .ai/protocols/core/model-routing.md
    priority: core
    mandatory: true
  - id: core.context-handoff
    path: .ai/protocols/core/context-handoff.md
    priority: core
    mandatory: true
  - id: core.verification
    path: .ai/protocols/core/verification.md
    priority: core
    mandatory: true
  - id: core.failure-recovery
    path: .ai/protocols/core/failure-recovery.md
    priority: core
    mandatory: true
  - id: core.user-communication
    path: .ai/protocols/core/user-communication.md
    priority: core
    mandatory: true
`;

const orchestrationProtocol = `---
id: core.orchestration
version: 1.1.0
priority: constitutional
mandatory: true
overridable: false
---

# Orchestration Protocol

Required lifecycle:

\`SESSION_BOOTSTRAP → MODEL_PROFILE_CONFIRMATION → INTAKE → RISK_CLASSIFICATION → PLAN → USER_APPROVAL → DISPATCH → PROPORTIONAL_VERIFICATION → FINAL_REPORT\`.

Classify work before expanding the workflow:

- \`trivial\`: one local, reversible change without behavior, contract, dependency, security, data or architecture impact.
- \`standard\`: bounded behavior across a small related surface.
- \`high-risk\`: security, authentication, payments, persistence, migrations, public contracts, concurrency, destructive operations or wide architecture.

Discovery, clarification, decomposition, monitoring and independent review are conditional tools, not mandatory ceremony. Use them only when risk, uncertainty or dependency structure justifies them. User approval, delegated product mutation and evidence for completion remain mandatory.

The orchestrator may read project files and write only task-control records under \`.ai/tasks/**\`. Every product mutation is delegated. Worker questions return to the orchestrator; only material decisions are escalated to the user.
`;

const planningProtocol = `---
id: core.planning-and-approval
version: 1.1.0
priority: core
mandatory: true
---

# Planning and Approval

Before execution, present the understood goal, risk tier, proposed approach, ownership and verification budget. Wait for explicit user approval. Re-open approval when scope, tier or a material decision changes.

For trivial work, use one compact paragraph: exact change, one fast worker, owned path and claim-specific proof. Do not invent workstreams, broad discovery or a reviewer. Standard plans include affected areas, focused discovery and targeted checks. High-risk plans include dependencies, failure modes, independent review and rollback or recovery where relevant.
`;

const delegationProtocol = `---
id: core.delegation
version: 1.0.0
priority: core
mandatory: true
---

# Delegation

Give every worker one bounded objective, explicit ownership, constraints, acceptance criteria and an expected report contract. Parallelize only independent tasks. Workers are not alone in the codebase and must not revert or overwrite other workers' changes. Shared-file ownership requires serialization or an explicit integration owner.
`;

const modelRoutingProtocol = `---
id: core.model-routing
version: 1.1.0
priority: core
mandatory: true
---

# Model Routing

Use the active provider profile and the classified risk:

- Trivial work uses exactly one fast worker unless the required capability is unavailable.
- Standard work uses the smallest capable worker set; prefer a fast worker for local edits and a complex worker for non-local reasoning.
- High-risk work uses complex workers for implementation or debugging and an independent reviewer.

The orchestrator owns architecture and final decisions but never implementation. Use Task Conductor as the central decomposition and skill-routing discipline for non-trivial briefs. Do not silently substitute unavailable models. Session overrides do not become persistent defaults unless the user explicitly requests it.
`;

const contextHandoffProtocol = `---
id: core.context-handoff
version: 1.0.0
priority: core
mandatory: true
---

# Context Handoff

Prefer minimal inherited history plus an explicit task context packet. Include objective, rationale, owned/read/forbidden scope, verified facts with provenance, decisions, relevant files and symbols, acceptance criteria, verification commands, non-goals and escalation conditions.

Workers may inspect target files and narrowly verify critical facts, but must not repeat broad discovery. Missing context is requested from the orchestrator. Follow-up work uses a delta packet. Worker output follows the completion-packet schema.
`;

const verificationProtocol = `---
id: core.verification
version: 1.1.0
priority: core
mandatory: true
---

# Verification

No task is complete without evidence, but unrelated checks do not increase correctness. Stop at the cheapest evidence that proves the approved claim:

1. Exact diff, search, parse or static inspection tied to the change.
2. Narrow existing lint, typecheck, unit or component checks for the affected scope.
3. Broader build, integration or end-to-end checks only when behavior or boundaries justify them.
4. Independent review for material standard work and all high-risk work.

Trivial work must not trigger a full-project lint, build, test suite, independent reviewer or browser unless the change itself invalidates that rule. Record exact commands and outcomes, including intentionally skipped checks. Never claim a check ran when it did not.

Headed browser verification is opt-in. Use it only when the user requested it, or when a named acceptance criterion cannot be resolved by static, automated or structural evidence. In the latter case, explain the gap and obtain approval first. Never create browser automation or screenshot infrastructure as an incidental verification step.
`;

const failureRecoveryProtocol = `---
id: core.failure-recovery
version: 1.0.0
priority: core
mandatory: true
---

# Failure, Retry and Escalation

On failure, preserve evidence, classify the cause and retry only with a materially changed hypothesis or instruction. Do not loop. Scope changes, stale context, ownership conflicts, unavailable capabilities and user decisions return to the orchestrator. The orchestrator never takes over implementation as a recovery mechanism.
`;

const userCommunicationProtocol = `---
id: core.user-communication
version: 1.0.0
priority: core
mandatory: true
---

# User Communication

Only the orchestrator speaks to the user. Lead with outcomes and decisions. Ask only for choices that materially affect scope or result. Plans and final reports include model routing and verification evidence without exposing unnecessary internal chatter.
`;

const openAiProfile = `schema_version: 1
provider: openai
defaults:
  orchestrator: gpt-6-astra
  complex_worker: gpt-5.6-sol
  fast_worker: gpt-5.6-luna
`;

const claudeProfile = `schema_version: 1
provider: claude
defaults:
  orchestrator: fable-5
  complex_worker: opus-5
  fast_worker: sonnet-5
`;

const codexAdapter = `# Codex Adapter

- Root entrypoint: \`AGENTS.md\`
- Canonical profile: \`.ai/model-profiles/openai.yaml\`
- Prefer explicit task packets over full-history forks.
- Select worker model tiers only when the host supports per-agent model selection.
- If configured models or delegation are unavailable, stop and report the capability mismatch.
`;

const claudeAdapter = `# Claude Code Adapter

- Root entrypoint: \`CLAUDE.md\`
- Canonical profile: \`.ai/model-profiles/claude.yaml\`
- Prefer explicit task packets over copying the full conversation into subagents.
- Select worker model tiers only when the host supports per-agent model selection.
- If configured models or delegation are unavailable, stop and report the capability mismatch.
`;

const contextPacketSchema = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Task Context Packet",
    type: "object",
    additionalProperties: false,
    required: [
      "task_id",
      "assigned_role",
      "model_tier",
      "risk_tier",
      "objective",
      "scope",
      "acceptance_criteria",
      "verification_commands",
      "review_required",
      "browser_policy",
      "loaded_skills",
      "expected_report",
    ],
    properties: {
      task_id: { type: "string", minLength: 1 },
      parent_task_id: { type: ["string", "null"] },
      assigned_role: { type: "string", minLength: 1 },
      model_tier: { enum: ["complex_worker", "fast_worker"] },
      risk_tier: { enum: ["trivial", "standard", "high-risk"] },
      review_required: { type: "boolean" },
      browser_policy: { enum: ["disabled", "ask-first", "user-approved"] },
      loaded_skills: { type: "array", items: { type: "string", minLength: 1 } },
      objective: { type: "string", minLength: 1 },
      rationale: { type: "string" },
      scope: {
        type: "object",
        required: ["owned_paths", "read_paths", "forbidden_paths"],
        properties: {
          owned_paths: { type: "array", items: { type: "string" } },
          read_paths: { type: "array", items: { type: "string" } },
          forbidden_paths: { type: "array", items: { type: "string" } },
        },
      },
      known_facts: { type: "array", items: { type: "object" } },
      decisions: { type: "array", items: { type: "string" } },
      relevant_symbols: { type: "array", items: { type: "object" } },
      acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
      verification_commands: { type: "array", items: { type: "string" } },
      non_goals: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
      expected_report: { type: "array", minItems: 1, items: { type: "string" } },
      context_version: { type: "integer", minimum: 1 },
    },
  },
  null,
  2,
);

const completionPacketSchema = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Worker Completion Packet",
    type: "object",
    additionalProperties: false,
    required: [
      "task_id",
      "status",
      "summary",
      "changed_files",
      "commands_run",
      "checks_skipped",
      "loaded_skills",
      "unresolved_risks",
    ],
    properties: {
      task_id: { type: "string", minLength: 1 },
      status: { enum: ["completed", "failed", "needs_context", "blocked"] },
      summary: { type: "string" },
      root_cause: { type: ["string", "null"] },
      changed_files: { type: "array", items: { type: "string" } },
      commands_run: { type: "array", items: { type: "object" } },
      checks_skipped: { type: "array", items: { type: "string" } },
      loaded_skills: { type: "array", items: { type: "string", minLength: 1 } },
      decisions_made: { type: "array", items: { type: "string" } },
      unresolved_risks: { type: "array", items: { type: "string" } },
      recommended_context_updates: { type: "array", items: { type: "string" } },
    },
  },
  null,
  2,
);
