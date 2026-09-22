# ADR-04: Terminal renderer

## Status

Accepted

## Date

2026-09-22

## Context

Ürün sahibi kararı: terminal arayüzü Windows (Windows Terminal/PowerShell/cmd), macOS, Linux ve SSH'de çalışmalı; Oh My Pi yaklaşımı referans alınmalı. OMP'nin TUI'si Bun'a özgü fork'tur; Node 24 karşılığı `@earendil-works/pi-tui`'dir ([TUI araştırması](../research/tui/README.md)). Non-TTY/CI ve ekran okuyucu için ayrı yol gerekir ([çapraz platform listesi](../research/tui/cross-platform-checklist.md)).

## Decision

- İnteraktif TTY modu: `@earendil-works/pi-tui` tam sürüm sabit `0.87.0` (`^` yok). Yalnızca `src/harness/tui/pi-tui-renderer.ts` bu paketi import eder; `TerminalRenderer` arayüzünün arkasındadır.
- `PlainLineRenderer` (yalnız append, imleç hareketi yok) ve `JsonlRenderer` bağımlılıksızdır.
- Seçim kuralı (`selectRendererKind`): `--mode jsonl`/`--json` → `jsonl`; `--plain` | `SYN_PLAIN` | `TERM=dumb` | stdin veya stdout TTY değil → `plain`; aksi halde `tui`. Renk: `--color` > config > `NO_COLOR` > `FORCE_COLOR` > stream kabiliyeti (`selectColor`).
- `Ctrl+C` önce etkin isteği iptal eder, ikinci basış güvenli çıkış önerir; `Esc` de iptal eder.
- Renderer aboneliği agent'ı bekletmez: sınırlı kuyruk, delta birleştirme; kalıcı event store tek await edilen yazıcıdır.
- Bağımlılık bu fazda eklenmez; I5 workstream'i ekler.

## Alternatives

- **Ink:** Olgun, ekran okuyucu desteği var; React/Yoga bağımlılığı, JSX build'i, varsayılan tam yeniden çizim; OMP referansı değil. Plan B olarak adapter arkasında.
- **İnteraktif mod için kendi minimal ANSI kodumuz:** Editor, Kitty/modifyOtherKeys, IME, paste maliyeti yüksek. Reddedildi (plain ve JSONL için zaten seçili).
- **`@oh-my-pi/pi-tui`:** Bun ve Rust native zinciri gerektirir. Reddedildi.

## Consequences

- 0.x kütüphane: yükseltme ayrı PR ve [çapraz platform listesi](../research/tui/cross-platform-checklist.md) ile.
- Ekran okuyucu kullanıcıları `--plain` yolunu kullanır.
- Model çıktısındaki terminal escape dizileri render öncesi temizlenir (Synorch sorumluluğu).

## Evidence

- [TUI araştırması](../research/tui/README.md) §3–§5, [pi agent kalıpları](../research/tui/pi-agent-patterns.md) §4, §8, §9.
- `src/harness/contracts/renderer.ts` (`TerminalRenderer`, `selectRendererKind`, `selectColor`).
- Performans hedefleri (p95 frame < 16 ms) **ölçülmedi**; I5 spike'ında ölçülecek.

## Verification

- `tests/harness-contracts.test.ts`: `selectRendererKind` ve `selectColor` kural tablosu.
- `tests/harness-boundary.test.ts`: `@earendil-works/pi-tui` yalnız izinli dosyadan import edilir.
- I5: kontrol listesindeki P0 satırlar (Windows Terminal, conhost, macOS, Linux, SSH, GitHub Actions non-TTY).

## Revisit trigger

pi-tui'nin terk edilmesi veya uyumsuz breaking change, Windows'ta P0 hatası, ekran okuyucu desteği talebinin plain modla karşılanamaması.
