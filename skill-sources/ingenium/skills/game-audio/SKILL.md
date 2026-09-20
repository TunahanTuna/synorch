---
name: game-audio
description: Game audio engineering for web and beyond - Web Audio API done right (unlock on first gesture, gain bus architecture, lookahead scheduling), SFX variation so sounds never fatigue, adaptive/layered music (horizontal and vertical), 2D spatial panning, ducking and master limiting, mixing levels, asset formats and pipeline, plus Phaser/Godot mappings. Use when adding sound or music to a game, sounds feel repetitive or timing drifts, implementing volume settings, adaptive music or audio-reactive features, or audio does not play on mobile. Türkçe tetikleyiciler - "oyuna ses ekle", "müzik ekle", "ses efekti", "ses çalmıyor", "mobilde ses gelmiyor", "müzik geçişi", "adaptif müzik", "ses ayarları", "ses tekrarlayıcı oldu".
---

# Game Audio

You engineer game audio that is felt more than noticed: responsive SFX with zero perceived latency, music that adapts to play, and a mix that never clips. Audio is half of game feel — a mute playtest and a sound-on playtest are different games.

Always communicate with the user in their own language.

## The Web Audio ground rules

- **One `AudioContext`**, created (or `resume()`d) on the **first user gesture** — autoplay policy means audio before interaction is silently blocked (the #1 "no sound on mobile" cause). Pattern: create on first pointerdown/keydown, show a "🔊 tap to enable" affordance if the game can start silent.
- **Gain bus architecture** from day one — master → music / sfx / ui buses as `GainNode`s:

```
source → sfxGain ─┐
source → musicGain ─┼→ masterGain → (DynamicsCompressor as safety limiter) → destination
source → uiGain ───┘
```

Volume sliders map to bus gains (persist them — store/settings); pause can duck buses independently; the compressor on master is the cheap insurance against clipping stacks of simultaneous sounds.
- Volume perception is logarithmic: map slider 0–1 through a curve (`gain = x * x` is a fine cheap approximation) — linear sliders feel "all in the last 10%".
- Mute on tab hide (`visibilitychange`) as default courtesy; make it a setting for idle games.

## Asset strategy

- **SFX**: short files, fully decoded to `AudioBuffer`s at load (`decodeAudioData`), played as one-shot `AudioBufferSourceNode`s (create per play — they are single-use by design and GC'd after; this is the intended pattern, not a leak).
- **Music**: stream via `<audio>` element + `MediaElementAudioSourceNode` into the music bus (no full decode in memory), or decoded buffers when you need sample-accurate loops/stems.
- Formats: `.ogg` + `.m4a` fallback; SFX mono 44.1kHz (halves size, pans better), music stereo. Loudness-normalize assets offline so code isn't compensating per file.
- Retro/jam pipeline: jsfxr/ChipTone for SFX, BeepBox-style trackers for music; free packs (Kenney audio, itch packs — check licenses).

## SFX that never fatigue (the repetition killers)

The same sample twice in a row reads as fake; three times is annoying. For any frequent sound (footsteps, hits, coins):
- **Pitch variation**: `source.playbackRate.value = 1 + (rand - 0.5) * 0.2` (±10%) — the single cheapest fix.
- **Round-robin**: 3–5 recorded variants, never repeating the last one.
- Slight volume jitter (±2dB equivalent) on top.
- **Polyphony caps + cooldowns** per sound type: 20 coins in one frame = play 3, spread over 50ms, skip the rest. Priority: player-relevant sounds steal voices from ambient ones.
- Micro-timing: never `await` anything before playing a feedback sound — perceived latency over ~50ms decouples action from sound.

## Timing — the lookahead scheduler ("tale of two clocks")

`setTimeout` jitters (±tens of ms — audible instantly in rhythm); `AudioContext.currentTime` is sample-accurate but you can't schedule "everything now". The standard pattern for beat-synced anything:

- A `setTimeout`/`setInterval` ticks every ~25ms and schedules all audio events falling within the next ~100ms window at exact `currentTime`-based timestamps (`source.start(exactTime)`).
- All musical timing math in beats/bars against the context clock; never accumulate `setTimeout` deltas.
- This powers: metronomes, rhythm games, stem-synced layers, beat-quantized stingers.

## Adaptive music

- **Horizontal re-sequencing** (simplest): different tracks per state (explore/combat/boss); crossfade 1–2s via bus gains; quantize the switch to the next bar boundary with the scheduler for musical transitions.
- **Vertical layering** (richer): one song as synced stems (drums/bass/lead/pads), all started at the same `currentTime` and looped identically; intensity = fading stem gains in/out. Requires decoded buffers + identical loop lengths.
- Loop seams: `AudioBufferSourceNode.loop` with `loopStart/loopEnd` is sample-accurate; encoder-added silence at file start is the classic "gap in my loop" bug (trim it, or set loop points inside the padding).
- Stingers (level-up fanfare) duck music briefly and land on the beat when the scheduler is already there.

## Space and mix

- 2D games: `StereoPannerNode` per emitter — pan from x-position (`pan = clamp((x - listenerX) / halfScreen)`), volume from distance with a curve that reaches 0 *before* the entity despawns. Full HRTF `PannerNode` is for when 3D positioning genuinely matters.
- **Ducking**: dialogue/critical SFX sidechain the music bus down 4–6dB with fast attack, ~300ms release — implement as scripted gain envelopes on the music bus.
- Mix discipline: music sits several dB under SFX (players must *feel* actions); leave ~6dB headroom on master; the compressor/limiter catches pile-ups. Mix on laptop speakers AND headphones — bass-only mixes vanish on laptops.

## Engine mappings

- **Phaser**: its WebAudio sound manager covers buses-lite (global/per-sound volume, rate for pitch variation); drop to the raw context (`this.sound.context`) for scheduling/stems.
- **Godot**: Audio buses in the Audio panel (Master/Music/SFX + effects like compressor per bus — the same architecture, built in); `AudioStreamPlayer2D` gives positional pan/attenuation; seamless loops via import loop settings.
- Same principles, different API — bus architecture, variation, scheduling and ducking are universal.

## Checklist before shipping

First-gesture unlock verified on iOS Safari + Android Chrome; volume settings persist and default sensibly (music ~60%, SFX ~80%); no clipping when everything explodes at once; loops seamless for 5 straight minutes; tab-switch and pause behave; a full playthrough with eyes closed — the game should still be legible.

