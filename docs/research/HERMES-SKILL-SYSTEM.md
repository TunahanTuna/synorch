# Research — Hermes Agent's Self-Improving Skill System

> Status: Research notes, no implementation commitment
> Collected: 2026-09-22
> Purpose: Establish a factual basis for designing a Synorch Skill Creator, by documenting how a shipping self-improving skill system actually works — including what it deliberately leaves unsolved.
> Related: [AI Orchestration Architecture](../AI-ORCHESTRATION-ARCHITECTURE.md) §12, [Multi-Provider Harness](../FUTURE-MULTI-PROVIDER-HARNESS.md) §21, §22

## 1. What Hermes Agent Is

Hermes Agent is a self-improving agent from Nous Research. Unlike Synorch, it is a running agent: it reads and edits files, runs shell commands, and carries persistent memory across sessions. It can also delegate coding work to Claude Code and Codex.

Its skill system is described as **procedural memory**: the mechanism that lets a repeated task reuse a known-good path instead of re-exploring it. Two origins converge on the same format — hand-written skills capture procedures the user already knows, auto-created skills capture what the agent discovered while working. Both end up as the same `SKILL.md` in the same folder.

This is the most relevant prior art for a Synorch Skill Creator, and §21 of the harness document already names Hermes as an inspiration source.

## 2. The SKILL.md Contract

```yaml
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [python, automation]
    category: devops
    fallback_for_toolsets: [web]
    requires_toolsets: [terminal]
    config:
      - key: my.setting
        description: "What this controls"
        default: "value"
        prompt: "Prompt for setup"
---
```

Notable contract properties:

- `version` is a first-class field, so a skill is a versioned artifact rather than loose prose.
- `platforms` restricts a skill to specific operating systems.
- `requires_toolsets` and `fallback_for_toolsets` express conditional activation declaratively, rather than leaving activation to prose in the body.
- `config` lets a skill declare the settings it needs, with a setup prompt.

## 3. Storage Layout

The primary source of truth is `~/.hermes/skills/`, organized by category:

```text
~/.hermes/skills/
├── mlops/axolotl/
│   ├── SKILL.md
│   ├── references/
│   ├── templates/
│   ├── scripts/
│   ├── examples/
│   └── assets/
└── .bundled_manifest
```

Additional locations:

- `skills.external_dirs` in `config.yaml` adds directories to the scan.
- `skills.create_dir` redirects where agent-created skills land; the default is the global folder.
- Project-local skills load from `<project-root>/.hermes/skills/` or `<project-root>/.agents/skills/` when running inside a git repository, and require explicit trust through `hermes skills trust`.

The project-local path plus an explicit trust step is a direct precedent for Synorch, which is repository-scoped by design.

## 4. How Skills Are Auto-Created

The agent creates skills through a `skill_manage` tool when it "figures out a non-trivial workflow worth repeating." Documented triggers:

- Working through a multi-step workflow the agent should remember.
- Recovering from an error, to document the path that worked.
- A user correction to its approach.

The system prompt explicitly asks the agent to record such patterns. Creation uses:

```text
skill_manage create:
  name: <skill-name>
  content: <full SKILL.md>
  category: <optional>
```

There is also a background self-improvement review that runs after a turn, distilling what just happened into a reusable skill without the user asking.

### The approval gate

`skills.write_approval: true` stages writes under `~/.hermes/pending/skills/` for human review instead of committing them directly. This is the single most important control in the system, and it maps exactly onto a `proposed` skill state.

## 5. Progressive Disclosure

Loading is explicitly three-level and token-budgeted:

| Level | Call | What it costs |
| --- | --- | --- |
| 0 | `skills_list()` | metadata only, roughly 3k tokens: `{name, description, category}` |
| 1 | `skill_view(name)` | full skill content plus metadata |
| 2 | `skill_view(name, path)` | one specific reference file, on demand |

Invocation is either a slash command (`/skill-name`, chainable: `/github-pr-workflow /test-driven-development fix issue #123`) or natural conversation.

Large source material becomes a "knowledge-base skill": a lean `SKILL.md` plus distilled `references/` files, on the principle that "reference files cost nothing until a question needs one."

This is the same architecture Synorch already uses: `catalog.yaml` for cheap discovery, `SKILL.md` on match, supporting files last.

## 6. How Skills Improve After Creation

Two mechanisms:

**Targeted patching.** `skill_manage` supports a `patch` action taking `old_string`/`new_string`, and this is documented as preferred over a full rewrite for token efficiency. A skill is edited surgically, not regenerated.

**Background review.** After sessions, the system can suggest or stage skill modifications. These writes also respect the `write_approval` gate.

An advisory linter runs on `create` and on reference-file writes. It reports findings but **never blocks**. Two named checks are worth recording:

- `incident-log-shape` — the skill reads like a log of one incident rather than a reusable procedure.
- `references-sprawl` — more than 60 reference files in one skill.

`incident-log-shape` is the most useful artifact of this research. It names the exact failure mode of auto-distillation: an agent that just finished a task tends to write down *what happened to it* instead of *what should be done next time*. Any Synorch equivalent needs a defense against this shape.

## 7. Bundled Skill Sync — Strong Convergence With Synorch

Bundled skills ship with the repository and sync into `~/.hermes/skills/` on install and on `hermes update`. A manifest at `~/.hermes/skills/.bundled_manifest` records each skill's origin content hash. On sync:

- **Unchanged locally** — upstream changes are pulled and the new origin hash recorded.
- **Changed locally** — the skill is marked user-modified and skipped *forever*, so edits are never overwritten.
- `hermes skills reset <name>` clears the manifest entry while preserving local changes; `--restore` deletes the local copy and re-copies the bundled version.
- Generated caches (`__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`) do not count as user modification.

This is functionally the same contract Synorch already implements: `sync` refuses to clobber a modified generated skill, and `sync --force` is the explicit escape hatch. Two systems arriving independently at the same rule is good evidence the rule is correct.

The one idea worth importing is the **content hash manifest**. Synorch currently decides "modified" by comparing against canonical content; an explicit origin-hash manifest makes the same decision cheaper and auditable, and it distinguishes "user edited it" from "canonical content changed underneath it".

## 8. The Evolutionary Layer

A separate repository, `NousResearch/hermes-agent-self-evolution`, optimizes skills, tool descriptions, system prompts and code using DSPy + GEPA (Genetic-Pareto Prompt Evolution).

Pipeline: read existing definitions → generate evaluation datasets → apply the GEPA optimizer using execution traces → create candidate variants → filter through constraint gates → select and propose the best variant.

The notable part is the fitness signal, which is multi-dimensional rather than a single score:

- Execution traces from real or synthetic runs.
- Test suite results, requiring 100% pytest pass.
- Size constraints: skills ≤ 15KB, tool descriptions ≤ 500 characters.
- Semantic preservation — the variant must retain the original purpose.
- Caching compatibility — no mid-conversation changes.

Evaluation data comes either from synthetic test cases or from real session history, including traces from Claude Code and Copilot. Candidates that fail a constraint gate are rejected, and every surviving change still requires human review before integration.

Two transferable ideas: **a hard size ceiling as a constraint gate**, and **using execution traces to understand why something failed rather than only that it failed**. GEPA itself is far outside Synorch's current scope.

## 9. What Hermes Does Not Solve

Reviewing the documentation and secondary write-ups, several operational questions are consistently unanswered:

- **No promotion threshold.** There is no documented criterion for when a workflow is worth becoming a skill. The judgment is left entirely to the model, guided by the phrase "non-trivial workflow worth repeating."
- **No deduplication.** Nothing documented detects that a new skill overlaps an existing one, and nothing merges them.
- **No pruning.** Skills persist indefinitely unless explicitly removed via `skill_manage delete` or `hermes skills uninstall`. There is no decay, no usage tracking that retires an unused skill, no consolidation pass.
- **No negative feedback loop.** Nothing documented captures that a loaded skill turned out to be wrong or stale, and feeds that back into its status.
- **The linter never blocks.** `incident-log-shape` and `references-sprawl` are advisory only, so a low-quality skill still lands.

The only real defense offered against accumulation is `write_approval`, which converts the problem into human review load. That is a safeguard, not a curation strategy.

This gap is the most actionable finding in this document. A system that writes skills but never retires them accumulates monotonically, and skill count is context cost. For Synorch — which treats token efficiency as a design principle and separates `available` / `active` / `loaded` precisely to bound context — inheriting auto-creation without adding a lifecycle would contradict the existing architecture.

## 10. Implications for a Synorch Skill Creator

Mapped against Synorch's current design:

| Hermes mechanism | Synorch status | Action |
| --- | --- | --- |
| `SKILL.md` + typed frontmatter | Skills exist, contract is prose | Formalize as Canonical Skill Contract v1 (already Phase 0 in the harness roadmap) |
| Three-level progressive loading | Already implemented via `catalog.yaml` | Keep; no change needed |
| Project-local skills + explicit trust | Repository-scoped by default | Keep; Synorch is stricter here already |
| Bundled sync with hash manifest | Equivalent rule, no hash manifest | Consider adopting the origin-hash manifest |
| Agent auto-creation (`skill_manage`) | Does not exist | The actual feature to design |
| `write_approval` staging | Maps to a new `proposed` state | Adopt; make it mandatory rather than opt-in |
| `patch` over rewrite | Not applicable yet | Adopt when skills become editable |
| Advisory linter | `doctor` exists and *does* block | Add skill-shape checks to `doctor`, including an `incident-log-shape` equivalent |
| Promotion threshold | — | **Gap in Hermes; Synorch should define one** |
| Deduplication / merge | — | **Gap in Hermes; needs a design** |
| Retirement / pruning | — | **Gap in Hermes; needs a design** |
| Negative feedback from use | — | **Gap in Hermes; Synorch has completion packets to build it on** |

The last four rows are where Synorch can be materially better rather than merely equivalent, and it can be because of an asset Hermes does not have: **the structured completion packet**. Synorch workers already return `commands_run`, `decisions_made` and `unresolved_risks` with evidence and source paths. That is a far better distillation input than a raw conversation trace, and it is the natural place to hang a promotion counter, a confirmation count and a staleness signal.

## 11. Open Questions Raised by This Research

1. What is the promotion threshold — how many independent confirmations before an observation becomes a proposed skill?
2. Where does an unpromoted observation live, and when does it expire?
3. What retires a skill: age, non-use, a failed load, or contradicting evidence?
4. Does Synorch adopt a hard size ceiling per skill, as the evolution repo does?
5. Is `doctor` advisory or blocking for generated skill shape? Synorch's `doctor` blocks by convention; Hermes's linter does not.
6. Does a generated skill carry a `verified_at` and expire without re-verification?

## Sources

- [Hermes Agent Documentation](https://hermes-agent.nousresearch.com/docs/) — official docs
- [Hermes Agent — Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) — primary source for format, storage, auto-creation, loading, sync
- [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) — main repository
- [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) — DSPy + GEPA evolutionary optimization
- [Hermes Agent Skills: How Self-Improving Skills Actually Work](https://aiengineerinsights.com/blog/hermes-agent-skills/) — secondary analysis
- [Hermes, The Self-Improving Agent You Can Actually Run Yourself](https://dev.to/emmanuelthecoder/hermes-the-self-improving-agent-you-can-actually-run-yourself-555l) — secondary walkthrough
- [awesome-hermes-skills](https://github.com/ZeroPointRepo/awesome-hermes-skills) — community skill catalog
