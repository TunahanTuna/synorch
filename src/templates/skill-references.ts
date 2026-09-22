/**
 * Progressive-disclosure reference files for the canonical base skills.
 *
 * A reference costs nothing until a step in its skill actually needs it, so it
 * carries the worked examples, catalogues and rubrics that would otherwise
 * bloat a just-in-time `SKILL.md`. Each file is declared in its skill's
 * `references` frontmatter and generated under the skill's own directory.
 */

export const riskClassificationReference = `# Risk Classification — Worked Examples

Use this file when a brief does not obviously land in one tier, or when someone
disputes a classification. The tier definitions live in
\`.ai/protocols/core/orchestration.md\`; this file only shows how they are applied.

## The deciding questions

Ask them in order. The first "yes" sets the floor; nothing below it applies.

1. Can this change corrupt, expose or lose data that already exists?
2. Does it alter a contract someone outside this repository depends on?
3. Does it touch authentication, authorization, secrets, payments or money?
4. Does it change concurrency, ordering, retries or idempotency?
5. Does it change behavior a user or another service can observe?
6. Does it span more than one module, or more than one owner?

Questions 1–4 mean high-risk. Question 5 alone means standard. Question 6 alone
means standard. None of them means trivial.

## Worked examples

| Brief | Tier | Why |
| --- | --- | --- |
| Fix a typo in a button label | trivial | No behavior, no contract, reversible in one line. |
| Rename a private helper used in one file | trivial | No external name changes; the compiler proves the rename. |
| Bump a patch version of a dev-only formatter | trivial | No runtime artifact changes. |
| Add a nullable, unused column with a default | standard | Schema change, but no reader depends on it yet. |
| Add a field to an existing API response | standard | Observable behavior; additive, so no consumer breaks. |
| Extract a component used by three screens | standard | Multi-file, but behavior is meant to be identical. |
| Change a cache expiry from 60s to 600s | standard | Observable staleness change, bounded blast radius. |
| Add an index to a large production table | high-risk | Locking and write-path impact during migration. |
| Change a password hash or token lifetime | high-risk | Authentication surface. |
| Make a sequential job run in parallel | high-risk | New ordering and idempotency assumptions. |
| Drop or rename a column still read by code | high-risk | Destructive and irreversible without a backup. |
| Change the rounding of an invoice total | high-risk | Money, and every historical comparison shifts. |

## Traps that misclassify

- **"It is only a config change."** Config that selects a code path is a code
  change with no test coverage. Tier it by what the path does.
- **"It is only one line."** Size is not risk. A one-line change to a permission
  check is high-risk; a hundred-line change to a test fixture is trivial.
- **"The tests pass."** Passing tests classify nothing. They tell you what is
  already covered, not what the change can break.
- **"We will verify it in production."** That is a decision to accept risk, not
  a reason to lower the tier. Record it as an accepted risk in the plan.
- **"It is a revert."** A revert of a migrated schema is not symmetrical with
  the migration. Tier it on what the revert itself does.

## Escalating a tier mid-task

Escalate, record the reason, and re-open approval when any of these appear:

- A verified fact contradicts an assumption the plan rested on.
- The change turns out to need a file the plan did not name.
- A check fails for a reason no one predicted.
- The worker asks for authority the packet did not grant.

Never lower a tier because the work is taking longer than expected. Lower it
only when evidence removes the risk that set it, and say which evidence did.
`;

export const evidenceLadderReference = `# Evidence Ladder — Worked Examples

The rungs and the browser policy are defined in
\`.ai/protocols/core/verification.md\`. This file shows which evidence actually
proves which claim, and which evidence only looks like proof.

## Claim to evidence

| Claim | Sufficient evidence | Not sufficient |
| --- | --- | --- |
| "The label now reads X." | The diff hunk showing the literal, plus a search proving no other copy exists. | "I changed it." |
| "The function handles null." | A unit test asserting the null path, failing before the change. | Reading the new branch. |
| "No caller breaks." | A type check, or an exhaustive search of call sites with each one listed. | "It is backwards compatible." |
| "The bug is fixed." | The original reproduction command, before and after, with output. | The test suite passing. |
| "Performance improved." | The same measurement command before and after, with both numbers. | A reasoned argument about complexity. |
| "The migration is safe." | A dry run against a copy of real-shaped data, plus the rollback path. | A review of the SQL. |
| "Nothing else changed." | The full diff, read hunk by hunk. | The summary of the diff. |
| "The endpoint returns 403 for anonymous users." | A request-level test asserting the status. | The presence of a guard annotation. |

## Choosing the cheapest sufficient rung

Ask: *what observation would change my mind?* Run that, and stop.

- A claim about a literal is settled by a search. Running the test suite adds
  minutes and zero information.
- A claim about a type boundary is settled by the type checker. A runtime test
  adds nothing the compiler did not already prove.
- A claim about behavior at an integration seam is not settled by a unit test
  with the seam mocked. The mock encodes the assumption under test.
- A claim about a rendered pixel, a focus order or a real browser event is the
  only case where a headed browser is the cheapest sufficient evidence — and it
  still requires the approval the protocol demands.

## Recording evidence

Record, for every check: the exact command, the working directory, the outcome,
and the reason for any check deliberately not run. Three failure modes to avoid:

1. **Paraphrasing a command.** \`pnpm test\` and \`pnpm test src/foo\` are
   different evidence. Record what ran, not what it resembled.
2. **Reporting a check that did not run.** If it was skipped, name it as
   skipped. An honest gap is cheaper than a false claim discovered later.
3. **Reporting a pass that was not read.** A green exit code from a command
   that matched zero tests proves nothing. Confirm the check had subjects.

## Worked example — a trivial change

Objective: correct a misspelled key in one constant.

1. Diff: one line, one file. **Rung 1.**
2. Search for the old spelling across the repository: no other occurrence.
3. Stop. No lint, no build, no test suite, no reviewer, no browser.
4. Record: "grep -r oldKey → 0 hits; suite not run (unaffected)."

## Worked example — a standard change

Objective: an API response gains an optional field.

1. Diff read hunk by hunk. **Rung 1.**
2. Type check and the serializer's own unit tests. **Rung 2.**
3. One request-level test asserting the field is present and optional.
4. Integration suite only if a consumer in this repository parses strictly.
5. Independent review because the change crosses a published boundary.
6. Record every command, plus "end-to-end suite not run: no UI path changed."
`;

export const hypothesisPatternsReference = `# Hypothesis Patterns and Failure Catalogue

Open this file when the reproduction is in hand and the hypothesis list is
short, obvious and wrong. It exists to widen the candidate set before effort is
spent confirming a favourite.

## Writing a falsifiable hypothesis

A usable hypothesis names a mechanism and predicts an observation.

- Weak: "something is wrong with the cache."
- Usable: "the cache key omits the tenant id, so tenant B reads tenant A's
  entry. If true, two requests differing only by tenant return the same body."

Every hypothesis must come with the cheapest observation that would **disprove**
it. Rank by \`likelihood / cost of disproof\`, and test the cheapest first.

## The failure catalogue

### It works locally but not in the other environment

- Configuration or secret differs, and the code falls back silently.
- Version skew: a dependency resolved differently by an unpinned range.
- Case-sensitive file system on one side, case-insensitive on the other.
- Timezone or locale of the host changes parsing or formatting.
- A build step runs in one environment and not the other.

### It worked yesterday

- A dependency floated to a new version; check the lockfile diff first.
- A clock, an expiry or a certificate crossed a boundary.
- Data grew past a limit: a page size, a timeout, an index that stopped being used.
- A feature flag or remote configuration changed outside the repository.

### It fails only sometimes

- Order dependence between tests sharing mutable state.
- A race between an async write and the read that follows it.
- Time-of-day, date-boundary or leap-related arithmetic.
- Retry logic masking a failure until the retry budget is exhausted.
- Hash or set iteration order treated as stable.

### The error message points at innocent code

- The reported frame is where the bad value was *used*, not where it was made.
  Walk the value backwards to its origin.
- A wrapper re-threw and lost the cause; find the original throw site.
- A null or default was substituted upstream by a permissive parser.
- The stack belongs to a different async context than the failure.

### The fix does not stick

- Two code paths do the same thing and only one was changed.
- A cached, generated or committed artifact still holds the old value.
- The test asserts the mock, not the code.
- The change is correct but never runs: the branch condition is false.

## Reduction techniques

- **Bisect the input.** Halve the failing input until the minimal trigger remains.
- **Bisect history.** Find the last good commit; the diff bounds the cause.
- **Bisect the stack.** Assert the value at the midpoint between the origin and
  the symptom; each assertion halves the remaining search space.
- **Invert.** Instead of asking why it fails, construct the closest case that
  succeeds and diff the two.

## Before calling it a root cause

1. You can state the mechanism in one sentence, cause to symptom.
2. You can explain why it did not fail earlier, or elsewhere.
3. A regression test fails before the fix and passes after it.
4. The fix touches the cause, not the place the symptom was observed.

If any of the four is missing, you have a correlation. Say so, and escalate
rather than shipping a fix whose mechanism you cannot state.
`;

export const severityRubricReference = `# Review Severity Rubric and Checklist

Open this file when classifying a finding, or when a review needs a systematic
pass rather than an impression. The verdict vocabulary is fixed so that
"blocking" means the same thing to every reviewer.

## Severity rubric

| Severity | Definition | Reviewer action |
| --- | --- | --- |
| \`blocking\` | The change is incorrect, unsafe, or fails an approved acceptance criterion. Shipping it causes harm or rework. | Reject. Name the location, the mechanism and the consequence. |
| \`required\` | Correct for the approved case, but leaves a defect that will surface under a stated, realistic condition. | Approve only with a named follow-up owner and task. |
| \`advisory\` | A real improvement that is out of scope for the approved change. | Report; never block on it. |
| \`note\` | Context a future reader will want. No action implied. | Report at most a handful. |

A finding with no consequence is not a finding. If you cannot complete the
sentence "if this ships unchanged, then …", it is at most a note.

## Blocking, by category

- **Correctness.** The code does not do what the criterion says, on the inputs
  the criterion names.
- **Regression.** An existing behavior covered by a test or a caller changes
  without being part of the approved scope.
- **Security.** Missing authorization, injected input reaching an interpreter,
  a secret in the diff, a permission widened without justification.
- **Data.** Irreversible migration without a rollback, a write that can partially
  apply, a unique constraint the code does not honour.
- **Concurrency.** A read-modify-write without a guard, an await inside a lock, a
  shared mutable default.
- **Evidence.** The packet reports a check that did not run, or the named
  evidence does not prove the claim it is attached to.

## The checklist

Run in order. Stop at the first section that produces a blocking finding, report
it, and finish the remaining sections at low cost rather than in depth.

1. **Scope.** Does every changed file appear in the approved ownership? Is any
   hunk unrelated to the objective?
2. **Criteria.** For each acceptance criterion, name the hunk that satisfies it.
   A criterion with no hunk is blocking.
3. **Edges.** For each new branch: what happens on empty, null, zero, one,
   duplicate, very large, and concurrent?
4. **Errors.** Is every failure path either handled or deliberately propagated?
   Is any error swallowed into a default?
5. **Boundaries.** Did a public type, route, schema, event or column change? Is
   the change additive?
6. **Tests.** Does a new test fail without the change? Does it assert behavior
   rather than the shape of the implementation?
7. **Evidence.** Re-run the cheapest reported command. Does it pass, and does it
   cover the change?
8. **Leftovers.** Debug output, commented code, skipped tests, temporary files,
   unrelated formatting.

## What not to raise

- Preferences the project does not enforce in lint, formatter or existing code.
- Rewrites of code the diff only moved.
- Hypothetical scale the project has never stated a requirement for.
- Duplicate findings: report the pattern once and list the locations.

## Wording a finding

\`path:line\` — severity — what is wrong — what happens if it ships — the
smallest change that resolves it. Four sentences at most. If a finding needs
more, the change needs a conversation, not a comment.
`;
