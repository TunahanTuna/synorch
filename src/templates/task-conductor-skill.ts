export const taskConductorSkill = `---
name: task-conductor
description: Use as the orchestrator's central routing discipline for multi-part work. Decompose by dependency, load skills just in time, scale ceremony to risk, and stop verification at the cheapest sufficient evidence.
version: 1.1.0
not_for: Do not use the conductor workflow for a one-line or single-step fix, for work already decomposed into an approved task graph, or inside a worker dispatch — a worker conducts nothing.
inputs:
  - The complete brief, read in full before any process is chosen
  - The registered project snapshot, skill registry and active generated-skill metadata for the active project
  - The risk tier, or the facts needed to classify it
tools:
  - File read, directory listing and symbol search
  - Frontmatter-only discovery of generated project skills and just-in-time skill loading
  - Control-plane writes under .ai/tasks/**
outputs: approved-plan
---

# Task Conductor

Read the complete brief before deciding how much process it needs. Optimize jointly for correctness, elapsed time and context cost. More ceremony is not more correctness when it does not reduce a concrete risk.

## When this applies

- A brief carries several deliverables, or spans more than one concern, module or owner.
- Work must be ordered by dependency before anyone can be dispatched.
- A workstream needs a specialist skill and it is unclear which one.

## When it does not

- A one-line or single-step fix. A typo or a literal replacement needs no orchestra.
- An approved task graph already exists and nothing about it changed.
- You are the worker. Conducting is the orchestrator's authority, not a worker's.

## Required inputs

- The brief in full, including constraints and acceptance criteria the user stated.
- The project snapshot: modules, commands, boundaries and registered skills.
- Existing task evidence, so no workstream rediscovers what is already verified.

## Ceremony by tier

Classify with \`.ai/protocols/core/orchestration.md\`, then spend accordingly.

- **trivial**: one fast worker. Keep the approved plan to one compact paragraph. Do not create workstreams, run broad discovery, request independent review or open a browser. Verify the exact diff and the changed claim only.
- **standard**: the smallest capable worker set, focused discovery and targeted automated checks. Add independent review only when the diff is material or crosses a boundary.
- **high-risk**: complex workers, explicit decomposition, strong verification and independent review.

Escalate the tier when scope expands, a check fails unexpectedly, verified facts contradict the plan, or the change crosses a risk boundary. Record the reason. Never lower a tier merely to save cost.

## Procedure

1. Extract deliverables, actions, constraints, acceptance criteria and affected surfaces.
2. Trace existing code and contracts before designing. Do not invent layers the brief does not need.
3. Split into dependency-ordered workstreams. Each has one goal, explicit ownership and one done-check.
4. Load zero to two genuinely matching skills per workstream, just in time. Available skills are not active or loaded skills. Discover \`.ai/skills/project/*/SKILL.md\` through frontmatter metadata only; consider only \`status: active\`, and load a generated skill's body only when its metadata matches the workstream. Never auto-load \`proposed\`, \`stale\` or \`retired\` skills.
5. Execute one dependency layer at a time. Parallelize only independent ownership.
6. Verify each acceptance claim with the cheapest sufficient evidence, then stop.

## Context economy

Start from the registered project snapshot and reuse verified evidence. Give workers minimal task packets, never the full conversation or the complete skill library. Load project-registered technology skills only when relevant to the owned work. Treat generated project skills as a separate, frontmatter-discovered namespace rather than registry entries. Search the available catalog only when the current task has an unmet specialist need.

## Tools

Read, list and search across the product tree; frontmatter-only generated-skill discovery; just-in-time body loading from active matches, registry and then catalog; control-plane writes under \`.ai/tasks/**\`. The conductor never edits product files and never dispatches work the user has not approved.

## Verification

Climb only as far as \`.ai/protocols/core/verification.md\` requires for the tier, and stop at the first sufficient evidence. The decomposition itself is sound when every workstream has one owner, no two concurrent workstreams own the same path, every dependency points backwards, and every acceptance claim names the evidence that will settle it.

## Stop and escalate

Return to the user when the brief admits two materially different approaches, when a workstream needs authority the plan did not grant, when two workstreams contend for the same files, or when a named acceptance criterion cannot be settled by static, automated or structural evidence — in that last case explain the gap and obtain approval before opening a browser. Never create a browser or screenshot harness as a side effect of another task.

## Output contract

A dependency-ordered task graph: workstreams with owner, model tier, owned paths, acceptance criteria, loaded skills and done-check, plus the risk tier and its justification. On completion, report what changed, which claims were verified, which checks were intentionally not run, loaded skills, defaults chosen and remaining uncertainty. An honestly bounded verification gap is better than an expensive unrelated check.
`;
