# ai-structure

`ai-structure`, Codex ve Claude Code için provider-bağımsız, orchestrator merkezli agent/skill/protokol yapısı kuran Node.js tabanlı bir CLI'dır.

## Geliştirme

```bash
pnpm install
pnpm check
pnpm dev -- inspect
```

## Komutlar

```bash
ai-structure inspect [--target <path>] [--scope workspace|repository]
ai-structure init [--target <path>] [--scope workspace|repository] [--force]
ai-structure sync [--target <path>] [--force] [--json]
ai-structure doctor [--target <path>] [--json]
```

`init`, kaynak koda dokunmadan canonical orchestration çekirdeğini kurar. Ardından `sync`, repository veya workspace modüllerini kanıta dayalı olarak keşfeder, proje/skill registry'lerini ve seçilen teknoloji skill'lerini üretir; kullanıcı tarafından değiştirilmiş generated teknoloji skill'lerini yalnızca açık `--force` ile yeniler. Son olarak `doctor`, referans zincirini, canonical base skill kümesini ve path/symlink sınırlarını doğrular.

Mimari kararlar için [mimari planı](./docs/AI-ORCHESTRATION-ARCHITECTURE.md) inceleyin.
