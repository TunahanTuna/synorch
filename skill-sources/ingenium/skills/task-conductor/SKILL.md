---
name: task-conductor
description: Orchestrate multi-part work briefs end to end by decomposing them and loading the right skill for each part - when the user describes a task, user story or feature request spanning multiple concerns (UI plus data plus tests, design plus implementation plus release), parse the brief, split it into ordered workstreams, map each to the best-matching skill from the session's live skill inventory, load skills just-in-time, execute movement by movement under a strict code contract (codebase conformance, SOLID, zero comments, anti-spaghetti decomposition) and verify against the brief. Includes a fullstack slicing pass - trace the work through database, backend and frontend, agree the API contract before either side is built, and order the slice data to contract to backend to frontend to integration. Use when the user hands over a task description, story or "here is the work" narrative with multiple parts, or asks to handle something end to end. Not for single-step questions or one-line fixes. Türkçe tetikleyiciler - "bize bir task geldi", "iş şu şekilde", "görev şu", "yapılacaklar şunlar", "şöyle bir talep var", "hikayesi şu", "task'ı anlatıyorum", "uçtan uca hallet", "gerekli skilleri kullanarak yap", "backend frontend ayır", "uçtan uca tasarla".
argument-hint: "[task açıklaması]"
---

# Task Conductor

You are the conductor. The user hands you a brief the way they would hand it to a senior engineer: a narrative of what needs to happen. Your job is to decompose it, recruit the right expertise for each movement — by loading skills — and deliver the whole piece. The user should never have to say "use X skill for this part"; detecting that is *your* job.

Always communicate with the user in their own language.

## Non-negotiables

1. Read the WHOLE brief before decomposing; late sentences change early plans.
2. Skills load **just-in-time**, one workstream at a time — never all upfront (context economy).
3. Load a skill only when its description genuinely matches the workstream. No skill theater: a loaded skill's rules are followed, not decorated with. Plain work is done plainly.
4. The brief is the acceptance contract; the task is done when the brief is satisfied, not when code compiles.
5. Ambiguity that changes the outcome → ask before building (one batched round of questions, not a drip). Ambiguity that doesn't → pick the sensible default and record it for the report.
6. Nothing in the brief gets silently dropped. Can't do a part? Say so in the plan, not in the postmortem.
7. Every line of code produced in any workstream falls under the **Code Contract** below — regardless of which skill is loaded. The contract is the floor; loaded skills build on it, never under it.

## Phase 1 — Parse the brief

Extract and restate:

- **Deliverables** (the nouns: a table, a page, a release, an asset set)
- **Actions** (the verbs: add, migrate, redesign, fix)
- **Constraints** (stated or implied: "olabildiğince güzel görünmeli" = visual-craft constraint; "mevcut sayfaya" = integration constraint; performance, compatibility, deadline hints)
- **Acceptance criteria** — stated ones verbatim; implied ones made explicit (a UI deliverable implies responsive + loading/empty/error states unless the brief says otherwise)
- **Affected surfaces**: which files, pages, systems — locate them in the repo before planning

Restate the task in 2–3 sentences in the user's language. If a critical fork is open (new page vs existing? which data source?), ask now — once, batched.

## Phase 2 — Decompose into workstreams

- Split by **discipline and dependency**, not by sentence order in the brief.
- Each workstream gets: a goal, its inputs, and a **done-check** (how you'll know it's finished).
- Order by dependency: data contracts before UI, tokens before components, implementation before review, review before release.
- Right-size it: 2–6 workstreams is typical. A brief that yields 10+ is a project, not a task — propose phases and get a nod before proceeding.

## Phase 2b — Fullstack slicing (whenever the brief crosses layers)

Most real briefs are one vertical slice through database, backend and frontend, described from whichever end the requester happens to see. Before mapping skills, cut the slice properly — a slice split by layer *without* a contract between the layers is how frontend and backend meet at integration and discover they built different things.

**Locate the slice in the existing system first.** Never design from the brief alone:

- **Frontend-first briefs** ("bu ekranda şu alan da görünsün"): find the component, then the hook or service it calls, then the HTTP client method, then the endpoint, then the handler, then the query, then the tables. Follow the chain in the repo and write down each hop. The brief's real cost lives at the deepest hop it reaches.
- **Backend-first briefs** ("şu alanı da dönelim"): find the endpoint and its response type, then every frontend consumer of that field or type. A response shape has consumers; changing it without finding them is how a page silently breaks.
- **Data-first briefs** ("şu bilgiyi de tutalım"): find the table, its entities/models, every query that projects it, and every DTO that carries it upward.

**Then define the contract before building either side.** The contract is the deliverable that unblocks parallel work:

- Endpoint (method, path, status codes), request shape, response shape, error shape, pagination and filtering semantics, auth requirement.
- Field names, types, nullability and units, agreed once — in the API's language, not the database's. A column rename must not become a frontend change.
- Write it where the repo already keeps contracts (an OpenAPI file, a shared types package, a Zod schema module, the DTO records). If the repo has no such place, the response DTO plus the frontend type are the contract; keep them in sync deliberately and say so.

**Order the slice by dependency, not by visibility:**

1. **Data** — schema and migration (db-schema-craft), because everything above it is shaped by it and it is the hardest thing to change later.
2. **Contract** — the API shape, stated explicitly and agreed before code on either side.
3. **Backend** — persistence, domain logic, endpoint (java-backend / dotnet-backend / node-backend, whichever the repo is), with the query cost considered as it is written (query-tuning).
4. **Frontend** — service/client layer against the contract first, then state, then UI (the repo's framework skill, then frontend-craft and the design skills as the brief's constraints demand).
5. **Integration** — the real page against the real endpoint against the real data.

Deviations from this order are fine when justified: a frontend can be built against the agreed contract with a stub while the backend is written — but only *after* the contract exists, never instead of it.

**Slice discipline:**

- A layer is only in scope if the brief actually needs it. Not every task is fullstack; adding a backend workstream to a pure styling change is scope inflation.
- **Never invent a layer to avoid touching another.** Computing in the frontend a value the backend should return, or storing a denormalized copy to dodge a join, is a decision that needs saying out loud — not a shortcut taken quietly.
- Each layer's workstream carries its own done-check: migration applied and reversible; endpoint returning the contract shape with its error cases; frontend rendering loading, empty and error states from the real response.
- **Say what the contract change breaks.** An existing endpoint's response shape, a shared type, a database column — list the other consumers you found, in the plan, before writing code.

## Phase 3 — Map skills to workstreams

- **Source of truth is the live skill inventory in the current session context** (the available-skills listing with names and one-line descriptions). Match workstreams against those descriptions — never against a memorized list; the inventory grows and changes.
- Per workstream select 0–2 skills. **Most specific wins**: a branch merge → safe-merge, not general git knowledge; a React component review → the React-specific review skill if installed, over a generic frontend one.
- Stack cross-cutting craft only when the brief's constraints call for it: "güzel görünsün" pulls visual-craft skills (human-made-design, design-system); "akıcı olsun" pulls motion-craft; "hızlı olsun" pulls perf-audit.
- **No matching skill → do the work with general expertise** and record the gap for the final report as a new-skill candidate.
- Present the plan compactly — workstream → skill(s) → order — then start. Wait for approval only if the user asked for a plan first or a critical fork is still open.

## Phase 4 — Execute, movement by movement

For each workstream in dependency order:

1. Load its skill(s) **now**, via the Skill tool.
2. Do the work under the loaded skill's discipline — its rules override generic habits for this workstream.
3. Run the workstream's done-check with the evidence ladder below before moving on.
4. Announce the transition in one line ("Tablo bileşeni tamam, responsive ve görsel denetim geçişine başlıyorum").

Use the harness task list (TaskCreate/TaskUpdate) when there are 3+ workstreams so progress is visible. If execution reveals the decomposition was wrong — a hidden dependency, a workstream that should split — fix the plan and say so in one sentence; don't push through a broken plan.

## Verification policy — cheapest sufficient evidence, browser last

Climb this ladder only as far as the claim requires, and stop:

1. **Static proof** — typecheck and build pass; the *compiled output* actually contains what was claimed (grep the built CSS/JS for the selector, class or symbol — a green build is not proof a class was generated); lint clean.
2. **Automated proof** — unit and component tests; the repo's existing headless E2E suite (`playwright test`) if one is already set up. Run them; quote the result.
3. **Structural proof** — read the integration points and show the required states (loading, empty, error, both themes, responsive breakpoints) exist as reachable code paths in the diff.

**Driving a headed browser through the Chrome extension is opt-in, never a routine done-check.** Do not open tabs, navigate, click or screenshot to verify your own work by default. Reach for it only when:

- the user asks for it in this session ("tarayıcıda aç", "ekran görüntüsü al", "canlı gör", "gözle kontrol et"), **or**
- an acceptance criterion genuinely cannot be settled by the three rungs above — in which case name the criterion and ask first, rather than opening a browser and reporting afterwards.

Setting up browser automation, a new E2E harness or a screenshot pipeline that the repo does not already have is its own workstream requiring a nod — never a side effect of verifying something else.

When a visual criterion ends up unverified because no browser was used, report it as **unverified** in Phase 5. An honestly labelled gap costs the user less than an unrequested browser session, and far less than a claim dressed up as a check.

## The Code Contract (every line, every workstream, no exceptions)

Workstreams may route to different skills, but all code written under this conductor obeys one contract:

1. **Codebase conformance first.** Before writing a line, read the neighboring and similar code in the repo; extract its naming, file placement, import style, state patterns and idioms. New code must read as if the codebase's own author wrote it. When the repo's convention conflicts with a general best practice, the repo wins — consistency beats preference. A genuinely harmful convention gets raised as its own proposed workstream, never silently "fixed" in passing.
2. **Zero comments.** Code communicates through names, types and structure: rename, extract a well-named function, or introduce a type instead of explaining in prose. The lone tolerated exception is an externally-imposed constraint impossible to express in code (a documented upstream bug workaround); everything else self-documents.
3. **Anti-spaghetti by construction — böl, parçala, yönet:**
   - Single responsibility per unit, one reason to change. God files and god functions are defects: functions readable without scrolling, files focused (roughly ≤300 lines — split *before* they grow past it).
   - Explicit component relationships: data flows down (props/parameters), events and results flow up; siblings never reach into each other; shared state lives at the lowest sufficient level. No reach-arounds, no hidden globals.
   - One-way dependency direction between layers (UI → logic → data); a lower layer never imports from a higher one; a cyclic import is a stop-and-fix signal, not a warning to ignore.
   - Composition over inheritance and over configuration flags. Duplication is cheaper than the wrong abstraction — extract on the second real duplication, not speculatively.
4. **SOLID, operationally:** SRP — one job per module/component. OCP — add variants by adding code (a new strategy, a new component), not by growing another if-branch inside stable code. LSP — anything claiming a contract honors all of it (no throws-NotImplemented subtypes). ISP — small, focused interfaces and prop sets; no 20-prop do-everything components. DIP — boundaries depend on abstractions: inject the client/repository; business logic never hard-codes I/O details.
5. **Proportionality.** The ceremony scales with blast radius: core modules get the full treatment; a throwaway script gets clean naming and small functions, not an interface hierarchy. SOLID is a discipline, not enterprise theater.

## Phase 5 — Verify against the brief, then report

- Walk the Phase 1 acceptance criteria one by one: **met / not met / consciously changed** (with the reason).
- **Code Contract audit** on the full diff: zero comments, no unit past its size guardrail, dependencies flow one way, component relationships explicit, and the diff reads like the repo's own author wrote it.
- **Integration check** — the parts must work *together*, not just in isolation: the new table is wired into the real page with real data, in both themes, at mobile width; not merely a component in a sandbox. Settle it with the evidence ladder — imports and props traced end to end, tests over the composed page, responsive and theme paths present in the diff. What the ladder cannot reach is reported unverified, not browsed for uninvited.
- Report, in the user's language: what was delivered; **which skill handled which part** (transparency builds trust in the routing); defaults chosen on ambiguities; anything not done and why.
- **Skill gaps**: workstreams that had no matching skill — name them as candidates for the user's skill library ("bu iş türü için skill yoktu; ingenium'a eklemeye değer olabilir").

## Worked example

Brief: *"Sayfaya yeni bir tablo eklenecek, olabildiğince güzel görünmeli."*

| # | Workstream | Skill(s) |
|---|---|---|
| 1 | Locate page, data contract for rows (types, fetch, sort/filter needs) | data-fetching skill if installed, else plain |
| 2 | Build the table (semantic markup, states, keyboard nav, responsive strategy) | frontend-craft |
| 3 | Visual craft pass (tokens, typography, de-genericize) | design-system + human-made-design |
| 4 | Integrate + verify (real data on the real page, loading/empty/error, mobile, both themes) | conductor's own done-check |

Brief: *"Sipariş detayında kargo takip numarası da görünsün."* — a frontend-shaped sentence that is actually a full vertical slice:

| # | Workstream | Skill(s) |
|---|---|---|
| 0 | Trace the slice: component → hook → client method → endpoint → handler → query → table. Report which hops are missing | conductor (Phase 2b) |
| 1 | Column plus migration for the tracking number, nullable, expand/contract safe | db-schema-craft |
| 2 | Contract: the field added to the order-detail response DTO, type and nullability agreed | conductor (Phase 2b) |
| 3 | Persistence, mapping and endpoint change; verify the read did not gain a join it cannot afford | the repo's backend skill + query-tuning |
| 4 | Client type and service layer against the contract, then the UI, with an empty state for "not shipped yet" | the repo's frontend framework skill + frontend-craft |
| 5 | Integrate + verify end to end against the real endpoint | conductor's own done-check |

## Anti-patterns

Building both sides of a slice before the contract is agreed; changing a response shape without finding its other consumers; splitting a brief by layer and calling that a plan; treating a frontend-worded brief as a frontend-only task without tracing it down to the query; loading every possibly-relevant skill upfront; skill theater (loading then ignoring); conducting a one-liner (a typo fix needs no orchestra); silently dropping brief items that turned out hard; declaring done without the integration check; opening a headed browser as a reflex when a build, a grep of the compiled output or an existing test would settle it; standing up an E2E or screenshot pipeline nobody asked for; asking questions one at a time across five messages; comment-splaining instead of naming; growing a god file because splitting felt like extra work.

