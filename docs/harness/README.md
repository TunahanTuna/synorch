# Synorch CLI Harness: araştırma ve tasarım dosyası

> Durum: araştırma ve önerilen tasarım; runtime uygulanmadı. İnceleme tarihi: 2026-09-22.

Bu dizin, Synorch'un gelecekte kendi CLI agent harness'ını geliştirmek için başvuru kaynağıdır. [Bugünkü Synorch mimarisi](../AI-ORCHESTRATION-ARCHITECTURE.md) ve [önceki çok sağlayıcılı harness vizyonu](../FUTURE-MULTI-PROVIDER-HARNESS.md) geçerliliğini korur. Bu belgeler onların yerine geçmez; kaynak araştırmasını, somut runtime sınırlarını ve doğrulama ölçütlerini ekler.

## Okuma sırası

1. [Mevcut durum ve kapsam](./foundation/current-state.md)
2. [Karşılaştırmalı araştırma](./research/comparison.md) ve [kaynak dizini](./research/sources.md)
3. [Runtime mimarisi](./design/runtime-architecture.md)
4. [Orkestrasyon ve sözleşmeler](./design/orchestration-contracts.md)
5. [Oturum ve bağlam](./design/session-and-context.md), [sağlayıcılar ve yapılandırma](./design/providers-and-configuration.md)
6. [Araçlar, izin ve güvenlik](./design/tools-and-security.md), [audit ve işletim](./design/audit-and-operations.md)
7. [CLI deneyimi](./design/cli-experience.md)
8. [Aşamalı teslim](./delivery/roadmap.md) ve [doğrulama](./delivery/verification.md)
9. [Açık kararlar](./delivery/decisions.md)

Kaynak incelemeleri: [Oh My Pi](./research/oh-my-pi.md), [DeepSeek Harness](./research/deepseek-harness.md), [Claude Code](./research/claude-code.md).

## Bilgi statüsü

- **Doğrulanmış mevcut durum:** Bu deponun dosyaları ve komutlarıyla kanıtlanır.
- **Dış kaynak bulgusu:** Bağlantısı verilen resmi belge veya açık kaynak kod deposunda gözlenir. Bağlantılar zamanla değişebilir.
- **Öneri:** Synorch harness'ı için tasarım kararı adayıdır; uygulanmış özellik değildir.
- **Açık karar:** Uygulama başlamadan ADR ve deneyle kapanmalıdır.

`docs/FUTURE-MULTI-PROVIDER-HARNESS.md` ürün vizyonu ve öncelikler için ana bağlamdır. Buradaki teknik sözleşmeler birbiriyle çelişirse [açık kararlar](./delivery/decisions.md) dosyasına kaydedilir; sessizce uygulanmış varsayılmaz.

## En kısa hedef tanımı

Yerel terminalde çalışan; modeli, araçları ve oturum geçmişini kendi yöneten; Synorch'un orchestrator → explorer/implementer/debugger/reviewer örgütünü çalışma zamanında **gerçek izinler, kayıtlar ve bağımsız doğrulama** ile uygulayan bir harness. Mevcut deterministik `syn init/sync/doctor` işlevleri çalışmaya devam eder. İlk sürümde daemon veya web arayüzü gerekmiyor.
