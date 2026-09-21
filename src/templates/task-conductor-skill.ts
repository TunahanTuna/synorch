export const taskConductorSkill = `---
name: task-conductor
description: Use as the orchestrator's central routing discipline for multi-part work. Decompose by dependency, load skills just in time, scale ceremony to risk, and stop verification at the cheapest sufficient evidence. Do not use the full conductor workflow for one-line or single-step fixes.
---

# Task Conductor

Read the complete brief before deciding how much process it needs. Optimize jointly for correctness, elapsed time and context cost. More ceremony is not more correctness when it does not reduce a concrete risk.

## Classify before decomposing

- **trivial**: one local, reversible change with no behavior, contract, dependency, security, data or architecture impact. Use one fast worker. Keep the approved plan to one compact paragraph. Do not create workstreams, run broad discovery, request independent review or open a browser. Verify the exact diff and the changed claim only.
- **standard**: bounded behavior spanning a few related files. Use the smallest capable worker set, focused discovery and targeted automated checks. Add independent review only when the diff is material or crosses a boundary.
- **high-risk**: security, authentication, payments, persistence, migrations, public contracts, concurrency, destructive operations or wide architectural impact. Use complex workers, explicit decomposition, strong verification and independent review.

Escalate the tier when scope expands, a check fails unexpectedly, verified facts contradict the plan or the change crosses a risk boundary. Record the reason. Never lower a tier merely to save cost.

## Conduct only when needed

For a multi-part brief:

1. Extract deliverables, actions, constraints, acceptance criteria and affected surfaces.
2. Trace existing code and contracts before designing. Do not invent layers the brief does not need.
3. Split into dependency-ordered workstreams. Each workstream has one goal, explicit ownership and one done-check.
4. Load zero to two genuinely matching skills per workstream, just in time. Available skills are not active or loaded skills.
5. Execute one dependency layer at a time. Parallelize only independent ownership.
6. Verify each acceptance claim with the cheapest sufficient evidence, then stop.

For a single-step fix, do the plain work plainly. A typo or literal text replacement needs no orchestra.

## Context economy

Start from the registered project snapshot and reuse verified evidence. Give workers minimal task packets, never the full conversation or the complete skill library. Load project-registered technology skills only when relevant to the owned work. Search the available catalog only when the current task has an unmet specialist need.

## Verification ladder

Use only as many rungs as the claim requires:

1. Exact diff, search, parse or other static evidence tied to the changed claim.
2. Narrow existing lint, typecheck, unit or component checks for the affected scope.
3. Broader build, integration or end-to-end checks when boundaries or behavior justify them.
4. Independent review for material standard work and all high-risk work.

Headed browser use is opt-in. Use it only when the user requested it, or when a named acceptance criterion cannot be settled by static, automated or structural evidence. In the latter case, explain the gap and obtain approval before opening a browser. Never create a browser or screenshot harness as a side effect of another task.

## Completion

Report what changed, which claims were verified, which checks were intentionally not run, loaded skills, defaults chosen and remaining uncertainty. An honestly bounded verification gap is better than an expensive unrelated check.
`;
