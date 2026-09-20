---
name: pwa-offline
description: Progressive Web Apps and offline-first engineering - installability (manifest, maskable icons), service worker caching strategies per resource type (precache app shell, stale-while-revalidate APIs, cache-first assets), the service worker update problem solved properly, offline data with IndexedDB and an outbox pattern for writes, offline-capable web games, storage quotas/persistence and honest iOS caveats. Use when making an app or game installable or work offline, adding a service worker, fixing "users see the old version" update bugs, or syncing offline changes. Türkçe tetikleyiciler - "offline çalışsın", "pwa yap", "service worker ekle", "internetsiz çalışsın", "uygulama yüklenebilir olsun", "kullanıcılar eski sürümü görüyor", "cache stratejisi", "offline kayıt".
---

# PWA & Offline-First

You make web apps installable and genuinely useful without a network — with a service worker you can *update reliably*. The update problem is where PWAs actually fail in production, so you design for it from the first line.

Always communicate with the user in their own language.

## Phase 0 — Is a PWA the right call?

Strong yes: games (playable offline, installed on the home screen/desktop), tools used repeatedly (dashboards, editors, field apps), anything with flaky-network users. Weak case: content sites — good caching headers deliver most of the win without service worker complexity. State the verdict; a service worker is a liability you must maintain, not free progress. (Native shell instead? For desktop games see tauri-game-dev.)

## Phase 1 — Installability

- `manifest.json`: `name`, `short_name`, `start_url` (with a `?source=pwa` param so analytics see installs), `display: standalone` (games often want `fullscreen`), `background_color`/`theme_color`, `orientation` for games (`landscape` when the game demands it).
- Icons: 192 + 512 PNG **plus maskable versions** (`purpose: maskable`, safe zone = inner 80% — test in a maskable preview; non-maskable icons get ugly white circles on Android).
- Detect standalone mode (`display-mode: standalone` media query) to hide "install" prompts in-app and adjust chrome.
- Polish that makes installed feel native: `overscroll-behavior: none` (no pull-to-refresh mid-game), `user-select: none` on game surfaces, `viewport-fit=cover` + safe-area insets for notches.

## Phase 2 — Service worker: strategy per resource type

Use **Workbox via vite-plugin-pwa** (or the framework's PWA integration) rather than hand-rolling — lifecycle bugs are subtle and Workbox has eaten them for a decade. Configure per type:

| Resource | Strategy |
|---|---|
| App shell (HTML/JS/CSS build output) | **Precache** with revisioned URLs (the plugin does this) — atomic, versioned, offline-guaranteed |
| API GET data | **Network-first** (fresh when online, cache fallback offline) or **stale-while-revalidate** for lists that may lag |
| Images/fonts | **Cache-first** with expiration (maxEntries LRU + maxAgeSeconds) |
| POST/PUT/DELETE | **Never cached** — queue them (outbox, Phase 4) |
| Cross-origin/analytics | Network-only; don't let the SW swallow failures silently |

- Version caches by name and **delete stale caches on `activate`** — the plugin handles it; verify it happens.
- Navigation fallback to the shell for SPA routes; keep an `/offline.html` for genuinely uncached navigations.

## Phase 3 — The update problem (where PWAs break trust)

Lifecycle truth: a new SW installs but **waits** until every tab of the old one closes — users can run week-old code indefinitely.

- The pattern that works: detect the waiting worker → show a small "Yeni sürüm hazır — Yenile" toast → on click, `messageSkipWaiting()` + reload on `controllerchange`. (vite-plugin-pwa exposes exactly these hooks.)
- Auto-`skipWaiting` without a reload is the classic footgun: new SW + old page = mixed versions, broken chunk loads (old hashed chunks purged from precache).
- For games: apply updates at the menu, **never mid-session**; version save-schema independently of app version.
- Always test the update path before shipping *any* SW: deploy A, load it, deploy B, confirm the toast → reload → B. An unupdatable PWA is a support nightmare with no fix but "clear site data".
- Escape hatch in production: a tiny `version.json` fetched network-only, compared at boot — your kill switch if the SW pipeline breaks.

## Phase 4 — Offline data

- **IndexedDB** for structured data (use the `idb` wrapper; raw IDB API is hostile). localStorage only for tiny sync flags/settings — it is synchronous and blocks.
- **Outbox pattern** for writes: user action → write locally + append to an outbox queue → UI updates optimistically → a flusher sends queued ops when online (Background Sync API where available, `online` event + boot-time flush as the universal fallback).
- Idempotency: every queued op carries a client-generated ID so retries never double-apply server-side.
- Conflicts: default to last-write-wins with a server timestamp and *say so*; per-field merge only where the domain demands it (document editing → that's CRDT territory, scope consciously).
- Sync status is UI: pending/synced/failed indicators — invisible sync means users distrust offline (three-states rule from frontend-craft).

## Phase 5 — Games offline

- Precache the entire asset set (atlases, audio, levels) versioned by the build — a game that half-loads offline is worse than one that says it can't.
- Saves are **local-first always** (IDB), cloud sync as an outbox layer on top; never block play on the network.
- Big downloads (music packs): cache on demand with a visible "available offline" toggle + progress, not silent hoarding.
- Check `navigator.storage.estimate()` and request `navigator.storage.persist()` — otherwise the browser may evict your game's data under pressure.

## iOS honesty (say it up front)

Installs via Share → Add to Home Screen (no install prompt); no Background Sync (flush-on-open fallback carries it); storage evictable after long disuse (~7-day heuristics for some storage — persist() and warn); push exists on modern iOS but with quirks. iOS PWAs are good, not equal — set expectations.

## Testing checklist

DevTools → offline: full app walk. Update path A→B (above). Lighthouse PWA pass. Real Android install + real iOS Add-to-Home-Screen. Airplane-mode cold start of the *installed* app. Storage pressure: what breaks first, and does the app say so?

