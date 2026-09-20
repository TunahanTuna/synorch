---
name: tauri-game-dev
description: Desktop (and mobile) game development with React + Tailwind CSS + Tauri v2 - when this stack wins (UI-heavy games, card/deck-builders, sims, incremental, puzzle), three-layer architecture (React shell, game surface, Rust core), React-to-canvas bridging without re-render storms, Tauri IPC commands/events for saves and native features, per-platform webview performance reality (WebView2 vs WKWebView vs WebKitGTK), packaging, updater and Steam/itch distribution. Use when building a desktop game or app-game with web tech, wrapping a web game as a native app, or working with Tauri. Türkçe tetikleyiciler - "tauri ile oyun", "masaüstü oyunu yap", "react ile oyun", "oyunu desktop'a çıkar", "tauri projesi kur", "steam'e web oyunu", "tauri nedir nasıl kullanılır".
---

# Tauri Game Dev (React + Tailwind + Tauri v2)

You build desktop games on web technology with Tauri v2: a Rust core compiled into a tiny native binary, the OS's own webview as the renderer (no bundled Chromium — installers start around a few MB), your game and UI written in React + Tailwind. One codebase targets Windows, macOS, Linux and (Tauri v2) Android/iOS.

Always communicate with the user in their own language.

## When this stack wins — and when it doesn't

**Great fit**: games that are mostly *interface* — deck-builders, card games, management/tycoon sims, incremental/idle, puzzle, roguelike with menu-heavy meta, visual novels, board games. React's UI power and Tailwind's speed are the superpower; the "game" rendering load is light.

**Careful fit**: 2D canvas/WebGL games (Phaser/PixiJS inside Tauri). Works — shipped Steam games exist — but read the webview reality below and test on every target platform early.

**Wrong fit**: heavy 3D or GPU-hungry WebGL that must run identically everywhere. The webview differs per OS; if you need one consistent Chromium, that is Electron's trade (bigger bundle, consistent renderer), or go native with Godot (see the godot-dev skill).

## The webview reality (the decision most people discover too late)

| Platform | Webview | Notes |
|---|---|---|
| Windows | WebView2 (Chromium) | Best WebGL/canvas performance; your primary game target |
| macOS / iOS | WKWebView (WebKit) | Good, but WebGL is measurably behind Chromium |
| Linux | WebKitGTK | Weakest; known graphics issues — Tauri docs have a dedicated Linux graphics page (compositing/DMA-BUF workarounds, `WEBKIT_DISABLE_COMPOSITING_MODE=1`) |
| Android | System WebView (Chromium) | Solid |

Consequences:
- **Test the weakest target in week one**, not before release.
- WebGL context creation can *succeed* while silently running on a software rasterizer. Detect it: read the renderer string via the `WEBGL_debug_renderer_info` extension and log it at startup; "SwiftShader/llvmpipe" means software rendering — degrade gracefully (lower particle counts, disable shaders).
- DOM/CSS-rendered games (cards, boards, menus) are the most consistent cross-platform choice; 2D canvas next; WebGL last.

## Architecture — three layers

```
┌─ React + Tailwind ──── menus, HUD, settings, meta-game, dialogs
├─ Game surface ──────── canvas (Phaser/PixiJS) or pure DOM/CSS for board/card games
└─ Rust core (Tauri) ─── saves, files, window control, OS integration, heavy compute
```

**React ↔ game engine bridge** (the classic mistake is re-rendering React at 60fps):
- Mount the engine once in a `useEffect` with an empty dep array, attached to a `ref`'d container; destroy on cleanup. The engine lives *outside* React's render cycle.
- Game → UI: engine writes to a small external store (zustand works perfectly); HUD components subscribe to just the slices they show (health, score). Update HUD state on *events* (damage taken), never per frame — or throttle per-frame values to 10Hz for display.
- UI → game: expose engine methods through a thin controller object (start, pause, applySettings); React calls it from handlers.

**Tailwind for game UI**: HUD as absolutely-positioned overlay layers above the game surface (`pointer-events-none` on the layer, `pointer-events-auto` on interactive children); theme the game via design tokens (see design-system skill); `image-rendering: pixelated` utility for pixel art; forbid layout-shifting HUD (reserve space, use tabular-nums for counters).

## Tauri v2 essentials

- **IPC commands** (frontend → Rust): `#[tauri::command]` functions invoked with `invoke("save_game", { slot, data })` from `@tauri-apps/api/core`. Async, JSON-serializable payloads. Keep commands coarse (save whole state, not 100 tiny calls).
- **Events** (Rust → frontend): `listen("achievement-unlocked", ...)` from `@tauri-apps/api/event`; channels for streaming data.
- **Capabilities/permissions** (v2 security model): grant the minimum in `src-tauri/capabilities/*.json` — which windows may use which plugin APIs with which scopes. A game usually needs fs (scoped to app data), store, window.
- **Official plugins you actually want**: `store` (settings/key-value), `fs` + path API (`appDataDir()`) for saves, `window-state` (remember size/position), `updater` (in-app updates, requires signing keys), `single-instance`, `global-shortcut`, `dialog`, `notification`.
- **Assets**: bundle game assets in the frontend build; use `convertFileSrc` for files on disk (user content, mods).
- **Window config**: fullscreen toggle via the window API; decide windowed/borderless-fullscreen day one; lock minimum size to your logical resolution.

## Saves done right

- Location: `appDataDir()` — never next to the executable (read-only installs).
- Atomic writes: write to `save.json.tmp`, then rename; a crash mid-write must not corrupt the only save.
- Versioned schema (`{ v: 2, ... }`) with migrations; slot system + one rolling backup of the previous save.
- Settings in the `store` plugin, saves in files — different lifecycles.

## Rust side — how much Rust do you need?

Little, at first: the scaffold plus a few commands (save/load, maybe hash checking). Grow into Rust for: heavy simulation ticks, procedural generation, file watching, Steamworks integration (community `steamworks` crate — there is no official Steam plugin), local server for mods. Don't move the game loop to Rust prematurely; IPC round-trips per frame are an anti-pattern — the game loop lives in JS, Rust does occasional heavy lifting.

## Distribution

- `tauri build` produces per-platform installers: NSIS/MSI (Windows), DMG/app (macOS), deb/rpm/AppImage (Linux).
- **itch.io**: upload installers or portable builds; works out of the box.
- **Steam**: shipped Tauri games exist. Steamworks via the Rust crate; upload depots per platform; test the Steam overlay against your webview early — it is the classic integration surprise.
- **Updater plugin** for direct distribution (signature keys, update manifest endpoint); on Steam, let Steam handle updates instead.
- macOS notarization and Windows code signing are schedule items, not afterthoughts (budget days, not hours).
- Mobile (v2): same codebase can target Android/iOS — but only ship it if the game is genuinely touch-designed (see pixel-game-dev's mobile notes).

## Pitfalls

Re-rendering React per game tick (bridge pattern above); trusting one dev machine's webview (test matrix early); IPC chatter in the hot loop; saves beside the exe; shipping WebGL-heavy effects untested on WebKitGTK; forgetting `pointer-events` layering so the HUD blocks the game (or vice versa); assuming the updater works without signing set up.

