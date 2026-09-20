---
name: vue-modern
description: Modern Vue and Nuxt, current as of August 2026 (Vue 3.5 stable, Vue 3.6 RC with Vapor Mode feature-complete, Nuxt 4.4) - script setup with typed reactive props destructure, defineModel, useTemplateRef, composable discipline, ref vs shallowRef choices, lazy hydration strategies, Vapor Mode adoption guidance, Pinia setup stores plus Pinia Colada for server data, Nuxt 4 app directory, useFetch/useAsyncData/$fetch rules, routeRules hybrid rendering, Nitro server routes and island components, plus a freshness protocol that verifies current versions before locking decisions. Carries an existing-codebase protocol for brownfield projects - detect Vue/Nuxt versions and API style, match the repo's paradigm, migrate only as an explicit opt-in. Use when building, upgrading or optimizing Vue or Nuxt apps, writing composables, choosing Vue state or data-fetching architecture, or asking about current Vue best practices. Türkçe tetikleyiciler - "vue'da en güncel yöntem", "eski vue projesinde çalış", "vue 2 projesi", "vue 3.6 özellikleri", "vapor mode nedir", "nuxt projesi kur", "nuxt best practice", "composable nasıl yazılır", "vue projemi optimize et", "pinia mı vuex mu", "en güncel vue".
---

# Vue Modern (2026)

You build Vue the way it works *now*: `<script setup>` + TypeScript everywhere, composables as the reuse unit, fine-grained reactivity used deliberately, and Nuxt 4 as the full-stack default. Options API is legacy for new code — but existing codebases are governed by the brownfield protocol below, not by this skill's preferences.

Always communicate with the user in their own language.

## Freshness protocol

Knowledge here is current as of **August 2026**: Vue 3.5 stable; **Vue 3.6 in RC** (Vapor Mode feature-complete, alien-signals reactivity refactor; stable expected autumn 2026); Nuxt 4.4 (Vue Router 5, typed layout props); Pinia Colada 1.4. Before locking versions on a new project or upgrade, verify at blog.vuejs.org and nuxt.com/blog — if 3.6 has gone stable or newer majors exist, reality wins and say so.

## Existing codebase protocol (brownfield safety — read before touching an old project)

Everything modern in this skill targets **new code and greenfield decisions**. An existing project is governed by what it already is:

- **Detect reality first**: Vue major from package.json (Vue 2 is a different world — different APIs, different ecosystem), Nuxt version (2/3/4 differ in structure and data-fetching APIs), API style from the code (Options vs Composition, `<script setup>` or not), the state library actually in use.
- **Consistency beats modernity inside a codebase.** In an Options API codebase, new components are Options API unless migration is explicitly the task; no `<script setup>` islands, no Vapor experiments in a production brownfield uninvited.
- **Feature-gate by installed version**: `defineModel` needs 3.4+, reactive props destructure 3.5+, lazy hydration strategies 3.5+, Vapor 3.6+ — never emit code the installed version cannot run.
- **Migration is a proposal, never a side effect.** If moving to Composition API / Nuxt 4 / Vapor would genuinely pay, propose it separately — scope, win, risk, path — and execute through the refactor-safe skill, incrementally. Never mix paradigms in one feature PR uninvited.

## Modern SFC baseline (every new component)

- `<script setup lang="ts">` — no exceptions in new code.
- **Typed props with reactive destructure** (stable since 3.5): `const { size = 'md', label } = defineProps<Props>()` — destructured props stay reactive; the old "destructure loses reactivity" folklore is dead, stop writing `props.x` everywhere.
- **`defineModel`** for two-way binding — replaces the modelValue-prop + update:modelValue-emit ceremony entirely; typed and multiple models supported.
- `defineEmits<{ save: [id: string] }>()` typed tuple syntax; `useTemplateRef('el')` (3.5) instead of matching-name ref gymnastics; `defineExpose` only for genuine imperative APIs.
- Component order: one concern per component; extract logic to composables *before* a component crosses ~150 lines of script.

## Composable discipline (the reuse unit)

- Name `useThing`; return an object of **refs** (destructure-safe), not a `reactive` object.
- Accept flexible inputs: `MaybeRefOrGetter<T>` parameters resolved with `toValue()` — callers pass values, refs or getters interchangeably.
- Side effects cleaned in `onScopeDispose` (works in components *and* manual `effectScope`s); never leak intervals/listeners.
- Check **VueUse** before hand-rolling — 200+ battle-tested composables (storage, sensors, browser APIs); hand-rolling `useLocalStorage` is a smell.
- A composable that reaches into a store, the router *and* fires network calls is a god-composable — split by concern.

## Reactivity, used deliberately

- **`ref` as the default**; `reactive` only for genuinely grouped state you never destructure or replace wholesale.
- **`shallowRef` for big structures** (large lists, editor documents, canvas/game state): replace the `.value` wholesale to trigger, mutate freely without deep-tracking cost — the single biggest cheap win on data-heavy screens.
- `computed` stays pure (no side effects, no async); chains of `watch` writing refs that other `watch`es read = re-derive with `computed` instead.
- `watch` with explicit sources over `watchEffect` when you need control (old-vs-new values, lazy run); `{ once: true }` (3.4+) for fire-once reactions.
- 3.6's alien-signals reactivity refactor makes all of this faster and lighter for free — no code changes required.

## Vapor Mode (3.6 — the headline)

- What it is: per-file compilation of SFCs to **direct DOM operations — no virtual DOM, no VNode allocation**. Vapor-only components ship a 20–50% smaller runtime slice and cut re-render cost dramatically (Solid-class update performance).
- Opt-in per component: `<script setup vapor>`. Interop lets Vapor components live inside a VDOM app (and vice versa) with boundaries — but libraries that touch VNodes directly (render-function tricks, some UI kits) won't work inside Vapor files.
- Adoption guidance (honest): as of Aug 2026 it is **RC** — adopt now for hot paths in side projects and perf-critical leaf components (dashboards, big lists, game HUD overlays in Vue); hold the "vapor by default" decision for production apps until stable lands. Verify status via the freshness protocol.

## State architecture

- Ladder: component state → provide/inject for subtree config → **Pinia** (setup-store style: `defineStore('cart', () => { ... return { items, total, add } })`) only for genuinely shared client state.
- **Server data is not store data**: caching backend responses in Pinia by hand (loading flags, error fields, invalidation timers) is the 2026 smell. Use **Pinia Colada** — `useQuery`/`useMutation` with cache, dedupe, invalidation, optimistic updates, SSR support (~2kb, by Pinia's author). TanStack Query Vue is the equivalent alternative; pick one, not both.

## Performance, ranked by leverage

1. `shallowRef`/`shallowReactive` on large data structures → 2. **Lazy hydration** (3.5+): `defineAsyncComponent({ hydrate: hydrateOnVisible() / hydrateOnIdle() })` for below-the-fold islands → 3. `v-memo` on hot list rows with explicit deps; `v-once` for truly static subtrees → 4. Virtualize long lists (vue-virtual-scroller / VueUse `useVirtualList`) → 5. Vapor for the hottest components (above) → 6. Bundle/asset diet via the perf-audit skill.

## Nuxt 4 best practices

- **Structure**: app code lives in `app/` (pages, components, composables, layouts); `server/` for Nitro; `shared/` for cross-context code — each gets its own TypeScript project (typed per runtime).
- **Data fetching rules** (the classic interview question, settled):
  - `useFetch(url)` — the default for component data (SSR-transferred, cached, deduped).
  - `useAsyncData(key, fn)` — same guarantees, custom logic ($fetch + transforms, multiple calls).
  - `$fetch` — **only** inside event handlers and server code; naked `$fetch` in setup double-fetches (server + client) with no payload transfer.
  - Nuxt 4 extras: same-key calls share data automatically, reactive keys refetch on change, unmount cleanup is built in.
- **Hybrid rendering via `routeRules`**: per-route SSR/SSG/ISR/SPA (`'/blog/**': { isr: 3600 }`, `'/admin/**': { ssr: false }`) — one app, mixed strategies; `sharedPrerenderData` (default) dedupes fetches across prerendered pages.
- **Nitro**: API routes in `server/api/` (`defineEventHandler`), server middleware, scheduled tasks; deploy presets for every platform.
- **Island/server components** (`.server.vue` + `<NuxtIsland>`) for zero-JS content chunks inside interactive pages.
- Auto-imports: embrace for Vue/Nuxt APIs and your composables; keep explicit imports for third-party libs (traceability); modules worth defaulting - @nuxt/image, @nuxtjs/seo, @vueuse/nuxt.

## Framework decision (2026)

| Situation | Pick |
|---|---|
| App with SEO/SSR/full-stack needs, content+app hybrid | **Nuxt 4** |
| Internal tool, dashboard, game shell — no SEO | **Vite + Vue SPA** (see web-kickoff) |
| Content-first site with sprinkles of Vue | **Astro + Vue islands** |

## Anti-patterns (2026 edition)

Options API in new code (absent a team standard); `props.x` verbosity out of destructure fear (3.5 killed the reason); naked `$fetch` in setup; Pinia stores hand-caching server responses; watch-chains instead of computed; `reactive()` for everything then losing it in a destructure; god-composables; deep-reactive 10.000-row lists (use shallowRef); skipping lazy hydration on below-the-fold islands; adopting Vapor everywhere before it's stable while its RC status stands.

