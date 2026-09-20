---
name: design-system
description: Design and build a component library or design system - design tokens (semantic color, spacing, typography scales), light/dark theming as a token swap, primitive-first component architecture on headless libraries (Radix, React Aria), clean variant APIs instead of boolean prop explosions, baked-in accessibility, documentation and versioning. Use when starting a component library, standardizing inconsistent UI, implementing design tokens, adding theming or dark mode infrastructure, or building reusable components properly. Türkçe tetikleyiciler - "design system kur", "component library oluştur", "tasarım sistemi", "ui'ı standardize et", "tema sistemi ekle", "dark mode altyapısı kur", "design token yapısı", "ortak component kütüphanesi".
---

# Design System

You build design systems that fit their team. Reality check first: a solo project needs a *lightweight* system — tokens plus ten disciplined components — not an enterprise Storybook pipeline. Scale the ceremony to the number of people who must agree.

Always communicate with the user in their own language.

## Phase 1 — Tokens before components

Components built before tokens hardcode chaos. Establish, in order:

- **Color, two layers**: a raw palette (gray-50…gray-950, brand scales) and a **semantic layer** the components actually use — `bg`, `surface`, `text`, `text-muted`, `border`, `accent`, plus state variants (hover/active/disabled) and intent colors (danger/warning/success/info). Components never touch raw hex or palette steps directly.
- **Spacing**: one scale, 4px base (4, 8, 12, 16, 24, 32, 48, 64). Off-scale one-off values are bugs.
- **Typography**: max 2 families; 4–6 sizes with paired line-heights; 2–3 weights. Name by role (body, caption, heading-1) not by pixel.
- **Radii, shadows, z-index**: small fixed scales; z-index especially must be a token ladder (dropdown < sticky < overlay < modal < toast) or stacking wars begin.
- **Motion tokens**: 2–3 durations + 2 easings (see the motion-craft skill).

Implementation: CSS custom properties for the semantic layer (theme-swappable at runtime), mapped into the framework's theme (Tailwind theme config, styled-system, vanilla-extract — whatever the project uses).

## Phase 2 — Theming

- Dark mode is a **semantic-token swap**, never per-component rewrites: `[data-theme="dark"]` redefines the semantic custom properties; components don't know themes exist.
- Default from `prefers-color-scheme`, allow explicit override, persist the choice.
- Re-verify contrast in *both* themes (4.5:1 body text, 3:1 large text/UI); dark mode fails contrast more often than light.
- Don't invert shadows in dark mode — use surface elevation (lighter surface = higher) instead.

## Phase 3 — Component architecture

- Build order: **primitives** (Button, Text, Input, Icon, Stack/Box) → **composites** (Field = Label+Input+Error, Card, Dialog) → **patterns** (forms, tables, page shells).
- Hard interaction/a11y components (Dialog, Menu, Combobox, Tabs, Tooltip) go on a **headless library** — Radix, React Aria, Headless UI. Hand-rolling focus traps and aria wiring is how systems ship broken modals.
- **Variant API discipline**: `variant` / `size` / `tone` enums (CVA or typed props) — never boolean explosions (`isPrimary isLarge isDanger` → impossible combinations). Same enum values across all components: `size="sm|md|lg"` everywhere.

## Phase 4 — Component API rules

- Composition over configuration: `children` and slots beat a 12-prop configuration object; compound components (`Card.Header`) for structured content.
- Forward refs; spread `...rest` onto the root element; merge incoming `className` (cn/tailwind-merge) so consumers can escape-hatch.
- Controlled *and* uncontrolled modes for inputs where it matters.
- Polymorphic `as` prop only where genuinely needed (Text, Button-as-link).
- A component that needs a bugfix in every consumer has the wrong API — fix the abstraction.

## Phase 5 — Quality gates (every component)

Keyboard operable; visible `:focus-visible` state; ARIA correct (via the headless layer); works in both themes; RTL-safe (logical properties — `margin-inline-start`, not `margin-left`); responsive by default; states covered: hover, focus, active, disabled, loading, error, empty.

## Phase 6 — Documentation and distribution

- Small project: a `/kitchen-sink` route rendering every component in every variant and both themes — cheap, always current, doubles as a visual regression page.
- Team/published: Storybook with usage do/don't notes per component; changesets + semver; deprecate before removing (`@deprecated` JSDoc + console warning one minor ahead).

## Anti-patterns

Wrapping a UI kit 1:1 with no added value (just use the kit); tokens nobody enforces (add a lint rule against raw hex/px); theming everything before one theme works; the God-Button with 25 props; building pattern-level components before the primitives are stable; snapshots-of-everything instead of a browsable kitchen sink.

