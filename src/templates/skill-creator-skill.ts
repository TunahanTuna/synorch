import type { FileDefinition } from "../domain/generation.ts";
import { createEmptyLedger } from "../domain/observation-ledger.ts";
import { stringifyYaml } from "../infrastructure/serialization.ts";

export const skillCreatorSkill = `---
name: skill-creator
description: Use at task completion to record non-obvious project discoveries as sourced observations, and to propose, author, review and activate a generated project skill once one observation has been confirmed by three distinct tasks or corrected by the user.
not_for: Mid-task use, first sessions, and cold repository scans. A trivial task may record observations but never proposes a skill.
version: 1.0.0
references:
  - references/observation-ledger.md
  - references/generated-skill-contract.md
  - references/retirement.md
---

# Skill Creator

The system earns a skill; it never assumes one. Observations are cheap and unattended. Promotion is rare, approved by the user, written by a worker and verified by an independent reviewer.

## When this applies

- At the end of a completed task, while writing the final report, for every worker completion packet.
- When the user corrects an approach ("not that way, this way"): record the observation and propose immediately.
- When \`doctor\` reports a stale, unused or superseded project skill and a natural pause has arrived.

## When it does not

- Mid-task. Recording is a completion step; proposing interrupts nothing that is still running.
- On a first session, or from a repository scan. Day one has facts, not procedures; the project record already holds the facts.
- For anything a bundled technology skill already covers, or for a discovery with no source path.
- Never propose more than one skill in one final report. If several are ready, take the highest \`count\` and leave the rest.

## Required inputs

- The completed task's id, and the worker completion packets with their \`commands_run\`, \`decisions_made\` and source paths.
- \`.ai/tasks/observations.yaml\` (the ledger) and the current contents of \`.ai/skills/project/\`.
- For a proposal: the user's explicit approval, and the active project-skill count.

## Procedure

1. **Qualify.** An observation must be non-obvious, repeatable and carry at least one source path. No source, no observation. Discard anything a bundled skill already states.
2. **Record.** Append or update the entry in \`.ai/tasks/observations.yaml\` — the orchestrator's only writable area, so this needs no constitutional change. Increment \`tasks_seen\` exactly once per completed task. Format and expiry: \`references/observation-ledger.md\`.
3. **Confirm.** Add the task id to \`confirmed_by\` only if it is not already there. The same task hitting the same wall twice counts once. Set \`count\` to the number of distinct ids and \`last_seen_task_index\` to \`tasks_seen\`.
4. **Decide.** At \`count\` 3, set \`status: ready-to-propose\`. A user correction sets \`origin: user-correction\` and is ready at once.
5. **Budget.** Before proposing, count \`status: active\` skills under \`.ai/skills/project/\`. At 12, propose a retirement first and let the user choose; do not propose an addition alongside it.
6. **Propose.** In the final report, state the claim, its sources and its confirming task ids, and ask. On approval continue; on refusal set \`status: declined\`, which is permanent — never ask again for that id.
7. **Author.** Delegate to an implementer: write \`.ai/skills/project/<id>/SKILL.md\` against the contract in \`references/generated-skill-contract.md\`.
8. **Review.** Delegate to an independent reviewer, never the author. The reviewer opens every \`source\`, confirms the claim it backs and recomputes its digest.
9. **Activate.** Only after the review passes, register the skill and set the observation to \`status: promoted\`.
10. **Maintain.** Apply the stale, unused and superseded signals from \`references/retirement.md\` at the next pause.

## Tools

File reads for sources; the ledger write; \`syn doctor\` for the contract, budget, size and digest checks; delegation to an implementer and a reviewer. No model call inside the CLI, and no external skill import.

## Verification

- \`syn doctor\` reports no \`generated.*\` error for the new skill.
- Every \`evidence\` entry names a file that exists inside the root and whose digest matches.
- The active project-skill count is at most 12 and the file is at most 15KB.
- The reviewer's report names each claim and the source it was checked against.

## Stop and escalate

- Stop if a claim cannot be traced to a source, if the reviewer rejects any claim, or if the author and the reviewer are the same worker.
- Stop if the proposal would exceed the budget without an approved retirement.
- Stop and ask if the content would belong in a protocol or the constitution. A generated skill holds \`priority: skill\` only; it never overrides a core protocol and never claims constitutional authority.
- Never delete a skill. Retirement is proposed, then moves the file to \`RETIRED.md\`.

## Output contract

Ledger entries are the ordinary output. A promotion additionally yields: one proposal paragraph in the final report; on approval, \`.ai/skills/project/<id>/SKILL.md\` with complete evidence frontmatter; a reviewer verdict per claim; a registry activation; and the observation moved to \`promoted\`.
`;

const observationLedgerReference = `# Observation Ledger

\`.ai/tasks/observations.yaml\` is Git-tracked and lives inside the orchestrator's writable area. Per-task working directories under \`.ai/tasks/\` are not tracked.

## Format

\`\`\`yaml
schema_version: 1
tasks_seen: 174
observations:
  - id: api-test-execution
    claim: >
      API tests must run with cwd services/api and
      TESTCONTAINERS_RYUK_DISABLED=true, or they fail on startup.
    kind: command-behavior
    sources:
      - path: services/api/package.json
        digest: sha256:9f2c1d3b4a5e6f70
      - path: .github/workflows/ci.yml
        digest: sha256:41ab5c6d7e8f9012
    confirmed_by: [task-141, task-156, task-173]
    count: 3
    origin: worker-discovery
    first_seen_at: 2026-09-14
    last_seen_at: 2026-09-22
    last_seen_task_index: 173
    status: ready-to-propose
\`\`\`

## Fields

- \`kind\` is one of \`command-behavior\`, \`convention\`, \`ordering-constraint\`, \`pitfall\`, \`boundary\`. It exists to make deduplication tractable: a new observation that shares a \`kind\` and a source path with an existing one updates it instead of adding a second entry.
- \`origin\` is \`worker-discovery\` or \`user-correction\`.
- \`status\` is one of \`collecting\`, \`ready-to-propose\`, \`proposed\`, \`promoted\`, \`declined\`, \`expired\`.
- \`digest\` is \`sha256:<hex>\` over the source file's bytes with line endings normalized to \`\\n\`. A prefix of at least 16 hex characters is accepted.
- \`count\` must equal the number of distinct ids in \`confirmed_by\`.

## The two counters

\`tasks_seen\` is a monotonic count of completed tasks. Increment it exactly once per completed task, in the same write that records or reconfirms observations. \`last_seen_task_index\` stores the value of \`tasks_seen\` at an observation's last confirmation.

That pair is what makes the task-based expiry rule decidable without a clock or a task history: an observation is \`20 tasks\` old when \`tasks_seen - last_seen_task_index >= 20\`.

## Expiry

An unpromoted observation expires 90 days after \`last_seen_at\` or 20 tasks after \`last_seen_task_index\`, whichever comes first. \`syn sync\` prunes expired entries and reports how many it removed. \`promoted\` and \`declined\` entries are never pruned: \`declined\` is permanent so the user is not asked twice.

A one-off oddity is not a procedure. Expiry is the structural immunity against a ledger that turns into an incident log.
`;

const generatedSkillContractReference = `# Generated Skill Contract

A generated skill lives at \`.ai/skills/project/<id>/SKILL.md\`. \`syn sync\` never writes, overwrites or deletes anything in that namespace, even with \`--force\`.

## Frontmatter

\`\`\`yaml
---
name: api-test-execution
description: How to run and debug the API test suite in this repository.
version: 1.0.0
priority: skill
origin: generated
status: active
generated_at: 2026-09-22
verified_at: 2026-09-22
confirmations: 3
promotion: threshold
confirmed_by: [task-141, task-156, task-173]
evidence:
  - claim: Tests require cwd services/api
    source: services/api/package.json
    digest: sha256:9f2c1d3b4a5e6f70
  - claim: TESTCONTAINERS_RYUK_DISABLED=true is required locally
    source: .github/workflows/ci.yml
    digest: sha256:41ab5c6d7e8f9012
supersedes: []
---
\`\`\`

\`promotion\` is \`threshold\` for the ordinary three-confirmation path, or \`user-correction\` for the fast path. It is the only way a skill may carry fewer than three confirmations, and it must be stated explicitly.

## Blocking rules

1. \`origin: generated\` requires a non-empty \`evidence\` list; every entry needs a \`claim\`, a \`source\` and a \`digest\`.
2. Every \`source\` exists and stays inside the root under both lexical and realpath checks.
3. \`priority\` is \`skill\`. \`constitutional\`, \`core\` and any protocol-level value are rejected.
4. \`SKILL.md\` is at most 15KB.
5. At most 12 project skills are \`active\`.
6. Every id in \`confirmed_by\` appears in the observation ledger.

## Body

The same sections every skill carries: When this applies, When it does not, Required inputs, Procedure, Tools, Verification, Stop and escalate, Output contract.

Write a repeatable procedure, not a story. Every factual claim in the body must be backed by an \`evidence\` entry; \`doctor\` warns on an unsourced path, on a missing activation condition and on past-tense incident narration.

## Authoring and review

The implementer writes the file. A different worker reviews it, opening each \`source\` and confirming the claim it backs before the orchestrator activates it. The orchestrator writes only the ledger and the registry entry — never the skill file itself.
`;

const retirementReference = `# Retirement

Nothing is ever deleted automatically. Every signal below produces a proposal at the next natural pause; the user decides.

## Signals

- **Stale.** A worker reports that a claim no longer holds, or \`doctor\` finds a \`source\` whose digest differs from the recorded one. Set \`status: stale\` immediately. A stale skill stops being loaded automatically, and re-verification is proposed.
- **Unused.** Not loaded in 60 days *and* 30 tasks. \`doctor\` warns; the orchestrator offers retirement.
- **Superseded.** A new proposal overlaps an existing skill on \`kind\` plus source paths. Propose a merge into the existing skill rather than a second skill, and record the lineage in \`supersedes\`.

## Executing an approved retirement

1. Move \`.ai/skills/project/<id>/SKILL.md\` to \`.ai/skills/project/<id>/RETIRED.md\`.
2. Drop the entry from the registry.
3. Leave the Git history alone. Nothing is deleted from it.

A retired skill frees a slot in the 12-skill budget. That budget is the only brake on accumulation, so retirement is a routine act, not a failure.
`;

const taskDirectoryIgnore = `# Per-task orchestrator working directories are local state, not shared history.
# The observation ledger is the exception: it is the distillation record and is tracked.
*
!.gitignore
!.gitkeep
!observations.yaml
`;

/**
 * Files the canonical \`skill-creator\` base skill needs. Integration spreads this into
 * \`createStructureFiles\`; keeping it here keeps the template self-contained.
 */
export const skillCreatorStructureFiles: readonly FileDefinition[] = [
  file(".ai/skills/skill-creator/SKILL.md", skillCreatorSkill, "skill"),
  file(
    ".ai/skills/skill-creator/references/observation-ledger.md",
    observationLedgerReference,
    "skill",
  ),
  file(
    ".ai/skills/skill-creator/references/generated-skill-contract.md",
    generatedSkillContractReference,
    "skill",
  ),
  file(".ai/skills/skill-creator/references/retirement.md", retirementReference, "skill"),
  file(".ai/tasks/observations.yaml", stringifyYaml(createEmptyLedger()), "canonical"),
  file(".ai/tasks/.gitignore", taskDirectoryIgnore, "canonical"),
];

/** Mirrors the private helper in structure-templates.ts; kept local so nothing private is imported. */
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
