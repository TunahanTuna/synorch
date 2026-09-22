# Synorch CLI Harness: araştırma ve tasarım dosyası

> Durum: araştırma, kabul edilmiş kararlar (ADR-01…17), normatif sözleşmeler ve paylaşılan sözleşme kodu (`src/harness/contracts/`); runtime davranışı henüz uygulanmadı. İnceleme tarihi: 2026-09-22.

Bu dizin, Synorch'un gelecekte kendi CLI agent harness'ını geliştirmek için başvuru kaynağıdır. `harness` bu girişimin ana entegrasyon dalıdır; geliştirme işlerinin tabanı ve hedefi burasıdır. `main`e taşıma ayrı karardır. [Bugünkü Synorch mimarisi](../AI-ORCHESTRATION-ARCHITECTURE.md) ve [önceki çok sağlayıcılı harness vizyonu](../FUTURE-MULTI-PROVIDER-HARNESS.md) geçerliliğini korur. Bu belgeler onların yerine geçmez; kaynak araştırmasını, somut runtime sınırlarını ve doğrulama ölçütlerini ekler.

## Okuma sırası

1. [Mevcut durum ve kapsam](./foundation/current-state.md)
2. [Karşılaştırmalı araştırma](./research/comparison.md) ve [kaynak dizini](./research/sources.md)
3. [Runtime mimarisi](./design/runtime-architecture.md)
4. [Orkestrasyon ve sözleşmeler](./design/orchestration-contracts.md)
5. [Oturum ve bağlam](./design/session-and-context.md), [sağlayıcılar ve yapılandırma](./design/providers-and-configuration.md)
6. [Araçlar, izin ve güvenlik](./design/tools-and-security.md), [audit ve işletim](./design/audit-and-operations.md)
7. [CLI deneyimi](./design/cli-experience.md)
8. [Aşamalı teslim](./delivery/roadmap.md) ve [doğrulama](./delivery/verification.md)
9. [Geliştirme iş akışı](./workflow/README.md), [dokümantasyon planı](./workflow/documentation-plan.md), [görev oyun kitabı](./workflow/task-playbook.md) ve [yönetişim](./workflow/governance.md)
10. [Kararlar (ADR-01…17)](./decisions/README.md) ve [ADR kuyruğu](./delivery/decisions.md)
11. [Terimler](./foundation/terminology.md) ve [gereksinim izlenebilirliği](./foundation/requirements-traceability.md)
12. [Normatif sözleşmeler](./contracts/README.md) — tek kaynak `src/harness/contracts/*.ts`
13. [Faz I uygulama planı](./implementation-plan.md): iş akışları, dosya sahipliği, entegrasyon seam'leri

Kaynak incelemeleri: [Oh My Pi](./research/oh-my-pi.md), [DeepSeek Harness](./research/deepseek-harness.md), [Claude Code](./research/claude-code.md).

Hafıza ve kullanıcı odaklı bilgi haritası araştırması: [Obsidian ile yerel hafıza](./obsidian/README.md). Bu belge, oturum olay günlüğü ve orkestrasyon bağlamına bağlanan ayrı bir tasarım önerisidir.

## Bilgi statüsü

- **Doğrulanmış mevcut durum:** Bu deponun dosyaları ve komutlarıyla kanıtlanır.
- **Dış kaynak bulgusu:** Bağlantısı verilen resmi belge veya açık kaynak kod deposunda gözlenir. Bağlantılar zamanla değişebilir.
- **Öneri:** Synorch harness'ı için tasarım kararı adayıdır; uygulanmış özellik değildir.
- **Açık karar:** Uygulama başlamadan ADR ve deneyle kapanmalıdır.

`docs/FUTURE-MULTI-PROVIDER-HARNESS.md` ürün vizyonu ve öncelikler için ana bağlamdır. Buradaki teknik sözleşmeler birbiriyle çelişirse [açık kararlar](./delivery/decisions.md) dosyasına kaydedilir; sessizce uygulanmış varsayılmaz.

## En kısa hedef tanımı

Yerel terminalde çalışan; modeli, araçları ve oturum geçmişini kendi yöneten; Synorch'un orchestrator → explorer/implementer/debugger/reviewer örgütünü çalışma zamanında **gerçek izinler, kayıtlar ve bağımsız doğrulama** ile uygulayan bir harness. Mevcut deterministik `syn init/sync/doctor` işlevleri çalışmaya devam eder. İlk sürümde daemon veya web arayüzü gerekmiyor.
