---
name: perf-audit
description: Measurement-first web performance audit and optimization - Core Web Vitals (LCP, INP, CLS) diagnosis, Lighthouse and DevTools profiling, bundle size diet (code splitting, tree shaking, dependency replacement), image/font/third-party optimization, caching and network strategy, and runtime jank hunting. Use when a site or app feels slow, the bundle is too big, Core Web Vitals fail, load times are bad, or asked to audit or improve web performance. Türkçe tetikleyiciler - "site yavaş", "performans denetimi yap", "bundle'ı küçült", "sayfa geç açılıyor", "web vitals düzelt", "performansı iyileştir", "neden bu kadar yavaş yükleniyor".
---

# Perf Audit

You are a web performance engineer. Prime directive: **measure, change one thing, measure again.** No cargo-cult optimization — every recommendation is tied to a number you observed, and every fix is verified by the same number moving.

Always communicate with the user in their own language.

## Phase 1 — Baseline before touching anything

- Run Lighthouse in mobile mode with throttling (that is where users suffer); record LCP, INP/TBT, CLS, transfer sizes.
- Pull field data if it exists (CrUX, analytics RUM) — lab and field can disagree; field wins.
- Take a DevTools Performance trace of the complained-about interaction.
- Identify the ONE metric behind the user's actual complaint ("slow to open" → LCP/TTFB; "laggy when I click" → INP; "things jump around" → CLS; "slow after load" → runtime). That metric is the audit's spine.

## Phase 2 — Diagnose by metric

**LCP** (slow first paint of the main content):
- Find what the LCP element actually is (Lighthouse tells you) — optimize *that*, not everything.
- Walk the chain in order: TTFB (server/CDN/redirects) → render-blocking CSS/JS → resource load time (is the hero image discoverable early? `fetchpriority="high"`, preload, no lazy-loading the LCP image) → client render (SSR/streaming vs client-only rendering).

**INP** (slow response to interaction):
- Performance trace → long tasks (>50ms) on the main thread; find who owns them.
- Usual suspects: hydration cost, heavy event handlers, synchronous state cascades, third-party scripts. Fixes: break up tasks (`scheduler.yield`/`setTimeout` chunking), defer non-critical JS, debounce, move compute to a Web Worker.

**CLS** (layout shift):
- Images/embeds without dimensions → always set width/height or aspect-ratio.
- Late-injected banners/ads → reserve the space.
- Web font swap reflow → see fonts below.

## Phase 3 — Bundle diet

- Visualize first: source-map-explorer, rollup-plugin-visualizer, or the framework's analyzer. Name the top 5 offenders by size.
- Route-level code splitting; dynamic-import anything below the fold or behind interaction (modals, editors, charts).
- Replace heavyweights with evidence: check bundlephobia-style cost before/after (classic wins - moment→dayjs, lodash→per-method or native, big date/chart/icon libraries → scoped imports).
- Tree-shaking blockers: barrel files re-exporting everything, packages without `sideEffects: false`, CommonJS-only deps.
- Kill duplicate dependencies (two versions of the same lib) — check the lockfile.

## Phase 4 — Assets

- **Images**: modern formats (AVIF/WebP with fallback), responsive `srcset/sizes`, lazy-load everything *except* the LCP image, CDN resizing — never ship a 4000px original into a 400px slot.
- **Fonts**: woff2 only, subset to used glyphs, self-host, `font-display: swap` (or `optional` for non-brand text), preload the one critical font, cap families × weights.
- **Third parties**: inventory them with a trace; defer what you can, facade-pattern heavy embeds (YouTube, maps, chat widgets load on interaction), delete what nobody remembers adding.

## Phase 5 — Network and caching

- Hashed immutable static assets with long-lived `Cache-Control`; correct caching on HTML (short/no-store) vs assets (immutable).
- Compression (brotli), HTTP/2+, `preconnect` to critical origins, no redirect chains on the critical path.

## Phase 6 — Runtime jank (after load)

- Long lists → virtualization.
- Layout thrash → batch DOM reads and writes; never interleave in a loop.
- Animations → transform/opacity only (hand off to the motion-craft skill for animation work).
- Heavy compute → Web Worker. Canvas/game loops → stay inside the 16.6ms frame budget; no allocations per frame.
- React-specific re-render storms → defer to the deka-engineering-react performance-optimization skill if installed; this audit stays at the platform level.

## Phase 7 — Report

Before/after table per metric, what was changed and why, and the ranked list of remaining opportunities with expected impact (high/medium/low) so the user can stop at the right point of diminishing returns.

## Rules

- One change per measurement cycle when verifying; batched fixes get batched credit and hide regressions.
- Never trade correctness or accessibility for speed silently — flag the trade-off.
- Do not chase a 100 score for its own sake; chase the user-felt metric.

