---
name: react-modern
description: Modern React and its frameworks, current as of August 2026 (React 19.2, React Compiler 1.0, Next.js 16) - server-first mental model with Server Components, Actions/useActionState/useOptimistic forms, use() for async, Compiler instead of manual memoization, framework selection (Next.js 16 vs React Router 7 framework mode vs TanStack Start v1 vs Vite SPA), Next.js 16 Cache Components with stable PPR and Turbopack, plus a stale-habit anti-pattern list and a freshness protocol that verifies current versions before locking decisions. Carries an existing-codebase protocol for brownfield projects - detect installed versions, match the repo's paradigm, modernize only as an explicit opt-in. Use when building, upgrading or optimizing React or Next.js apps, choosing a React framework or asking about current React best practices. Türkçe tetikleyiciler - "react'ta en güncel yöntem", "eski react projesinde çalış", "react 19 özellikleri", "next.js projesi kur", "next.js best practice", "server component nasıl kullanılır", "react compiler", "react projemi optimize et", "hangi react framework'ü", "en güncel react".
---

# React Modern (2026)

You build React the way it works *now*, not the way tutorials taught it in 2022. The 2026 mental model: **server-first, compiler-optimized, actions-driven.** Old habits are the main source of bad modern React — this skill exists to replace them *in the code you write going forward*; existing codebases are protected by the brownfield protocol below.

Always communicate with the user in their own language.

## Freshness protocol

Knowledge here is current as of **August 2026**: React 19.2 (Compiler 1.0 stable since Oct 2025), Next.js 16.x (Turbopack default, Cache Components + PPR stable), React Router 7, TanStack Start 1.0 (March 2026). Before locking framework/version decisions on a new project or upgrade, verify the current state at react.dev/blog and nextjs.org/blog — if reality has moved past this skill, reality wins and say so.

## Existing codebase protocol (brownfield safety — read before touching an old project)

The modern patterns in this skill describe **new code and greenfield decisions**. An existing project is governed by what it already is:

- **Detect reality first**: React and framework versions from package.json and the lockfile; the paradigm from the code itself (class components? Pages Router? Redux? CRA?). Five minutes of reading beats one wrong assumption.
- **Consistency beats modernity inside a codebase.** New code follows the repo's existing patterns — an Actions-and-RSC island pasted into a Pages Router app, or hooks idioms scattered through a class-component codebase, is a maintenance wound, not an upgrade.
- **Feature-gate by installed version**: no `use()`/Actions below React 19, no `"use cache"`/PPR below Next 16, Compiler adoption is a project decision (supports back to 17, but opt-in) — never emit code the installed versions cannot run.
- **Modernization is a proposal, never a side effect.** If upgrading would genuinely pay, say so separately — scope, win, risk, migration path — and execute it through the refactor-safe skill (behavior-preserving, incremental). Never modernize in passing while delivering a feature.

## Stale habit → modern replacement (the core table)

| 2022 habit | 2026 way |
|---|---|
| `useEffect` + `useState` for data fetching | Server Components / framework loaders; on the client TanStack Query; `use()` for passed promises |
| `forwardRef` | `ref` is a normal prop now |
| `memo`/`useMemo`/`useCallback` sprinkled everywhere | **React Compiler** memoizes automatically; write plain code |
| Controlled-everything forms with submit handlers | **Actions**: `<form action={fn}>` + `useActionState` + `useFormStatus`; `useOptimistic` for instant feedback |
| Global provider/store by default | Server state stays on the server or in a query cache; global client stores only for genuinely global client state |
| SPA-by-default for everything | Framework decision below — SPA is one deliberate option, not the default |
| Waterfall `await` chains in loaders | Parallel fetches + Suspense streaming |

## React 19 in practice

- **Actions**: any async function passed to `<form action>`, `formAction`, or transitions. `useActionState(fn, initial)` returns `[state, action, isPending]` — errors and pending become data, not choreography.
- **`useOptimistic`**: render the expected result immediately, reconcile on settle — the default for likes, toggles, list-adds.
- **`use(promise)`** suspends on a promise created *outside* render (server-passed or cached); `use(Context)` reads context conditionally. It does not replace a query cache.
- **Refs**: plain prop; ref callbacks may return cleanup functions.
- **Metadata**: `<title>`/`<meta>` hoist automatically from components (frameworks' metadata APIs still win for dynamic SEO).

## React Compiler (default ON for new projects)

- Auto-memoizes components and hooks at build time; works back to React 17; stable 1.0.
- The contract: follow the Rules of React — pure render, no mutation of props/state, hooks called unconditionally. Enforce with `eslint-plugin-react-compiler`; code the compiler bails on is usually code with a real bug.
- Delete manual `memo`/`useMemo`/`useCallback` in compiled code paths unless profiling proves a hot spot the compiler missed — keeping both is noise.

## Server Components mental model (RSC)

- **Server by default, client at interactivity boundaries.** A component becomes `'use client'` only because it needs state, effects, or browser APIs — and the boundary should sit as deep in the tree as possible (leaf-level islands, not page-level).
- Server components fetch data next to where it renders (async/await directly in the component), ship **zero JS** for themselves, and can render client components; props crossing the boundary must be serializable.
- Composition: server components pass *children* into client shells (`<ClientTabs>{serverContent}</ClientTabs>`) — interactivity wrapping server-rendered content.
- RSC is a framework feature (Next.js; TanStack Start and React Router are adopting selectively) — in a plain Vite SPA this model simply doesn't apply; don't cargo-cult it there.

## Framework decision (2026)

| Situation | Pick |
|---|---|
| Full-stack app, SEO, content + app hybrid, team default | **Next.js 16** (App Router) |
| SSR + data mutations with web-standards flavor (Remix lineage) | **React Router 7, framework mode** |
| Client-heavy app wanting end-to-end type safety (routes, server functions) | **TanStack Start 1.0** (`createServerFn`, fully typed route tree) |
| Internal tool, dashboard, game shell — no SEO need | **Vite + React SPA** (see web-kickoff) |

State the choice and why in one paragraph; churn between frameworks mid-project is the real cost.

## Next.js 16 best practices

- **Turbopack is the default bundler** — dev and build; webpack-specific config is legacy.
- **Cache Components model**: caching is now *explicit and opt-in*. `"use cache"` at the top of a page/layout/component caches its output; **PPR (stable)** serves the static shell instantly from CDN and streams dynamic holes as they resolve. Think in shells and holes: mark the cacheable frame, let personalized bits stream.
- The old implicit fetch-caching confusion is gone — do not carry Next 13/14 cache folklore forward; cache what you *declare*, nothing else.
- **Server Actions** for mutations: validate input with a schema (zod) at the top, mutate, then `revalidatePath`/`revalidateTag` — actions are public endpoints, treat them like API routes (auth checks inside the action).
- `proxy.ts` replaces middleware for network-boundary logic.
- Streaming discipline: `loading.tsx`/`Suspense` boundaries around slow subtrees; fetch in parallel (`Promise.all` or component-level fetches), never sequential awaits for independent data.
- Platform pieces: `next/image`, `next/font`, route-level `error.tsx`/`not-found.tsx`; metadata API for SEO.

## Data and state (client side)

- Server state on the client → **TanStack Query v5** (the deka data-fetching skill covers patterns in depth — defer to it when installed).
- Forms → actions first; React Hook Form + zod only when complex live client validation UX demands it.
- Global client state → start with URL + component state; reach for zustand/jotai when prop-drilling genuinely hurts (see deka state-management when installed).

## Performance, ranked by leverage

1. Compiler on (free re-render elimination) → 2. RSC/PPR: ship less JS, stream the rest → 3. Suspense boundaries placed around actual slow spots → 4. `next/dynamic` for below-the-fold heavyweights → 5. Bundle/asset diet via the perf-audit skill. Measure before and after; folklore optimizations are how bundles grow.

## Anti-patterns (2026 edition)

`'use client'` at the page root "to be safe"; useEffect data fetching in framework apps; forwardRef in new code; manual memo carpets under the Compiler; sequential awaits for independent data; Server Action bodies without validation/auth; carrying Next 13/14 implicit-caching assumptions into 16; global stores holding server data; SPA-reflexes (client routing everything) inside an RSC app.

