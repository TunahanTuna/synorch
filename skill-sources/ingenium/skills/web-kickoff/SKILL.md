---
name: web-kickoff
description: Stand up a new web project with a production-grade foundation in one session - deliberate stack selection (Next.js vs Vite SPA vs Astro), strict TypeScript, ESLint + Prettier, Vitest, validated env handling, folder structure, git hygiene, CI and a CLAUDE.md from day one, ending with a verified dev/lint/test/build. Use when creating a new web project or app, or setting up tooling and structure for one. Türkçe tetikleyiciler - "yeni web projesi kur", "proje oluştur", "sıfırdan proje aç", "proje iskeleti kur", "boilerplate hazırla", "yeni next projesi", "yeni react projesi".
---

# Web Kickoff

You stand up new web projects that are production-grade from commit one: deliberate stack choice, strict tooling that catches bugs before runtime, and a repo an AI can work in efficiently. Speed matters — the goal is a verified foundation in one session, not a week of yak-shaving.

Always communicate with the user in their own language.

## Phase 1 — Three questions before any code

Ask (don't assume) whatever isn't already stated:

1. **What is it?** Content site / full app / internal dashboard / API + UI / game shell.
2. **Constraints?** SEO or SSR needs, auth, hosting target, mobile importance.
3. **Conventions to inherit?** Team standards vs personal project freedom.

If the user has answered these in their request, proceed without re-asking.

## Phase 2 — Stack decision

- Content-heavy, mostly static (marketing, blog, docs) → **Astro** (islands where needed).
- App needing SEO/SSR/server actions → **Next.js** (App Router).
- Internal tool / pure SPA / game shell → **Vite + React + TypeScript**.
- Tiny experiment → **Vite vanilla-ts**.

State the choice and the one-paragraph why; proceed unless the user objects. Don't churn between frameworks after this point.

## Phase 3 — Foundation checklist (in order, verify each step)

1. **Scaffold** with the framework's current official create command; package manager **pnpm** unless the user prefers otherwise.
2. **TypeScript strict**: `"strict": true` plus `"noUncheckedIndexedAccess": true` — the single highest-value compiler flag pair.
3. **ESLint (flat config) + Prettier**, wired so they don't fight: `eslint-config-prettier` last. Add `typescript-eslint` recommended-type-checked if the project can afford the type-aware lint cost.
4. **Vitest** + Testing Library, with one real example test that renders something — not a placeholder assert-true.
5. **Env discipline**: `.env.example` committed, `.env` gitignored, and runtime validation of env vars with zod (fail fast at boot, not deep in a request).
6. **Git hygiene**: `.gitignore` correct for the stack, `git init`, meaningful first commit.
7. **CLAUDE.md**: commands, structure, conventions — write it now while decisions are fresh (follow the project-onboard skill's template).
8. **CI** (GitHub Actions unless told otherwise): install → lint → type-check → test → build, on PRs and main.
9. **README skeleton**: what it is, how to run, how to test — three sections, no lorem ipsum.

## Phase 4 — Folder structure (feature-based)

```
src/
  features/<feature>/     # components, hooks, api, types per feature
  components/             # genuinely shared UI only
  lib/                    # framework-agnostic utilities
  app/ or pages/          # routing layer (framework-dictated)
  styles/
```

Colocate by feature; promote to shared only on the second consumer. Absolute imports via `@/` alias.

## Phase 5 — Definition of done

Run and show output: dev server starts, lint passes, type-check passes, the example test passes, production build succeeds. A kickoff that ends with a red command is not done.

## Defaults (override on request)

Tailwind for styling; no state-management library until there's real pain (start with component state + URL state); TanStack Query the moment server data fetching appears; no husky/pre-commit hooks unless the team wants them (CI is the gate).

