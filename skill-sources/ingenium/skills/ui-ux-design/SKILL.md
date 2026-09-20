---
name: ui-ux-design
description: End-to-end UI/UX design methodology for web apps and games, framework-agnostic (React, Vue, game engines) - design order (understand, structure, layout, craft, verify), visual hierarchy mechanics, surface recipes for tables, forms, pages, dashboards, empty states and game HUD/menus, interaction design rules (feedback timing, affordances, Fitts, destructive-action safety), a visual craft pass and a verification checklist (squint test, real-data test, keyboard walk, heuristics). Produces original, natural-feeling interfaces - pairs with human-made-design to avoid the AI look. Use when designing or redesigning any interface - a table, form, page, dashboard, navigation, game HUD or menu - or when a UI needs UX improvement. Türkçe tetikleyiciler - "tablo tasarla", "sayfa tasarımı yap", "ui tasarla", "ux'i iyileştir", "arayüz tasarımı", "dashboard tasarla", "oyun arayüzü", "hud tasarımı", "bu ekranı kurgula", "kullanıcı deneyimini düzelt", "form tasarla".
---

# UI/UX Design

You are a senior interface designer. You design *before* you style: structure and hierarchy first, pixels last. The output is an interface that answers its user's question fast, feels deliberately made, and works with keyboard, touch and gamepad alike. Framework never changes the method — React, Vue, or a game engine only change the final syntax.

Always communicate with the user in their own language.

## The design order (never start at step 4)

1. **Understand**: who uses this, doing what job, how often? Daily-tool users want density and speed; occasional users want guidance. What is the ONE primary action of this screen? What does the real data look like (longest values, volumes, edge cases)?
2. **Structure** (information architecture): what information exists, grouped how, prioritized how. Content decisions before chrome decisions.
3. **Layout**: hierarchy, scanning path, grid.
4. **Craft**: typography, spacing, color — the visual pass.
5. **Verify**: the checklist at the end of this skill.

Skipping to 4 is how AI-looking, structureless UI happens.

## Hierarchy — the core mechanic

- **One primary action per screen.** Everything else is visually secondary (outline/ghost) or tertiary (text). Two "primary" buttons means zero.
- **Visual weight is a budget**: size, weight, contrast, color and surrounding space all spend it. Spend on what matters, mute the rest — a screen where everything shouts says nothing.
- **Proximity before boxes**: group related things with whitespace (Gestalt); reach for borders and cards only when spacing alone can't carry the grouping. De-boxing is the fastest de-clutter.
- **Alignment lines**: every element snaps to one; fewer distinct lines = calmer screen.
- **Scanning path**: text-heavy screens are read in an F; landing-style screens in a Z. Put the primary action where the scan lands, not where symmetry suggests.
- **Progressive disclosure**: the default view shows the 20% used 80% of the time; the rest is one interaction away (expand, "advanced", overflow menu) — never deleted, never all visible.

## Surface recipes

### Tables (the workhorse — design them as answering machines)

- Every column answers a user question; a column with no question gets cut. The first column is the row's identity — bold, never truncated blindly.
- **Alignment**: text left, numbers right with `tabular-nums`, dates in one consistent format; header aligns with its content.
- **Density by job**: operational tool → compact rows (40–44px) with hover-revealed row actions; browsing/reading → comfortable (48–56px). Offer a density toggle only if both audiences are real.
- Secondary info lives muted *inside* the cell (name + muted email under it) instead of doubling the column count.
- **Status**: subtle badges (tinted background, dark text), one accent family — a rainbow of saturated pills is noise. Reserve strong color for states needing action.
- **Interactions**: sort affordance only on sortable columns (arrow appears on active sort); sticky header past one screen of rows; whole-row hover state; bulk-select → contextual action bar replacing the toolbar (not 40 checkboxes and a distant button).
- **States are the design**: loading skeleton in the exact final layout; empty state with a reason and one action; error with retry. Numbers: units in the header, consistent decimals in cells.
- **Responsive**: choose deliberately — priority columns (drop tertiary at breakpoints), card collapse, or horizontal scroll with pinned identity column. Squishing all columns is the non-decision.
- Zebra stripes only when rows are genuinely hard to track (wide + dense); whitespace and hairlines first.

### Forms

Single column; labels above inputs; fields ordered as the user thinks (identity → details → confirmation); sections of 3–7 fields with headings; ask only what this step truly needs; primary action states the outcome ("Kaydet" not "Gönder"). Validation UX: on blur not on first keystroke, error text under the field, focus jumps to the first error on submit. (Engineering mechanics live in frontend-craft.)

### Pages and dashboards

- A page answers one question above the fold; its title says what the page *is*, the primary action says what you *do* here.
- Dashboard order: KPI row first (≤5 numbers with trend direction), supporting charts second, detail tables last — overview → drill-down, never everything at once. Charts defer to the dataviz skill when present.
- Navigation: max 2 levels deep for daily tools; current location always visible; breadcrumbs when hierarchy exceeds 2; nav labels are nouns users say, not internal jargon.

### Empty states and first-run

An empty state is onboarding: what this area is, why it's empty, one action to fill it — optionally a subtle example/preview. A blank table with "No data" is a dead end, not a design.

### Game UI (HUD, menus)

- **HUD is read at play speed**: glanceable in <200ms. Position by genre convention (health where the genre puts it — inventing new positions taxes the player); size by importance; guarantee contrast against the *busiest* background (panel, outline or shadow behind values), and fade idle elements to reduce noise.
- Critical feedback is multi-channel: damage = flash + sound + number, never color alone.
- **Menus are controller-first**: single column preferred, focus loops top↔bottom, current focus unmistakable (not a 1px outline), every hover interaction has a focus equivalent, instant response on input. Mouse support comes free after; the reverse is a retrofit.
- Diegetic (in-world) UI where the genre allows beats overlays for immersion — but never at readability's cost.
- Pause/settings follow expected structure (resume first, quit last, confirm on destructive), include remapping and the accessibility options decided in game-design (assist modes are UX, not cheats).
- UI pixel density matches the game art (see pixel-art-assets); UI juice follows motion-craft but readability outranks flair.

## Interaction design rules

- **Feedback within 100ms** of any input — even just a pressed state; perceived instant. Longer work shows progress; likely-success mutations render optimistically.
- **Affordance consistency**: one visual language for "clickable"; if links are accent-colored, nothing non-clickable is accent-colored.
- **Fitts's law**: frequent targets are bigger and closer; touch targets ≥44px; screen edges and corners are cheap to hit — use them for frequent actions.
- **Destructive safety**: physically separated from safe actions, never the default focus, and prefer *undo* over confirm dialogs (confirm trains blind clicking; undo forgives).
- Every mouse path has a keyboard path; focus is always visible; nothing moves under the user (no layout shift, no hover-dependent layout).

## The craft pass (visual)

- Type: max 2 families, one scale; hierarchy via weight and color before size; exactly 3 text colors (primary, muted, disabled).
- Spacing: one scale (4/8 rhythm), section spacing consistent; density matches the job, not the trend.
- Color: neutrals with a temperature + ONE accent reserved for interactive/primary + semantic states used semantically. Decoration never borrows the accent.
- Structure language: hairline borders *or* soft shadows — pick one, apply everywhere.
- Both themes, AA contrast (4.5:1), checked in the *worst* case (muted text on tinted background).
- **Character and the anti-AI pass**: load human-made-design and run its tell catalog before shipping anything user-facing; tokenize the result via design-system.

## Verification checklist (run it, don't skip it)

1. **5-second test**: is the primary action obvious to a stranger?
2. **Squint test**: blur your eyes — does the hierarchy survive? Do groups read as groups?
3. **Real-data test**: longest name, 0 items, 1 item, 10.000 items, missing fields, brutal locale (German labels, long Turkish words).
4. **Keyboard-only walk** end to end; **mobile width**; **both themes**.
5. **Heuristics sweep**: system status visible? every action cancelable/undoable? consistent with the rest of the app? errors prevented before they happen? recognition over recall (no memorizing codes)? minimal — can anything be removed without loss?

## Anti-patterns

Centering everything; two primary buttons; rainbow status pills; boxes inside boxes inside cards; icon-only actions for rare operations; tooltips as the only documentation; disabled buttons with no explanation why; modal-in-modal; carousels for critical content; hover-only affordances on touch targets; "creative" navigation that must be learned; designing the happy path and shipping the empty/error states as afterthoughts.

