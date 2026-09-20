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

## Skill havuzu

`sync`, proje sahibinin 33 skill'lik Ingenium havuzunu destek dosyalarıyla birlikte `.ai/skills/library/ingenium/` altına materialize eder ve kaynak/lisans/provenance bilgisini `.ai/skills/catalog.yaml` içinde tutar. React, Java, Node, Vue, JPA ve Tailwind skill'leri yalnız verified stack kanıtıyla otomatik aktive edilir; diğer skill'ler açıklamaları eşleştiğinde on-demand yüklenir. Bütün havuzun aynı anda context'e alınması yasaktır.

Anthropic Agent Skills, Superpowers ve Microsoft Agent Skills kaynakları sabit commit kimlikleriyle kataloglanır ancak güvenlik ve lisans incelemesi yapılmadan içerikleri otomatik import veya execute edilmez.

`init`, kaynak koda dokunmadan canonical orchestration çekirdeğini kurar. Ardından `sync`, repository veya workspace modüllerini kanıta dayalı olarak keşfeder, proje/skill registry'lerini ve seçilen teknoloji skill'lerini üretir; kullanıcı tarafından değiştirilmiş generated teknoloji skill'lerini yalnızca açık `--force` ile yeniler. Son olarak `doctor`, referans zincirini, canonical base skill kümesini ve path/symlink sınırlarını doğrular.

Mimari kararlar için [mimari planı](./docs/AI-ORCHESTRATION-ARCHITECTURE.md) inceleyin.
