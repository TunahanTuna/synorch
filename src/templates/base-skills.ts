import {
  evidenceLadderReference,
  hypothesisPatternsReference,
  riskClassificationReference,
  severityRubricReference,
} from "./skill-references.ts";
import { taskConductorSkill } from "./task-conductor-skill.ts";

/**
 * Canonical Skill Contract v1 documents for the base skills.
 *
 * Each `SKILL.md` carries the machine-checkable frontmatter defined in
 * `src/domain/canonical-contracts.ts` and the eight body sections the
 * architecture requires of a skill (§8.2). Depth that only a specific step
 * needs lives in `references/`, which costs nothing until it is opened.
 *
 * Adding a base skill is one entry in `BASE_SKILL_DOCUMENTS` plus its id in
 * `BASE_SKILLS` (`src/domain/skill-packs.ts`); nothing else counts them.
 */

export interface SkillReferenceDocument {
  /** File name under the owning skill's `references/` directory. */
  readonly fileName: string;
  readonly content: string;
}

export interface BaseSkillDocument {
  readonly id: string;
  readonly skill: string;
  readonly references: readonly SkillReferenceDocument[];
}

const planningSkill = `---
name: planning
description: Use before executing any new user brief, to turn it into a risk-classified plan with explicit ownership, acceptance criteria and a verification budget that the user can approve or reject.
version: 1.0.0
not_for: Do not use for an approved plan whose scope, tier and decisions are unchanged, and do not use it for step ordering inside a worker's own approved objective.
inputs:
  - The user brief and every clarification already given
  - The active project record and its skill registry
  - Existing task records for related or superseded work
tools:
  - File read, directory listing and symbol search
  - Control-plane writes under .ai/tasks/**
outputs: approved-plan
references:
  - references/risk-classification.md
---

# Planning

## When this applies

- A new brief arrives and no approved plan covers it.
- An approved plan's scope, risk tier or a material decision has changed.
- A worker escalated work the current plan does not authorize.

## When it does not

- The plan exists, is approved, and nothing about it changed.
- The real question is what existing code does; that is \`codebase-exploration\`.
- The brief is one step: state the change, the owner and the proof in a single paragraph and skip the rest of this procedure.

## Required inputs

- The brief verbatim, plus every clarification already given.
- The project record: languages, modules, commands and boundaries.
- Any prior task record this work supersedes or depends on.

Missing one of these, ask before planning. A plan built on assumed facts cannot be reviewed.

## Procedure

1. Restate the goal in one sentence and list the non-goals that bound it.
2. Classify the tier using \`.ai/protocols/core/orchestration.md\`; open \`references/risk-classification.md\` when the tier is unclear or contested.
3. Separate verified facts, assumptions and open questions; give every fact a source.
4. Ask only the questions whose answers change the plan; carry the rest as recorded assumptions.
5. Write acceptance criteria that name an observable outcome, never an activity.
6. Decompose into dependency-ordered workstreams, each with one goal, explicit owned paths and one done-check.
7. Assign a model tier and a verification budget per workstream, per \`.ai/protocols/core/model-routing.md\`.
8. Name the conditions that must return control to the user.
9. Present the plan and wait for explicit approval.

## Tools

Read-only across the product tree. The only write is the plan record under \`.ai/tasks/**\`. Planning never edits product files and never dispatches before approval.

## Verification

Walk four checks before presenting: every acceptance criterion is observable and owned; no two concurrent workstreams own the same path; every dependency points backwards; every stated fact names its source.

## Stop and escalate

Stop when the brief admits two materially different solutions with different costs, when the requested outcome conflicts with the constitution, when a required fact cannot be verified, or when the work needs authority the user has not granted. Present the choice; never choose silently.

## Output contract

An approved plan record holding: goal, non-goals, risk tier with justification, verified facts with sources, assumptions, workstreams with ownership and acceptance criteria, model tiers, verification budget, escalation conditions and the recorded approval.
`;

const projectDiscoverySkill = `---
name: project-discovery
description: Use to refresh a registered project's evidence-backed facts — languages, modules, package manager, commands and boundaries — after a manual sync or when the recorded snapshot no longer matches the repository.
version: 1.0.0
not_for: Do not use to answer a question about how specific code behaves, and never use it to invent structure for an empty or greenfield directory.
inputs:
  - The project root and the current project record, if one exists
  - Manifests, lockfiles, CI configuration and existing AI instruction files
tools:
  - File read, directory listing and manifest parsing
  - Control-plane writes to the project record and skill registry
outputs: project-record
---

# Project Discovery

## When this applies

- A project is registered for the first time.
- A manual sync was requested, or manifests changed since the last snapshot.
- A recorded command, module or stack fact no longer matches the tree.

## When it does not

- The question concerns one file, symbol or behavior; use \`codebase-exploration\`.
- The directory has no manifest and no source. Record an empty project and stop.
- The snapshot is current. Re-reading it is cheaper than rediscovering it.

## Required inputs

- The project root path and the scope it was registered under.
- The previous record, so the output can be reported as a delta.
- The directory traversal limits that apply to this repository.

## Procedure

1. Read existing AI instruction files first. They are claims about the project, recorded as claims rather than as facts.
2. Read manifests and lockfiles before any source file: \`package.json\`, \`pom.xml\`, \`build.gradle\`, \`pyproject.toml\`, \`go.mod\`, \`Cargo.toml\`.
3. Derive the package manager from the lockfile that exists, not from the one in common use.
4. Take commands only from declared scripts, tasks or wrappers. Never invent a command no file declares.
5. Read CI configuration to learn which of the declared commands are authoritative.
6. Treat every directory with its own manifest as a module, and record its path, stack and commands separately.
7. Record each fact with the source path that proves it; label anything inferred as a hypothesis.
8. Stop at the evidence boundary. Architecture, intent and conventions are not facts a manifest can prove.

## Tools

Read, list, search and manifest parsing. Writes are limited to the project record and the skill registry. Never install dependencies, never run a build, never reach the network.

## Verification

Re-running discovery on an unchanged tree must produce a byte-identical record. Every recorded command must appear verbatim in a file you can name, and every fact must carry a source path that exists.

## Stop and escalate

Stop before writing when two directories collapse to the same project id, when traversal hits a depth or directory-count limit, when a manifest cannot be parsed, or when declared commands contradict CI. Report the conflict; never write a truncated snapshot.

## Output contract

An updated project record and skill registry containing modules with paths, stack facts with \`source\` and \`confidence: verified\`, commands with their working directories, plus an explicit list of what changed since the previous snapshot and what remains a hypothesis.
`;

const explorationSkill = `---
name: codebase-exploration
description: Use to answer one specific, bounded question about existing code with paths, symbols and quoted evidence, before a plan is written or an implementer is dispatched.
version: 1.0.0
not_for: Do not use for an open-ended tour of a repository, for refreshing project-wide facts (that is project-discovery), or for a question the project record or existing task evidence already answers.
inputs:
  - One question and the shape its answer must take
  - The read scope, and the evidence already gathered for this task
tools:
  - File read, directory listing, symbol and literal search
  - Read-only inspection commands named in the packet
outputs: evidence-report
---

# Codebase Exploration

## When this applies

- A plan or a packet depends on a fact about the code that nobody has verified.
- A worker's assumption must be confirmed before an edit is authorized.
- A reviewer needs the surrounding code a diff does not show.

## When it does not

- The project record or a prior evidence report already answers it.
- The question is really "how should this be built?"; that is \`planning\`.
- The goal is to fix something. Exploration produces evidence, never edits.

## Required inputs

- One question, with the answer shape it requires.
- The read scope: paths in bounds, and paths out of bounds.
- Prior evidence for this task, so nothing is rediscovered.

## Procedure

1. Restate the question and what a sufficient answer looks like.
2. Check the project record and prior evidence; if the answer is there, return it with its provenance and stop.
3. Choose entry points: an exported symbol, a route, a UI literal, a configuration key, a failing test name.
4. Search by name and literal before opening files; open a file only when a hit implicates it.
5. Follow the chain in the direction the question needs — callers for impact, callees for behavior.
6. Quote the smallest excerpt that proves each claim, with \`path:line\`.
7. Record the conventions the surrounding code enforces and the risks a change here would face.
8. Stop at the first sufficient answer, and state what you did not look at.

## Tools

Read, list and search, plus read-only inspection commands the packet names. No writes of any kind, and no command that builds, installs or mutates state.

## Verification

Every claim traces to a quoted \`path:line\`. Nothing is labelled verified on the strength of a name or a comment. The answer matches the shape the question asked for, and a second reader could reach the same conclusion from the citations alone.

## Stop and escalate

Escalate when the question is ambiguous, when the answer requires a path outside the read scope, when the search budget is spent without converging, or when the code contradicts a fact the packet stated.

## Output contract

An evidence report: the question, the answer, verified facts with \`path:line\` provenance, inferences labelled as inferences, relevant conventions and risks, files inspected, unanswered questions and a confidence statement.
`;

const implementationSkill = `---
name: implementation
description: Use when an approved plan and a task packet exist, to make the smallest coherent product change that satisfies one objective inside its declared ownership and to prove it.
version: 1.0.0
not_for: Do not use without an approved objective and explicit ownership, to explore unfamiliar code (codebase-exploration), or to chase an unexplained failure (debugging).
inputs:
  - The objective, acceptance criteria and owned, readable and forbidden paths
  - Verification commands, the browser policy and verified facts with provenance
tools:
  - File edits limited to owned paths, and reads within the read scope
  - The verification commands named in the packet
outputs: completion-packet
---

# Implementation

## When this applies

- A packet grants one objective, explicit ownership and acceptance criteria.
- A follow-up delta packet extends an already approved objective.

## When it does not

- Ownership or criteria are missing or ambiguous. Ask first.
- The cause of the required behavior is unknown; that is \`debugging\`.
- The work is judging someone else's diff; that is \`code-review\`.

## Required inputs

- The objective and its acceptance criteria.
- Owned, readable and forbidden paths.
- Verification commands and the browser policy for this task.
- Verified facts and decisions, each with provenance.

## Procedure

1. Confirm objective, criteria and ownership are unambiguous; ask rather than guess.
2. Read the current content of every file you will change. Never edit from remembered or summarized content.
3. Match the file you are in: its naming, layering, error handling and test style are the local standard, whatever your own preference.
4. Change one behavior at a time, keeping the tree compiling or passing between units.
5. Verify incrementally at the cheapest sufficient rung of \`.ai/protocols/core/verification.md\`; do not batch every check to the end.
6. Add or update only the tests an acceptance criterion requires, and make each new test fail before the change.
7. Re-read the complete diff hunk by hunk, deleting anything the objective does not require.
8. Assemble the completion packet, including the checks deliberately skipped and the decisions taken.

## Tools

Edits limited to owned paths; reads limited to the read scope; the verification commands the packet names; the project's registered technology skills when they match the owned work. Never add a dependency, a tool or a browser harness as a side effect.

## Verification

Each criterion maps to named evidence. Every new test fails before the change and passes after it. The diff carries no unrelated formatting, no debug output and no file outside ownership. Every command is recorded with its outcome.

## Stop and escalate

Stop when the objective requires a forbidden path, when criteria conflict with the code, when a packet fact proves false, when a required check fails for a cause outside the objective, when the change is outgrowing the approved scope, or when the only remaining idea repeats an approach that already failed.

## Output contract

A completion packet matching \`.ai/schemas/completion-packet.schema.json\`: status, summary, changed_files, commands_run with outcomes, checks_skipped, loaded_skills, decisions_made and unresolved_risks.
`;

const verificationSkill = `---
name: verification
description: Use before any implementation is reported complete, to choose the cheapest evidence that actually proves each approved claim and to record what ran, what failed and what was deliberately skipped.
version: 1.0.0
not_for: Do not use to judge whether a change is a good idea (that is code-review), and do not use it to run checks unrelated to the approved claims.
inputs:
  - The approved acceptance criteria and the diff that claims to satisfy them
  - The verification commands and browser policy the packet allows
tools:
  - Diff, search and static inspection
  - The project's existing type, lint and test commands
outputs: verification-record
references:
  - references/evidence-ladder.md
---

# Verification

## When this applies

- A worker is about to report an objective complete.
- An orchestrator must judge whether a returned claim is supported.
- A reviewer must confirm that reported evidence proves what it claims.

## When it does not

- Nothing has changed yet. Verification proves claims, it does not explore.
- The claim is about taste or design; that is \`code-review\`.
- The evidence was produced and read in this same step and nothing has changed since.

## Required inputs

- Each approved acceptance criterion, stated as a claim.
- The diff, and the commands the packet authorizes.
- The risk tier, which sets whether independent review is required.

## Procedure

1. List the approved criteria; each becomes exactly one claim to prove.
2. For each claim, name the observation that would show it false.
3. Choose the lowest rung of \`.ai/protocols/core/verification.md\` that can produce that observation; \`references/evidence-ladder.md\` maps common claims to sufficient evidence.
4. Run the check exactly as recorded, and read its output rather than its exit code.
5. Confirm the check had subjects: a suite that matched zero tests proves nothing.
6. Stop at the first sufficient evidence for each claim; do not climb further for reassurance.
7. Record every command, working directory and outcome, plus every check not run and why.
8. Order independent review where the protocol requires it for this tier.

## Tools

Diff, search and static inspection; the type, lint and test commands the project already declares. A headed browser stays opt-in under the protocol, and no verification step may create test or browser infrastructure that did not exist.

## Verification

Verify the verification: every criterion has exactly one named evidence; no command was paraphrased; no pass is reported for a check that did not execute; the skipped list is explicit rather than implied.

## Stop and escalate

Escalate when a check fails for a cause outside the change, when no available evidence can settle a criterion, when proving a claim would require new infrastructure or a browser, or when the evidence contradicts the completion claim.

## Output contract

A verification record: claim to command to outcome, the rung reached for each claim, checks skipped with reasons, and an explicit statement naming any criterion that remains unproven.
`;

const debuggingSkill = `---
name: debugging
description: Use for a defect, a flaky test or an unexplained failure, to reach an evidenced root cause and land the smallest fix that removes the cause rather than the symptom.
version: 1.0.0
not_for: Do not use for a known change with a known cause (that is implementation), and do not use it to explore code that is not failing.
inputs:
  - The symptom, with the exact command, input or trigger that produces it
  - Expected versus actual behavior, and any prior failed attempt
tools:
  - Reproduction and verification commands from the packet
  - Temporary instrumentation, removed before completion
outputs: completion-packet
references:
  - references/hypothesis-patterns.md
---

# Debugging

## When this applies

- Observed behavior contradicts expected behavior and nobody can say why.
- A test fails intermittently, or fails only in one environment.
- A previous fix did not hold, or fixed the symptom and not the cause.

## When it does not

- The cause is already known and evidenced; implement the fix directly.
- Nothing is failing and the goal is understanding; use \`codebase-exploration\`.
- The failure is an unmet requirement rather than a defect; that is planning work.

## Required inputs

- The exact command, input or trigger, and its full output.
- Expected versus actual behavior, and when it last worked if known.
- Owned paths, verification commands and every attempt already made.

## Procedure

1. Reproduce the failure and record the exact command and output. If it will not reproduce, that is the first finding.
2. Reduce to a minimal failing case, and note the nearest case that does not fail.
3. Write ranked hypotheses, each naming a mechanism and predicting an observation; \`references/hypothesis-patterns.md\` holds the failure catalogue when the list looks thin.
4. Run the cheapest observation that would disprove the top hypothesis; discard hypotheses rather than defending them.
5. Name the root cause and the mechanism that turns it into the symptom.
6. Add a regression test that fails before the fix and passes after it.
7. Apply the smallest fix at the cause, then rerun the reproduction and the affected checks.
8. Remove all instrumentation and confirm the diff contains only the fix and its test.

## Tools

The reproduction and verification commands the packet names, search and read across the failing path, and temporary instrumentation that must not survive into the diff. Never widen a catch, a timeout or a tolerance to make a symptom disappear.

## Verification

The minimal case fails before the fix and passes after it, using the same command both times. The mechanism is stated in one sentence. You can explain why the defect did not surface earlier or elsewhere. No instrumentation, skipped test or debug output remains.

## Stop and escalate

Escalate when the failure will not reproduce, when the root cause lies outside the owned paths, when the fix would change a public contract or a data shape, or when two hypotheses remain and no available evidence separates them.

## Output contract

A completion packet matching \`.ai/schemas/completion-packet.schema.json\` with \`root_cause\` populated: the mechanism, the hypotheses disproved, the regression test, and the reproduction evidence before and after.
`;

const codeReviewSkill = `---
name: code-review
description: Use for independent review of a completed diff, to judge it against the approved task and its evidence and to return findings by severity with an explicit verdict.
version: 1.0.0
not_for: Do not use to review your own implementation, to review an unfinished change, or to enforce style the project does not already enforce.
inputs:
  - The approved plan, its acceptance criteria and the diff under review
  - The completion packet and the verification evidence it reports
tools:
  - Diff and file read across the changed area
  - Re-running the verification commands the packet reports
outputs: review-report
references:
  - references/severity-rubric.md
---

# Code Review

## When this applies

- A worker returned a completion packet for material standard or high-risk work.
- The change crosses a module, contract or security boundary.
- Reported evidence needs an independent party to confirm it.

## When it does not

- You wrote the diff. Independence is the point of this skill.
- The work is trivial under \`.ai/protocols/core/verification.md\` and its claim is settled by the diff itself.
- The change is still being written; review the finished diff.

## Required inputs

- The approved plan and the acceptance criteria it fixed.
- The complete diff, not a summary of it.
- The completion packet, with the commands it reports and their outcomes.

## Procedure

1. Read the approved criteria before the diff, so expectation precedes exposure.
2. Read every changed hunk, then the surrounding code that gives it meaning.
3. Map each acceptance criterion to the hunk and evidence that satisfies it; a criterion with no hunk is a blocking finding.
4. Work the checklist in \`references/severity-rubric.md\`: scope, criteria, edges, errors, boundaries, tests, evidence, leftovers.
5. Test the reported evidence — does the named command actually prove the claim it is attached to?
6. Classify each finding by the rubric's severities and drop anything with no stated consequence.
7. Issue one verdict: approved, approved with required follow-up, or rejected.

## Tools

Diff and file read across the changed area, and re-runs of the commands the packet already reports. Never edit the implementation, and never fix a finding yourself.

## Verification

Every acceptance criterion carries a verdict. Every blocking finding names a \`path:line\`, a mechanism and a consequence. The review rests on the diff rather than on the worker's summary, and the absence of blocking findings is stated explicitly rather than implied.

## Stop and escalate

Escalate when the diff exceeds the approved scope, when a criterion cannot be judged from the available evidence, when the change is unsafe for a reason outside the review brief, or when the packet reports a check that did not run.

## Output contract

A review report: verdict, findings ordered by severity with \`path:line\` and consequence, criteria judged satisfied and unsatisfied, evidence re-run with outcomes, and an explicit statement when no blocking finding exists.
`;

export const BASE_SKILL_DOCUMENTS: readonly BaseSkillDocument[] = [
  {
    id: "planning",
    skill: planningSkill,
    references: [
      { fileName: "risk-classification.md", content: riskClassificationReference },
    ],
  },
  { id: "project-discovery", skill: projectDiscoverySkill, references: [] },
  { id: "codebase-exploration", skill: explorationSkill, references: [] },
  { id: "implementation", skill: implementationSkill, references: [] },
  {
    id: "verification",
    skill: verificationSkill,
    references: [{ fileName: "evidence-ladder.md", content: evidenceLadderReference }],
  },
  {
    id: "debugging",
    skill: debuggingSkill,
    references: [
      { fileName: "hypothesis-patterns.md", content: hypothesisPatternsReference },
    ],
  },
  {
    id: "code-review",
    skill: codeReviewSkill,
    references: [{ fileName: "severity-rubric.md", content: severityRubricReference }],
  },
  { id: "task-conductor", skill: taskConductorSkill, references: [] },
];
