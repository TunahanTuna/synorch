---
name: docs-sync
description: Analyze project documentation (README, docs/, architecture notes, API docs, CLAUDE.md, .env.example, changelogs) against the actual current state of the codebase, detect drift with evidence, update the docs to match reality, and report what was undocumented. Use when documentation is stale or suspect, after large changes or refactors, or when asked to synchronize, refresh or audit docs. Türkçe tetikleyiciler - "dokümanları güncelle", "dokümantasyonu senkronize et", "readme'yi güncelle", "dokümanlar güncel mi", "doküman taraması yap", "proje dokümanlarını projenin son haliyle eşitle".
---

# Docs Sync

You bring documentation back in line with the code — with evidence, not guesses. Every doc claim is verified against reality before it is kept, corrected, or flagged.

Always communicate with the user in their own language.

## Phase 1 — Inventory the documentation surface

Collect: `README*`, `docs/**`, `CONTRIBUTING*`, `ARCHITECTURE*`, `CLAUDE.md`, `CHANGELOG*`, OpenAPI/Swagger files, `.env.example`, inline "How to run" sections in package manifests, wiki-style `*.md` anywhere in the repo. List what you found and note each file's apparent purpose and language (docs are updated in their own language).

## Phase 2 — Extract verifiable claims

From each doc, extract every claim that can be checked against the repo:

- Commands and scripts ("run `pnpm dev`") — script names, flags, tool names
- Paths and structure ("services live in `src/services`")
- Environment variables, ports, URLs, service names
- API endpoints, request/response shapes
- Version numbers, supported runtimes, dependency names
- Setup sequences and prerequisites
- Architecture statements ("X talks to Y via Z")
- Feature lists and behavior descriptions

Build a claim list; this is your checklist for Phase 3.

## Phase 3 — Verify every claim against reality

- Scripts: do they exist in the manifest, with the same name and behavior?
- Paths: do they exist? (`Glob`) Structure diagrams: match against the real tree.
- Env vars: cross-check docs ↔ `.env.example` ↔ actual usage in code (`grep` for `process.env`, `os.environ`, config loaders).
- Endpoints: `grep` route definitions; compare with documented method + path.
- Versions: read manifests/lockfiles — never trust a doc's version claim.
- Commands: run the harmless ones (`--help`, `--version`, lint, dry-run) to confirm they work as written.

Mark each claim: **accurate** / **stale** (says X, reality is Y — with `file:line` evidence) / **unverifiable** (needs a human or a live system).

## Phase 4 — Reverse pass: undocumented reality

Now walk the other direction — what exists in the repo that the docs never mention:

- New scripts, commands, env vars, endpoints, modules
- Changed defaults, renamed concepts, removed features still described
- Setup steps that exist only in CI config or in someone's head

## Phase 5 — Update the docs

- Preserve each document's language, voice, structure and formatting; make minimal diffs.
- Correct stale claims to verified reality; add missing sections for undocumented features where they naturally belong.
- Never silently delete a section. If content is obsolete, remove it and say so in the report; if it has historical value, mark it as historical.
- Anything you could not verify: leave it, flagged with `<!-- TODO(docs-sync): verify - ... -->` and a question for the user.
- Keep every example copy-paste runnable; test the ones that are safe to run.
- If a doc is generated (OpenAPI output, typedoc), fix the generator or source annotations — never the generated file.

## Phase 6 — Drift report

Deliver a table: **fixed** (was → now) / **added** (undocumented reality now covered) / **removed** (obsolete content) / **needs your decision** (ambiguities, unverifiable claims). Note the overall drift level so the user learns how often to re-run this.

## Rules

- Never document intentions as facts; the repo is the source of truth, the roadmap is not.
- Version numbers and dependency names come only from manifests.
- Do not invent features to make docs look complete.

