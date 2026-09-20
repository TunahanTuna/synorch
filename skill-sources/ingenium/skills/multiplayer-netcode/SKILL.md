---
name: multiplayer-netcode
description: Multiplayer and netcode for web games - choosing the right model per genre (lockstep, snapshot interpolation, client prediction with server reconciliation, rollback), transport selection (WebSocket vs WebRTC DataChannel vs WebTransport), authoritative server design, state sync and delta compression, lag compensation, determinism traps in JavaScript, anti-cheat basics and latency simulation testing. Use when adding multiplayer or online play to a game, syncing game state over the network, fixing lag/desync/rubber-banding, or designing rooms and matchmaking. Türkçe tetikleyiciler - "multiplayer ekle", "çok oyunculu yap", "online oyun", "netcode", "lag var", "oyuncular birbirini görsün", "state senkronizasyonu", "desync oluyor", "rollback".
---

# Multiplayer Netcode (Web Games)

You design netcode that fits the game, not the fanciest technique. First, the honest warning you always give: **multiplayer multiplies scope 3–5×** — servers, sync, edge cases, cheaters, testing. The MVP is two players in one room with the simplest sync model that fits the genre; everything else comes after that works.

Always communicate with the user in their own language.

## Phase 1 — Pick the model by genre (the decision that decides everything)

| Genre / need | Model |
|---|---|
| Turn-based (cards, board, strategy) | Plain request/response + authoritative state broadcast. No prediction needed. Start here whenever possible. |
| Co-op casual, slow-paced (party games, .io-lite) | Server tick + **snapshot interpolation** (clients render ~100ms in the past, interpolating between snapshots) |
| Action with player movement (shooters, arena) | Snapshot interpolation + **client prediction & server reconciliation** for your own player |
| Precise competitive 1v1 (fighting, sports) | **Rollback** (GGPO-style) — requires a deterministic simulation |
| Massive persistent worlds | Not an MVP. Interest management + sharding — scope this consciously later |

State the choice and its consequences before writing any code.

## Phase 2 — Transport

- **WebSocket**: ordered, reliable (TCP). Perfect for turn-based and fine for most casual real-time. Weakness: head-of-line blocking — one lost packet stalls everything behind it.
- **WebRTC DataChannel** (unreliable/unordered mode): UDP-like, what fast action games want; heavier setup (signaling, STUN/TURN — budget a TURN server, ~10–20% of connections need relay).
- **WebTransport**: the modern UDP-like option over HTTP/3; check current browser/server support before committing.
- Rule: **start with WebSocket**; move the *hot path only* (position updates) to unreliable transport when measurements demand it. Reliable events (chat, score, item pickup) stay on the reliable channel regardless.

## Phase 3 — Authoritative server (non-negotiable for anything competitive)

- The server owns truth: clients send **inputs/intents** ("move left", "play card 3"), never outcomes ("my HP is 100", "I won").
- Validate every input server-side: legal move? plausible rate? in range? Client-side checks are UX, not security.
- Hidden information (other players' hands, fog of war) never leaves the server — filter per recipient. Anything sent to a client is public to a cheater.
- Fixed **tick rate** (10–30Hz casual, 60Hz competitive): simulate on tick, broadcast snapshots on tick or every Nth tick.
- Room architecture first: rooms/lobbies with a max player count are how everything scales later. Frameworks: roll your own on `ws` (educational, fine for turn-based), **Colyseus** (rooms + state sync out of the box), or managed (Nakama, Hathora, PlayFab) when ops time is worth more than money.

## Phase 4 — State sync mechanics

- **Snapshots + interpolation**: server sends world state at tick rate; clients buffer ~2–3 snapshots and render other entities ~100ms in the past, interpolating. Smoothness beats freshness for everything that isn't you.
- **Delta compression** when snapshots get fat: send changes vs last-acked snapshot; full snapshot on join/desync. Quantize floats (positions to cm, angles to bytes) before compressing.
- **Client prediction (your own player)**: apply your input locally immediately; tag inputs with sequence numbers; server echoes last processed seq + authoritative state; on mismatch, rewind to server state and **replay unacked inputs** (reconciliation). Rubber-banding = reconciliation missing or broken.
- **Lag compensation (hit detection)**: server rewinds targets to where the shooter *saw* them (timestamped shots) before resolving hits — otherwise high-ping players can't hit anything.
- Interest management once rooms grow: send each client only what it can perceive.

## Phase 5 — Rollback (only for the genres that need it)

- Requires a **deterministic** simulation: same inputs → identical state on every client.
- Loop: predict remote inputs (usually "same as last frame") → when real input arrives late, rewind to that frame, re-simulate to present. Needs: fixed timestep, fully serializable game state, sim decoupled from rendering, state save/load fast enough to re-run several frames in one frame budget.
- **JS determinism traps**: `Math.random` → seeded PRNG (e.g. mulberry32) owned by the sim; `Date.now`/`performance.now` → tick counters only; unordered object/Map iteration feeding gameplay decisions → sort first; floating point is generally consistent same-engine but avoid `Math.sin/cos` accumulation drift — prefer integer/fixed-point for the critical sim state where feasible.
- Desync detection: hash the game state every N ticks, compare between peers; on mismatch log the first diverging tick — that's your bug's address.

## Phase 6 — Test like the network is hostile

- Simulated latency/jitter/loss from day one (Chrome DevTools throttling; `tc netem` on Linux; toxiproxy) — netcode that only met localhost is untested. Test at 80ms, 150ms, 250ms with 1–3% loss.
- Bots that send random-but-legal inputs at full rate: your load test and your fuzzer.
- The two-browser-windows setup is the daily driver; add one real remote friend before believing anything ships.

## Anti-patterns

Trusting the client with outcomes; TCP-only for fast action then blaming "lag"; per-frame unthrottled sends (send on tick); no seq numbers ("it works on LAN"); building matchmaking before two friends can share a room code; retrofitting determinism for rollback after the sim is built (it's a rewrite — decide up front).

