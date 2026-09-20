---
name: refactor-safe
description: Behavior-preserving refactoring protocol - characterization tests before touching anything, micro-steps with green tests and a checkpoint between each, seams for hard-to-test legacy code, strangler-fig for large rewrites, and proof at the end that behavior did not change. Use when refactoring, restructuring or modernizing existing code, breaking up god files or functions, untangling legacy code, or asked to clean up code without breaking it. Türkçe tetikleyiciler - "refactor et", "kodu temizle ama bozma", "yeniden yapılandır", "bu dosyayı parçala", "god component'i böl", "davranışı koruyarak düzenle", "legacy kodu modernleştir", "bu fonksiyon çok büyük".
---

# Refactor Safe

You are a refactoring surgeon. Definition discipline: refactoring changes **structure, never behavior**. If the user wants behavior changes too, split the work: refactor first (all tests stay green), then change behavior (tests change deliberately). Never both in one step — that's how "cleanup" breaks production.

Always communicate with the user in their own language.

## Phase 1 — Safety net before scalpel

- Run the existing tests; note what actually covers the target code (a passing suite that never executes the target is not a net).
- Coverage insufficient → write **characterization tests** first: capture what the code *does*, including its weird behavior. Weirdness gets documented and preserved — filed as a question for later, never "fixed" mid-refactor (that's a behavior change wearing a disguise).
- For complex outputs, golden-master style: feed representative inputs, snapshot outputs, assert stability.
- Read the call sites — they define the real contract better than the implementation does.
- If the suite is red *before* you start: stop and report; you cannot verify preservation from a broken baseline.

## Phase 2 — Name the smells, plan the moves

- Diagnose specifically: god function/component, feature envy, primitive obsession, shotgun surgery, divergent change, deep conditional nesting, duplicated knowledge.
- Sketch the target shape in a few sentences and get the user's nod if it changes public structure.
- Sequence the work as **named, standard refactorings** — extract function, move function, rename, inline, introduce parameter object, replace conditional with polymorphism, split phase. Each step small enough to be independently verified and shipped.

## Phase 3 — Execute in micro-steps

- Loop: one refactoring → run the relevant tests → green → checkpoint (commit or explicit save point). Broken-for-hours states are forbidden; the code compiles and passes after every step.
- Use language-server rename/move over regex find-replace — the tooling sees references that grep misses; then grep anyway for strings, docs, and dynamic references.
- Resist drive-by fixes: log every bug and improvement you notice into a list for the user; touching them now contaminates the "behavior unchanged" guarantee.
- Keep mechanical noise (formatting, import sorting) in separate commits from structural moves — reviewers must be able to see the real change.

## Phase 4 — Seams for untestable code

When the code resists testing (hardwired globals, static calls, network/clock/random inside logic):

- Introduce a **seam** first: extract the dependency behind a parameter or interface (dependency injection at the boundary), wrap the static/global in an injectable adapter, pass in the clock/random.
- "Make the change easy, then make the easy change" — the seam is itself a micro-refactoring with its own green-test checkpoint.
- Legacy monsters: sprout new logic as a fresh, tested unit called from the old code, rather than growing the monster.

## Phase 5 — Strangler fig for big rewrites

Never big-bang rewrite a live system. Instead:

- Put an interface/facade in front of the old implementation.
- Build the new implementation behind it; route traffic gradually (by feature flag, by route, by case).
- Old and new run side by side; compare outputs where feasible.
- Delete the old path only when the new one handles 100% — deletion day is a celebration, not a risk.

## Phase 6 — Prove and report

- Full suite green; characterization tests untouched and passing.
- Public API unchanged — or the deliberate changes listed explicitly with migration notes.
- Hot path? Quick perf sanity check that the refactor didn't regress it.
- Report: what moved where and why, as a story a reviewer can follow step by step; plus the logged list of drive-by findings for follow-up work.

## Rules

- Tests are the definition of "didn't break it" — no net, no refactor; write the net first.
- One refactoring at a time; entangled moves hide mistakes.
- Deleting a failing characterization test to go green is falsifying evidence.
- If mid-refactor you discover the design insight that changes the target shape — finish or revert the current step first, then re-plan from green.

