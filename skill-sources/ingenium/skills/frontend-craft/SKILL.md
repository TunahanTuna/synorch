---
name: frontend-craft
description: Framework-agnostic frontend engineering best practices - semantic HTML that earns free accessibility and SEO, forms done right, modern CSS defaults (grid/flex decisions, logical properties, clamp, container queries), URL-as-state, explicit loading/empty/error states, platform-first dependency discipline, security hygiene, i18n readiness, and structuring a codebase so AI sessions stay token-efficient and accurate. Use for general frontend best-practice questions, "what is the right way to do X in frontend", reviewing frontend fundamentals, or optimizing a codebase for AI-assisted development. Türkçe tetikleyiciler - "frontend best practice", "en doğru yöntem hangisi", "frontend'de nasıl yapılır", "html yapısı doğru mu", "form nasıl yapılmalı", "css'i düzgün kur", "kodu ai için optimize et", "token verimli çalış".
---

# Frontend Craft

You are a frontend platform engineer. Your bias: **use the platform first** — semantic HTML, native form behavior, modern CSS and built-in browser APIs solve most problems with zero bytes shipped. Libraries earn their place only after the platform demonstrably falls short. Framework-specific review (React hooks, re-renders) belongs to the deka-engineering-react skills when installed; this skill owns the layer beneath.

Always communicate with the user in their own language.

## Semantic HTML — the free wins

- Structure with landmarks (`header nav main aside footer`), one `h1`, headings in order without skipping levels. Screen readers, SEO, reader mode and keyboard users all ride on this for free.
- **Button vs link** is not style, it is behavior: `<a>` navigates (works with middle-click, copy-link), `<button>` acts. A div with onClick is neither — it is invisible to keyboards and assistive tech.
- Native elements before ARIA and before JS: `<details>`, `<dialog>`, `<datalist>`, the Popover API cover accordions, modals, autocomplete and dropdown menus with focus and keyboard behavior built in. First rule of ARIA — don't use ARIA where a native element exists.
- Lists are `ul/ol`, tabular data is `table` (with `th scope`), quotations are `blockquote`. Semantics are data — scrapers, AI agents and future you all read them.

## Forms done right

- Every input has a `<label>` (clicking the label focuses the input — users expect it). Placeholder is not a label.
- Use the right types and hints: `type="email"`, `inputmode="numeric"`, `autocomplete="email|name|one-time-code|..."` — mobile keyboards and password managers depend on these.
- Validation layers: native constraint validation (`required`, `pattern`, `minlength`) as the floor, custom validation on top; show errors next to the field, linked via `aria-describedby`, on blur or submit — never while the user is still typing the first attempt.
- Never make a disabled submit button the only validation feedback (users click it and nothing explains why). Submit → validate → focus the first invalid field.
- Forms submit on Enter; keep that working. Progressive enhancement: a form that does something without JS is the most robust version of itself.

## Modern CSS defaults

- **Grid for 2D layout and page scaffolding, flexbox for 1D rows/columns.** `gap` over margin-hacks in both.
- Spacing between siblings: `gap` or a stack utility, not `margin-bottom` sprinkled per element (margins couple components to their context).
- **Logical properties** (`margin-inline-start`, `padding-block`) — free RTL-readiness, same effort.
- Fluid type and spacing with `clamp()` (e.g. `clamp(1rem, 0.9rem + 0.5vw, 1.25rem)`) — kills half your breakpoints.
- **Container queries** for components that adapt to their container, media queries only for page-level layout.
- Custom properties as the theming/token interface (see design-system skill); `aspect-ratio` instead of padding-top hacks; `:has()` for parent-state styling; `@layer` to keep cascade order deliberate.
- Specificity discipline: single-class selectors by default; if you are writing `!important`, the cascade design failed upstream.
- Scrolling: `overflow-x: auto` containers for wide content; `scroll-margin-top` for anchor targets under sticky headers; `overscroll-behavior` on modals/drawers.

## URL as state

If a user would want to share, bookmark or back-button it, it belongs in the URL: active tab, filters, search query, pagination, selected item. Search params are the state container; the back button must never surprise. Ephemeral UI state (open dropdown) stays out.

## The three-states rule

Every async view explicitly designs **loading** (skeleton matching the final layout — no spinner-only, no layout shift), **empty** (first-run guidance, not a blank div), **error** (what failed + retry action, in human words). If a designer never drew them, that is a gap to raise, not to improvise into `null`.

## Dependency discipline (platform first)

Before adding a package ask: does the platform do this? — `fetch`, `Intl.NumberFormat`/`DateTimeFormat`/`RelativeTimeFormat`, `structuredClone`, `crypto.randomUUID`, `<dialog>`, Popover API, CSS scroll-snap and view transitions replaced whole library categories. If a library still earns it, check cost (bundle impact, maintenance, types) — see perf-audit's bundle diet for the removal direction.

## Security hygiene

Escape by default (frameworks do — the danger is opt-outs like `dangerouslySetInnerHTML`/`v-html`); sanitize any rich HTML with DOMPurify; user URLs get protocol validation (`javascript:` links are XSS); no secrets in client code — anything shipped to the browser is public; auth tokens in `httpOnly` cookies beat localStorage; add a CSP when the app handles anything sensitive. Deeper audit → deka security-review / security-audit skills when installed.

## i18n readiness (cheap now, brutal later)

Never concatenate sentence fragments (word order differs across languages) — use template messages with placeholders; all date/number/currency/plural formatting through `Intl.*`, never hand-rolled; logical CSS properties (above) keep RTL on the table; leave 30–40% width headroom in UI copy (German exists); language is a user setting, not `navigator.language` alone.

## Token-efficient codebase (working with AI on frontend)

Structure the repo so AI sessions are cheap and accurate — the same properties that help new human teammates:

- **Small, focused files** (roughly 100–300 lines). AI reads whole files; a 2000-line god component costs 10× the tokens of the 200-line slice that mattered, every single session. Splitting god files is the single highest-ROI optimization (refactor-safe skill does it without breakage).
- **Feature colocation**: component + hook + api + types of a feature in one folder — one directory read gives full context instead of a scavenger hunt across `components/`, `hooks/`, `utils/`, `types/`.
- **Descriptive, conventional, greppable names**: `useCheckoutTotals.ts` is found in one search; `utils2.ts` forces reading five files to locate logic. Boring standard patterns beat clever abstractions — AI (and humans) predict boring correctly on the first try.
- **Types as the single source of truth**: schema-first (zod schema → inferred types) means AI derives every shape from one file instead of reverse-engineering implementations.
- **CLAUDE.md kept current** (project-onboard skill): commands, conventions and gotchas paid for once, not re-discovered every session; keep docs in sync (docs-sync skill) so AI never acts on stale claims.
- **Delete dead code** — AI cannot tell dead from alive; it reads it, reasons about it and preserves consistency with it. Dead code costs tokens *and* correctness. Formatter-enforced style keeps diffs signal-only.
- **In-session habits**: name exact file paths instead of "the header component"; ask for targeted edits, not file regeneration; batch related small changes into one request.

