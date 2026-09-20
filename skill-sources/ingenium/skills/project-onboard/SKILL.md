---
name: project-onboard
description: Deeply analyze a codebase and produce or refresh its AI-collaboration foundation - a verified CLAUDE.md (exact build/test/run commands, architecture map, conventions, gotchas) so every future AI session starts with full context instead of rediscovering the project. Use when starting on an unfamiliar project, when CLAUDE.md is missing or stale, or when asked to make a repo AI-ready. Türkçe tetikleyiciler - "projeyi tanı", "projeyi analiz et", "claude md oluştur", "projeyi ai için hazırla", "projeyi claude'a tanıt", "onboarding yap".
---

# Project Onboard

You make a repository AI-ready: analyze it deeply, then write (or surgically refresh) a CLAUDE.md that gives every future session the project's working knowledge in under a minute of reading. The value is in *verified* facts and *non-obvious* knowledge — not in restating what any glance at the repo reveals.

Always communicate with the user in their own language.

## Phase 1 — Discover

- Manifests and lockfiles → stack, package manager (respect the lockfile: pnpm-lock → pnpm, not npm), workspace/monorepo layout.
- Scripts section, Makefile, justfile, taskfiles → candidate commands.
- CI workflows (`.github/workflows`, GitLab CI, Azure Pipelines) → the *authoritative* build/test/lint commands; CI is truth, READMEs drift.
- Entry points, top-level folder map (2–3 levels deep), config files (tsconfig, eslint, docker-compose, .env.example).
- Existing CLAUDE.md, README, docs — note what they claim; you will verify, not trust.

## Phase 2 — Verify commands by running them

Run the safe ones and record exactly what works: lint, type-check, unit tests (a fast subset if the suite is slow), build if it is quick. Capture the real command, from the repo root or the correct subdirectory. A CLAUDE.md with guessed commands is worse than none — every command you write must have run successfully in this session or be explicitly marked unverified.

## Phase 3 — Map the architecture from evidence

- Modules/packages and their single-sentence responsibility, with paths.
- Data flow for the core use case: entry → layers → persistence/external services.
- Key abstractions the codebase leans on (the base classes, the middleware chain, the store, the event bus) and where they live.
- Integration points: databases, queues, external APIs, auth provider.

Read real code to confirm — folder names lie ("utils" containing the business core is a classic).

## Phase 4 — Detect conventions

- Formatting/linting: which tool is the enforcer; never fight it.
- Naming and file-organization patterns actually used (not aspirational ones from docs).
- Test layout and style: colocated vs `__tests__`, naming, fixture patterns.
- Import style (aliases like `@/`), error-handling idioms, commit message style from `git log --oneline -30`.

## Phase 5 — Hunt gotchas (highest-value lines in the file)

- Codegen or generated files that must be regenerated, never edited.
- Required env vars and local services (docker compose, db) needed before anything runs.
- Order-dependent setup steps; platform quirks (Windows paths, case sensitivity).
- Slow/flaky test suites and the fast way to run the relevant subset.
- Anything that made *you* stumble during Phase 2 — that is exactly what goes here.

## Phase 6 — Write CLAUDE.md

Rules: commands first; short factual bullets; only non-obvious information; no marketing prose; target ≤ 120 lines; link deeper docs instead of inlining them. If a CLAUDE.md already exists, update it surgically — preserve custom sections and the owner's voice; never clobber.

Template:

```markdown
# <Project>

<One sentence: what this is.>

## Commands
- Install: `...`
- Dev: `...`
- Test: `...` (fast subset: `...`)
- Lint/format: `...`
- Build: `...`

## Architecture
- <module> (`path/`): <responsibility>
- Core flow: <entry> → <layer> → <persistence>

## Conventions
- <only the ones a newcomer would get wrong>

## Gotchas
- <the expensive-to-rediscover facts>
```

Finish by reporting: what you verified by running, what you inferred from reading, and what remains unverified.

