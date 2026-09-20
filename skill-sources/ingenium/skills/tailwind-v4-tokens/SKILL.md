---
name: tailwind-v4-tokens
description: Tailwind CSS v4 token architecture and its silent failure modes - the three-layer setup (raw palette to theme-scoped semantic tokens to an @theme inline handoff), why @theme inline is mandatory for values that change at runtime, why hand-written CSS classes never get hover/focus variants and fail without a build error, @utility and @variant for real custom utilities, custom breakpoints via --breakpoint-*, opacity modifiers on custom tokens, and CSS-first config differences from v3. Carries executable diagnostics - grep patterns that find variant-on-custom-class bugs and escaped-selector verification in the compiled CSS. Use when setting up or migrating Tailwind 4 theming, when hover/focus/dark styles silently do nothing, when a class sits in the markup but has no effect, or when wiring CSS variables into Tailwind. Türkçe tetikleyiciler - "tailwind 4'e geç", "hover çalışmıyor", "sınıf uygulanmıyor", "tema token sistemi kur", "dark mode altyapısı", "css değişkenini tailwind'e bağla", "stil neden gitmiyor".
---

# Tailwind v4 Tokens

Tailwind v4 fails **silently**. A class it does not own produces no CSS, no warning and no non-zero exit — the build is green and the pixels are missing. This skill owns that mechanic: which classes Tailwind can generate, how to hand CSS variables over so theming survives, and how to prove a class actually compiled. Token *taste* (which semantic roles exist, contrast in both themes) belongs to the design-system skill.

Always communicate with the user in their own language.

## Phase 1 — Diagnose an existing project

The failure has one shape: a class is **hand-written CSS**, but used **with a variant**. Tailwind generates variants only for utilities it owns — its own, `@theme`-derived, or `@utility`-registered. `hover:bg-theme-card` where `.bg-theme-card` is your own rule compiles to nothing.

**Why no error:** the compiler scans source files for candidate strings and emits CSS for recognized ones. An unrecognized candidate is indistinguishable from any ordinary class name (`card`, `swiper-slide`, a third-party class) — erroring would break every project on earth. Class attributes are opaque strings; nothing type-checks them. Missing pixels are the only signal.

**Find variant-on-custom-class bugs** — every class defined in your CSS, cross-checked against variant usage in source:

```bash
rg -oNI -g '*.css' '^\.([a-z0-9-]+)' src | sed 's/^\.//' | sort -u | while read -r c; do
  rg -qI "(hover|focus|focus-within|focus-visible|active|disabled|group-hover|peer-focus|dark|xs|sm|md|lg|xl|2xl):$c\b" src \
    && echo "DEAD: variant used on hand-written class -> $c"
done
```

It flags *variant* usage only — a hand-written class used bare (`class="bg-theme-card"`) still works as ordinary CSS, so that one is a naming problem, not a broken-pixel one.

**Find invented breakpoints** — v4 ships `sm md lg xl 2xl` only; anything else must be a `--breakpoint-*` token, or the chain silently loses a step and two branches of a `hidden xs:inline sm:hidden` sequence show at once:

```bash
rg -oI '\b(xs|sm|md|lg|xl|2xl|3xl):' src | sort -u        # variants in use
rg -n -g '*.css' -- '--breakpoint-' src                   # variants actually defined
```

**Prove a class compiled** — build, then find the escaped selector in the output CSS. Ground truth, not a guess. The output selector is `.hover\:bg-hover:hover`; match the backslash with a wildcard `.` instead of escaping it — a backslash eaten by a shell quoting layer turns a working class into a false zero, and a lying verifier is worse than none:

```bash
npm run build
rg -c 'hover.:bg-hover|focus-within.:border-accent' dist/assets/*.css  # no output = not generated
rg -o -- '--color-[a-z-]+' dist/assets/*.css | sort -u                 # tokens Tailwind knows
```

Calibrate it once against a class you know exists and once against an invented name that must return nothing.

## Phase 2 — `@theme` vs `@theme inline`

The single most consequential decision. `@theme` emits the token as a variable in `:root` and points utilities at *that* variable; `@theme inline` substitutes the referenced value straight into the utility. Both compile, so the difference only shows up as a theme toggle that does nothing.

```css
/* WRONG — one indirection too many */
@theme {
  --color-surface: var(--bg-surface);
}
/* emits :root { --color-surface: var(--bg-surface) }
          .bg-surface { background-color: var(--color-surface) }
   --bg-surface is resolved on the root element and inherited as a finished value. */
```

```css
/* RIGHT */
@theme inline {
  --color-surface: var(--bg-surface);
}
/* emits .bg-surface { background-color: var(--bg-surface) }
   resolved on the element itself, so the nearest .light/.dark ancestor wins. */
```

Be precise about when the wrong version bites, or you will "disprove" it by accident: with `.dark` on `<html>` (the root element) a global toggle appears to work, because root is where the resolution happens. It breaks when the theme class sits anywhere else (`<body>`, an app wrapper) and it breaks for **nested** theme scopes — a light-themed panel inside a dark page — even when the class is on `<html>`. The inline version is correct in all three cases, which is why it is the default here.

**Rule:** literal value → `@theme`. A `var()` whose value is redefined in any scope (`.dark`, `[data-theme]`, a subtree) → `@theme inline`.

## Phase 3 — Three-layer token architecture (copyable skeleton)

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

/* Layer 1 — raw palette. Theme-independent, never referenced by components. */
:root {
  --gray-50: oklch(0.985 0 0); --gray-200: oklch(0.92 0.004 260);
  --gray-400: oklch(0.71 0.012 260); --gray-800: oklch(0.28 0.014 260);
  --gray-950: oklch(0.15 0.012 260);
  --brand-400: oklch(0.70 0.16 255); --brand-500: oklch(0.62 0.19 255);
}

/* Layer 2 — semantic roles, redefined per theme. The only layer that knows themes. */
.light {
  --bg-base: var(--gray-50); --bg-surface: #fff; --bg-hover: var(--gray-200);
  --fg-base: var(--gray-950); --fg-muted: var(--gray-400);
  --line: var(--gray-200); --accent: var(--brand-500);
}
.dark {
  --bg-base: var(--gray-950); --bg-surface: var(--gray-800);
  --bg-hover: oklch(0.33 0.014 260);
  --fg-base: var(--gray-50); --fg-muted: var(--gray-400);
  --line: var(--gray-800); --accent: var(--brand-400);
}

/* Layer 3 — handoff. Runtime-swapped values MUST be inline. */
@theme inline {
  --color-base: var(--bg-base);
  --color-surface: var(--bg-surface);
  --color-hover: var(--bg-hover);
  --color-fg: var(--fg-base);
  --color-muted: var(--fg-muted);
  --color-line: var(--line);
  --color-accent: var(--accent);
}

/* Static scales — no runtime swap, so plain @theme. */
@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --radius-card: 0.75rem;
  --text-caption: 0.8125rem; --text-caption--line-height: 1.4;
  --shadow-card-lifted: 0 12px 32px oklch(0 0 0 / 0.16);
  --breakpoint-xs: 30rem;
  --animate-fade-in: fade-in 200ms ease-out;
  @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
}
```

What this buys: `bg-surface`, `text-muted`, `border-line`, `hover:bg-hover`, `focus-within:border-accent`, `hover:shadow-card-lifted`, `xs:inline`, `animate-fade-in` all compile natively, with every variant, because Tailwind owns them. Note that `dark:` variants become largely unnecessary for color — the swap happens one layer below. Keep `@custom-variant dark` for the exceptions only (an inverted image filter, a different shadow strategy).

## Phase 4 — v4 mechanics worth knowing

- **Own utilities via `@utility`** — the fix for `transition-smooth` / `interactive-scale` style helpers. Registered utilities get variants; `.class {}` rules do not. `@variant` applies a Tailwind variant inside custom CSS:

  ```css
  @utility transition-smooth {
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  @utility interactive-scale {
    transition: transform 150ms ease-out;
    @variant hover { transform: scale(1.02); }
    @variant active { transform: scale(0.98); }
  }
  ```
  Verify with the Phase 1 escaped-selector grep — `rg -c 'md.:interactive-scale' dist/assets/*.css` must be non-zero.

- **Opacity modifiers work on custom tokens**: `bg-surface/60` compiles to `color-mix(in oklab, var(--bg-surface) 60%, transparent)`, behind a `@supports` guard with the flat color as fallback. It requires the token to resolve to a *color* — a var holding a gradient or a shadow yields nothing usable.

- **Custom breakpoints** are tokens: `--breakpoint-xs: 30rem` in `@theme` creates the `xs:` variant; without the token the prefix is simply dropped.

| v3 | v4 |
|---|---|
| `tailwind.config.js` | CSS-first `@theme` (legacy opt-in: `@config "./tailwind.config.js"`) |
| `@tailwind base/components/utilities` | `@import "tailwindcss"` |
| `content: [...]` globs | automatic source detection |
| `theme.extend.colors` | `--color-*` in `@theme` / `@theme inline` |
| `@layer utilities { .foo {} }` | `@utility foo { }` |
| `darkMode: 'class'` | `@custom-variant dark (&:where(.dark, .dark *))` |

## Phase 5 — Migration order (each step has a done-check)

1. **Tokens first.** Build the three layers; keep the old classes alive alongside so nothing breaks mid-flight. *Done-check:* toggling `.dark` on the root element changes computed colors in DevTools, and `--color-*` names appear in the built CSS.
2. **Variant audit.** Replace every variant-prefixed custom class with a token-derived utility; register genuine helpers with `@utility`; define missing breakpoints. *Done-check:* the Phase 1 loop prints nothing, and every variant class in the diff appears as an escaped selector in `dist`.
3. **Dead class sweep.** Delete the hand-written color classes and any never-defined utilities. *Done-check:* `rg -w '<class-name>' src` returns zero hits per removed class; CSS bundle size drops.
4. **Contrast verification** in both themes — hand off to the design-system skill (4.5:1 body, 3:1 large text and UI); a token swap that compiles can still be unreadable.

## Anti-patterns

Hand-writing `.my-color { color: var(--x) }` for anything Tailwind could generate from a token; defining the same token in both `@theme` and `:root` (two sources of truth, whichever loses is the confusing one); `@theme` for a value redefined under `.dark`; using variants on classes you wrote yourself; relying on a utility that was never defined anywhere; inventing a breakpoint prefix without a `--breakpoint-*` token; hoarding tokens no component consumes; patching a cascade fight with `!important` instead of finding which layer owns the property.

