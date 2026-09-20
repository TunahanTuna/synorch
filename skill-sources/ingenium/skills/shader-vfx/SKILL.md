---
name: shader-vfx
description: Shaders and visual effects for web and games - fragment/vertex shader mental model, GLSL toolkit (SDFs, smoothstep, noise, fbm), ready recipes for game VFX (hit flash, dissolve, outline, water, shockwave, palette swap, CRT), pixel-art-safe effects, post-processing chains, per-environment usage (three.js, PixiJS filters, Phaser pipelines, Godot shading language) and shader debugging/performance. Use when writing or fixing shaders, adding visual effects like glow, dissolve, distortion or outlines, doing post-processing, or when an effect needs GPU work. Türkçe tetikleyiciler - "shader yaz", "efekt ekle", "glow efekti", "dissolve efekti", "outline shader", "su efekti", "ekran efekti", "crt efekti", "godot shader", "glsl".
---

# Shader VFX

You write shaders that serve the game's look and run fast. Shaders are per-pixel programs running massively parallel: think "what color is *this* pixel, given its coordinates, time and textures" — not loops over the image.

Always communicate with the user in their own language.

## Mental model (2 minutes, saves hours)

- **Vertex shader** positions geometry; **fragment shader** colors each pixel. 95% of 2D game VFX is fragment work.
- Coordinates: work in **UV space** (0–1 across the texture/quad). Center-origin trick: `vec2 p = uv - 0.5;` (aspect-correct with `p.x *= aspect;`).
- Everything is a gradient: you compute values (distances, noise, masks) and map them to color with `mix` and `smoothstep`. There is no "if pixel is inside shape" — there is "how far is this pixel from the shape edge".
- Inputs come as **uniforms** (time, resolution, effect strength, textures); per-frame animation = a `time` uniform, not new shaders.

## The core toolkit (memorize these five)

1. `smoothstep(a, b, x)` — THE shaping function: soft thresholds, anti-aliased edges (`smoothstep(0.0, 2.0/resolution.y, d)`).
2. `mix(a, b, t)` — blend anything: colors, positions, whole effects.
3. **SDF shapes**: `length(p) - r` (circle), rect/segment SDFs; combine with `min` (union) / `max` (intersect); distance drives glow, outlines, soft shadows.
4. `fract`/`mod` — repetition: tiles, stripes, scanlines (`fract(uv.y * 100.0)`).
5. **Noise**: cheap hash → value noise → **fbm** (4–5 octaves of noise at doubling frequency, halving amplitude) for anything organic — fire, water, smoke, dissolve. Include a known-good hash/noise snippet rather than inventing one.

## Recipe book (game VFX that ship)

- **Hit flash**: `color = mix(color, vec3(1.0), u_flash)` — drive `u_flash` from gameplay (spike to 1, decay over ~80ms).
- **Dissolve**: `if (noise(uv * scale) < u_threshold) discard;` + emissive edge where `noise - threshold < 0.05`. Animate threshold 0→1 to disintegrate.
- **Outline (sprite)**: sample alpha at 4–8 neighbor offsets; outside pixels with an opaque neighbor get outline color. Pixel-art: 4 offsets of exactly one texel.
- **Water**: scroll two noise layers at different speeds/scales, use them to distort sample UVs of the scene below + tint + specular band via smoothstep.
- **Shockwave**: radial UV displacement — `uv += dir * sin((dist - u_t) * freq) * falloff(dist, u_t)` expanding ring.
- **Heat haze / refraction**: small animated-noise UV offsets on the background sample.
- **Palette swap / LUT grading**: map luminance (or index) through a lookup texture — day/night, damage states, retro palettes for free.
- **CRT/retro post**: scanlines (sine on screen y), slight barrel distortion, chromatic aberration (offset R/B samples), vignette. Subtlety: each at 10–20% of what first looks cool.
- **Glow/bloom**: threshold bright pixels → downscale-blur passes → additive composite. Use the engine's bloom before hand-rolling.

## Pixel-art-safe VFX

- Snap effect UVs to the texel grid (`floor(uv * texSize) / texSize`) or effects smear across the chunky pixels and break the look.
- Render effects at the game's native low resolution, then integer-upscale — post applied after upscale reads as "HD filter on retro game".
- Prefer **dither patterns** over smooth gradients (Bayer-matrix threshold) to stay on-palette; palette-swap via LUT beats hue-shifting.

## Where shaders live per environment

- **three.js**: `ShaderMaterial`/`onBeforeCompile`; post via `EffectComposer`.
- **PixiJS**: `Filter` (fragment + uniforms) per-sprite or per-container.
- **Phaser**: PostFX/PreFX pipelines (built-ins: bloom, glow, blur) or custom `PostFXPipeline` — check built-ins first.
- **Godot**: `.gdshader`, GLSL-like with `shader_type canvas_item;` for 2D; `hint_range` uniforms editable in Inspector; screen-reading via `SCREEN_TEXTURE`/`hint_screen_texture`. Same recipes translate almost 1:1.
- **WebGPU/WGSL**: different syntax, same mental model; compute shaders unlock particles/sim — port there when the target supports it (see tauri-game-dev webview notes for desktop caveats).

## Post-processing chains

Render scene → render target A → effect pass A→B → effect pass B→A (**ping-pong**) → screen. Order matters and is a look decision: grade → bloom → grain reads different from bloom → grade. Keep a debug toggle per pass.

## Performance

- Cost = pixels covered × work per pixel. Fullscreen passes are the budget hogs — count them; half-resolution for blurry effects (blur/bloom/haze) is visually free, 4× cheaper.
- Texture fetches dominate: 8 neighbor samples per pixel is fine; 64 is a blur done wrong (separable blur: two 1D passes beat one 2D pass).
- `mediump` default precision on mobile; branches on *uniforms* are fine, per-pixel divergent branches less so — but measure before contorting code.
- Overdraw from stacked transparent quads (particles) kills mobile — fewer, bigger, smarter particles.
- Profile with SpectorJS (WebGL frame inspector) or the engine's GPU timers; never optimize a shader you haven't measured.

## Debugging (there is no console.log)

- **Output the value as color**: `gl_FragColor = vec4(vec3(suspectValue), 1.0);` — the image *is* the debugger. Expect NaN to render black/weird: check divisions and `normalize(vec2(0))`.
- Isolate: comment passes back to a solid color, re-add until it breaks.
- Prototype on Shadertoy/The Book of Shaders playgrounds (instant iteration), then port — mind their uniform naming (`iTime` → your `u_time`).

