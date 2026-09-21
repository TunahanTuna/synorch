# Synorch

`synorch`, Codex ve Claude Code için provider-bağımsız, orchestrator merkezli agent/skill/protokol yapısı kuran Node.js tabanlı bir CLI'dır. Paket adı `synorch`, kurulumdan sonraki kısa terminal komutu `syn`'dir.

## Kullanım

Kurulum yapmadan çalıştırma:

```bash
npx synorch init
pnpm dlx synorch init
yarn dlx synorch init
```

Global kurulumdan sonra kısa komut:

```bash
npm install --global synorch
syn init
```

## Geliştirme

```bash
pnpm install
pnpm check
pnpm dev -- inspect
```

## Komutlar

```bash
syn inspect [--target <path>] [--scope workspace|repository]
syn init [--target <path>] [--scope workspace|repository] [--force]
syn sync [--target <path>] [--force] [--json]
syn doctor [--target <path>] [--json]
```

## Skill havuzu

`init`, Ingenium'dan bağımsız canonical `task-conductor` dahil sekiz base skill üretir. Task Conductor yalnız non-trivial brief'lerde merkezi decomposition/routing disiplini olarak kullanılır; tek satırlık işler için orkestra kurulmaz.

`sync`, proje sahibinin 32 skill'lik Ingenium havuzunu destek dosyalarıyla birlikte `.ai/skills/library/ingenium/` altına materialize eder ve kaynak/lisans/provenance bilgisini `.ai/skills/catalog.yaml` içinde tutar. Katalog girdileri yalnız `available` durumundadır ve varsayılan olarak context'e yüklenmez. React, Java, Node, Vue, JPA ve Tailwind skill'leri yalnız verified stack kanıtıyla aktive edilir; diğer skill'ler görev açıklaması gerçekten eşleştiğinde just-in-time yüklenir. Bütün havuzun aynı anda taranması veya context'e alınması yasaktır.

Görevler `trivial`, `standard` veya `high-risk` olarak sınıflandırılır. Trivial işler tek fast worker ve claim-specific kanıtla tamamlanır; bağımsız reviewer, full-project kontroller ve headed browser varsayılan olarak kullanılmaz. Browser doğrulaması yalnız kullanıcı isteğiyle veya daha ucuz kanıtların çözemediği isimlendirilmiş bir kriter için ayrıca onay alınarak yapılır.

Anthropic Agent Skills, Superpowers ve Microsoft Agent Skills kaynakları sabit commit kimlikleriyle kataloglanır ancak güvenlik ve lisans incelemesi yapılmadan içerikleri otomatik import veya execute edilmez.

`init`, kaynak koda dokunmadan canonical orchestration çekirdeğini kurar. Ardından `sync`, repository veya workspace modüllerini kanıta dayalı olarak keşfeder, proje/skill registry'lerini ve seçilen teknoloji skill'lerini üretir; kullanıcı tarafından değiştirilmiş generated teknoloji skill'lerini yalnızca açık `--force` ile yeniler. Son olarak `doctor`, referans zincirini, canonical base skill kümesini ve path/symlink sınırlarını doğrular.

Mimari kararlar için [mimari planı](./docs/AI-ORCHESTRATION-ARCHITECTURE.md) inceleyin.

## Gereksinimler ve proje bilgileri

- Node.js 24 veya daha yeni bir sürüm gerekir.
- Sürüm geçmişi için [CHANGELOG.md](./CHANGELOG.md) dosyasını inceleyin.
- Güvenlik açıklarını herkese açık issue yerine [güvenlik politikasındaki](./SECURITY.md) özel bildirim akışıyla paylaşın.
- Synorch, [MIT lisansı](./LICENSE) altında yayımlanır.

Güncel sürüm notları [Synorch v0.2.0](./docs/releases/v0.2.0.md) belgesinde yer alır.
