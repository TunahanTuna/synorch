---
name: pixel-art-assets
description: Create pixel art game assets that read as human-crafted, not AI-generated - style bible first (locked palette with hue-shifted ramps, one outline rule, one light source, one pixel density), craft fundamentals (silhouettes, clusters, hand anti-aliasing, dithering discipline), three production routes (hand-drawn in Aseprite, palette-constrained scripted generation, diffusion output rescued via downscale-quantize-handfix with the bundled px.py tool), recipes per asset type (characters, animation frames, tilesets, UI, VFX) and engine-ready export. Use when creating, generating, cleaning or reviewing pixel art sprites, tiles, animations, icons or any game asset, or building a consistent asset set. Türkçe tetikleyiciler - "pixel art asset üret", "sprite çiz", "tileset yap", "karakter sprite'ı oluştur", "ai ile asset üret", "asset'i temizle", "insan çizmiş gibi dursun", "assetler tutarlı olsun", "animasyon frame'leri".
---

# Pixel Art Assets

You produce pixel art that reads as deliberately crafted by a human. The human-made look is not a filter — it is **constraints applied consistently**: one pixel grid, one locked palette, one outline rule, one light source, across every asset in the set. AI output becomes raw material that gets disciplined into the system, never the final word.

Always communicate with the user in their own language.

## Why AI pixel art looks AI (the tell catalog)

Diagnose these before fixing anything — three or more and the asset reads generated:

- **Fake pixel grid**: "pixels" of varying sizes and alignments (diffusion models paint pixel-*style*, not pixels).
- **Color flood**: hundreds of colors where an artist uses 16; muddy gradients inside what should be flat clusters.
- **Straight-darker shadows**: shading that only darkens the same hue — no hue shift (the single loudest tell).
- **No committed light source**; over-rendered noise and melty, almost-symmetric detail.
- **Soft alpha edges** and glow halos around sprites (sticker look).
- **Style drift**: each asset in the set slightly different in outline, saturation, density or proportion.

## Phase 0 — The style bible (before ANY asset exists)

Write `assets/STYLE.md` in the game repo and re-read it at the start of every asset session. Template:

```markdown
# <Game> Pixel Art Style Bible
- Grid: tiles 16x16, characters 32x32 (body ~24px tall), items/icons 16x16, UI at 1x
- Palette: <name/link or hex list - 16-32 colors TOTAL, locked>
- Ramps: 3-5 shades per material; shadows shift cool (toward blue/violet),
  highlights shift warm (toward yellow); saturation peaks in midtones
- Outline: <pick ONE - full black / selout (colored per neighbor) / lineless>
- Light: top-left, always
- Proportions: <e.g. 1:1 head-to-body chibi at 32px; 3/4 top-down view>
- Alpha: binary (0 or 255) - no soft edges, no glows
- Dithering: <e.g. sparse checkerboard for large gradients only / none>
- AA: interior-only, hand-placed, max 1px against outline
```

Palette guidance: start from a proven palette (Lospec is the library of record — e.g. a 16–32 color general palette) or build ramps by hand. Fewer colors is a *feature*: constraints create the crafted look.

## Craft fundamentals (what your hands enforce)

- **Silhouette first**: fill the sprite solid black; if it isn't readable at 1x in-game size, no amount of detail will save it. Design silhouette → big shapes → detail, in that order.
- **Clusters, not confetti**: group pixels into meaningful shapes of one ramp step; scattered single-pixel noise reads as texture spam. Every pixel is a decision.
- **Pixel-perfect lines**: no doubled pixels on diagonals, consistent staircase rhythm on curves (1-2-3 step progressions, not 1-3-1).
- **Hue-shifted ramps**: in HSV terms per step darker — value down, hue rotated 8–20° toward cool; per step lighter — value up, hue toward warm; saturation highest in the middle of the ramp. This is 80% of "looks hand-painted".
- **Hand anti-aliasing**: a few midtone pixels softening hard interior curves — never automatic AA, never against transparent edges.
- **Dithering with intent**: checkerboard/Bayer for large gradient fields (sky, vignette) and retro flavor; modern clean styles use almost none. Random dithering never.
- **Anti-patterns**: pillow shading (concentric rings of light regardless of light source), banding (parallel ramp lines hugging an outline), outline-color inconsistency, mixed pixel densities in one scene (a 1x sprite on a 2x background breaks the world).
- **Readability hierarchy**: gameplay-critical elements get the strongest value contrast and the most saturated colors; backgrounds recede (lower contrast, cooler, desaturated). Reserve one accent color for interactables.

## Three production routes (choose per asset)

| Asset | Route |
|---|---|
| Player, key characters, hero animations | **A — hand-drawn** (highest craft, it's the face of the game) |
| Tiles, props, items, icons, UI, particles | **B — scripted generation** (perfect grid + palette by construction) |
| Concept art, mood refs, large backgrounds | **C — diffusion + rescue** (raw material, never final) |

**Route A — Aseprite.** Master files are `.aseprite` in `assets/src/`. Work in Indexed mode with the style-bible palette loaded (colors outside the palette become *impossible*). 1px pencil, shading ink for ramp work, onion skin for animation, tags per animation, export via CLI for repeatability.

**Route B — scripted (true pixel art from code).** For grid-friendly assets, write a small script (Python/Pillow or JS canvas) that draws on the exact grid with the style-bible palette as named constants — output is pixel-perfect by construction, and variants are a loop (6 grass tiles with shuffled detail placement). Iterate: generate → upscale preview (8x) → adjust script → regenerate. This beats diffusion for consistency on simple assets and is fully reproducible.

**Route C — diffusion rescue pipeline.** When using an image model for complex raw material:
1. Generate large, one subject, plain background, strong silhouette; ask for flat shading.
2. Downscale to the true grid and lock to palette with the bundled tool: `python "${CLAUDE_SKILL_DIR}/scripts/px.py" quantize raw.png --grid 32x32 --method box --palette assets/palette.hex` (BOX averaging then palette-snap survives fake-grid noise better than nearest).
3. **The mandatory hand pass** — this is where "human-made" happens: fix the silhouette, re-shade with the committed light source and hue-shifted ramps, apply the outline rule, merge noise into clusters, binarize alpha, re-do face/hands (AI melts them at small sizes).
4. Audit next to existing assets (contact sheet below). If the hand pass exceeds drawing from scratch — common for small sprites — draw from scratch; diffusion earns its keep on concepts and big backgrounds, rarely on a 16px item.

## Recipes per asset type

- **Characters**: fix the canvas box and ground line; ≤10 colors per character; design limbs as separable clusters (animation needs them); consistent view angle (side or 3/4 top-down) across the whole cast; darkest outline value reserved for silhouette edge.
- **Animation**: key poses first, inbetweens after. Frame budgets that read well: idle 4–6, walk/run 6–8, attack 3–5 plus anticipation and follow-through, hit/death 4–6. Squash & stretch in pixel terms (compress the cluster, don't scale the sprite). Sub-pixel illusion: shift interior clusters and AA one frame before the outline moves. Keep pivot/feet on the ground line in every frame; tag animations in Aseprite and export sheet + JSON.
- **Tilesets**: prove seamlessness by tiling 3×3 and offsetting by half a tile; make 2–4 variants of any large-area tile (grass, floor) to kill visible repetition; terrain edges via the engine's autotile template (Godot terrains, Tiled — the 47-tile blob covers all cases); tiles stay lower-contrast than sprites; atlas with 1–2px extrusion (see pixel-game-dev on bleeding).
- **UI**: 9-slice panels (corners fixed, edges repeat); a real pixel font at integer sizes only; icons on one shared grid with one shared outline rule; UI pixel density matches the game (no 1x game with 4x-smooth UI).
- **VFX**: few frames (4–8), big readable shapes, ramps that end bright (white/near-white last frame) for additive blending; smear frames beat motion blur.

## QA ritual (every asset, every set)

1. View at **1x in-game size** (the only truth) and at 4–8x (the editing view). Judge at 1x.
2. Palette audit: `px.py palette sprite.png` — any color outside the style bible is a bug.
3. Light/outline/density check against STYLE.md.
4. Set consistency: `px.py sheet assets/sprites --scale 4` → one contact sheet; drift is obvious side by side.
5. In-engine screenshot at real resolution — rendering settings can undo everything (see pixel-game-dev's pixel-perfect rules).

Bundled tool: [scripts/px.py](scripts/px.py) (`pip install pillow`) — commands: `quantize` (downscale + palette lock + binary alpha), `upscale` (integer preview), `palette` (color audit), `sheet` (contact sheet). Ship 1x PNGs; previews are for review only.

Pairs with: **game-design** (the MVP asset list — don't craft 200 assets before the rectangle test passes), **pixel-game-dev** (rendering, atlases, integration), **human-made-design** (menus/marketing pages around the game).

