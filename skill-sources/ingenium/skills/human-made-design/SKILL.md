---
name: human-made-design
description: Sand the AI look off of interfaces and produce designs that read as deliberately crafted by a human - a catalog of AI-design tells (violet gradients, glassmorphism cards, emoji icons, centered hero plus three-card grid, Inter-everywhere, "Supercharge your workflow" copy) with concrete fixes, a reference-first design process, typography/color/layout moves that create character, and a de-AI review pass for existing UIs. Use when a design looks AI-generated, generic or template-like, when starting UI that must have real character, or when asked to make a design feel human, distinctive or crafted. Türkçe tetikleyiciler - "yapay zeka işi gibi görünüyor", "tasarımı insanileştir", "çok generic olmuş", "şablon gibi duruyor", "tasarıma karakter kat", "daha özgün tasarım", "ai tasarımı gibi olmasın", "elle yapılmış gibi dursun".
---

# Human-Made Design

You make interfaces that read as *designed by someone with taste and intent*, not sampled from the average of the internet. AI-looking design is not one mistake — it is the accumulation of statistically-safe choices. Humans design from specific references, commit to opinions, and repeat a signature. That is what you do.

Always communicate with the user in their own language.

## The tell catalog (diagnose first)

Count these in the existing or planned UI. Three or more and it reads AI-generated:

**Layout tells** — perfectly centered hero with pill badge ("✨ New"), gradient headline, subhead, two buttons; then a 3-column feature grid of icon-title-paragraph cards; testimonial band; 3-tier pricing; CTA; footer. Every section `max-w-7xl mx-auto py-24`, identical rhythm top to bottom.

**Color tells** — violet/indigo/purple gradients (the 6366F1→8B5CF6 plague); gradient text on headings; glassmorphism (`bg-white/10 backdrop-blur`); dark mode = slate-900 + neon glows; mesh-gradient hero backgrounds; five accent colors doing one job.

**Typography tells** — one generic sans (Inter/system) at default tracking doing every role; the `text-5xl font-bold` + `text-xl text-gray-500` pair; hierarchy expressed by size only; emoji in headings and as feature icons.

**Component tells** — `rounded-2xl shadow-lg` cards on everything; icon in a tinted rounded square; floating blob SVGs; generic 3D illustrations; avatar stacks with "10k+ developers"; badge pills everywhere.

**Copy tells** — Unleash, Supercharge, Empower, Effortlessly, Seamlessly, "Built for the modern web"; benefits with no specifics; round fake numbers; feature names that describe nothing.

**Motion tells** — everything fades up on scroll with identical duration and stagger (see motion-craft: motion needs a job).

## The process fix — references before pixels

Humans don't design from the average; they design from *specific* influences:

1. **Name the direction in words first**: editorial, Swiss/international, brutalist, warm analog, technical-utilitarian, playful toy-like, retro terminal, luxury restraint. If the user has no direction, propose 2–3 with one-line vibes and a concrete reference each.
2. **Pick 2–3 real references** — a magazine layout, a poster era, a specific product's design language, a film's title cards. Extract *why* they work (type contrast? color economy? density?), then translate — never clone.
3. Derive tokens from the direction (type pair, palette, spacing personality, corner/border language) — then build components (hand off to design-system skill for the token mechanics).
4. Only then write layout code. "Generate a landing page" with no direction *is* the AI look.

## Typography — the fastest way to look designed

- Two faces with intent: a **display face with character** (serif, slab, humanist grotesque, mono — something with opinions) for headings, a quiet workhorse for text. The pairing carries more identity than any gradient.
- Size contrast bigger than feels safe: display jumps of 2.5–4×, not 1.5×. Tighten tracking on large display text (`-0.02em to -0.04em`); loosen slightly on small caps/labels.
- Hierarchy through **weight, case, family and color** — not size alone: an eyebrow label in mono caps over a big serif headline out-designs three sizes of bold Inter.
- Real typographic details: proper quotes and dashes, `tabular-nums` for data, hanging the occasional element into the margin, generous line-height on body (1.6–1.7) and tight on display (1.0–1.1).

## Color — from a world, not a wheel

- Derive the palette from something real: a photograph's grading, a print era, the product's material world. Palettes with provenance feel inevitable; generated ones feel arbitrary.
- **One accent**, used sparingly enough to mean something. Neutrals with a temperature — warm paper-grays vs cool steel-grays is a personality decision, not a default.
- Flat, confident color beats gradients. If gradient: same-hue, subtle, one place.
- Backgrounds that aren't white/slate-900: warm off-whites, deep inks with hue, a section in the accent at low saturation. Contrast stays AA (4.5:1) — character never at accessibility's expense.

## Layout — rhythm and tension

- **Vary the section rhythm**: a dense information band after an airy statement; full-bleed after contained; one asymmetric two-column after centered blocks. Uniform `py-24` centered sections are the template heartbeat — break it.
- Set a real grid (12-col or a custom 5/7 split), align hard to it, then break it **once** per view deliberately (an image crossing columns, a headline hanging into whitespace). One break reads intentional; five read broken.
- Structure with **borders, rules and background shifts** more than shadows — hairline rules and numbered sections read editorial/crafted; a page of drop-shadowed rounded cards reads generated. If shadows: one consistent style from one light source.
- Whitespace as a feature: emptiness signals confidence; filling every void with a card signals template.

## Content — the human giveaway

- Real product screenshots over abstract illustrations; real data in mockups (a chart of something true beats lorem bars); specific numbers ("4,218 builds last week") over round marketing counts.
- Copy like a person explaining to a smart friend: concrete verbs, zero adjective inflation, name the actual thing the product does. Read it aloud; delete anything you'd be embarrassed to say.
- Icons: one set, one stroke weight (matched to the type's weight), sized to the type scale. Emoji are never UI.

## A signature

Pick **one** distinctive element and repeat it system-wide: a corner-tick border treatment, numbered section labels (01, 02…), a specific rule-line style, a recurring mono caption format, an unusual but consistent hover state. Repetition of one quirk is identity; many quirks are noise.

## The de-AI pass (for existing UIs)

Run in this order — each step compounds the next: 1) replace the font pairing with a characterful display + workhorse; 2) collapse the palette to neutrals-with-temperature + one accent, kill gradients/glass; 3) break section rhythm and de-card the layout (borders/rules where shadows were); 4) rewrite copy for specificity; 5) swap emoji/blob decorations for one icon set and real content; 6) add the signature element; 7) strip scroll-fade-ups, keep motion that has a job. Re-count the tells; iterate until under three.

Pairs with: the frontend-design skill (aesthetic direction fundamentals) when present, design-system (tokenizing the chosen direction), motion-craft (restraint in motion).

