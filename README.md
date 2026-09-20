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
ai-structure sync [--target <path>]
ai-structure doctor [--target <path>] [--json]
```

Mimari kararlar için [mimari planı](./docs/AI-ORCHESTRATION-ARCHITECTURE.md) inceleyin.
