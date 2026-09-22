# ADR-01: Paket sınırı ve runtime modül yerleşimi

## Status

Accepted

## Date

2026-09-22

## Context

Harness runtime'ının mevcut `synorch` paketi içinde mi yoksa ayrı bir workspace paketinde mi yaşayacağı açıktı ([açık kararlar](../delivery/decisions.md)). Mevcut `syn inspect/init/sync/doctor` komutları model bağımlılığı olmadan çalışıyor ve davranışları değişmemeli ([mevcut durum](../foundation/current-state.md)). Canonical şemalar (`src/domain/canonical-contracts.ts`) runtime tarafından da tüketilecek; iki pakete bölmek şema paylaşımı ve npm dağıtımını karmaşıklaştırır.

## Decision

- Tek yayımlanan npm paketi: `synorch`. `syn`/`synorch` ikilileri aynı `dist/cli.js` dosyasına bağlı kalır.
- Runtime `src/harness/` altında iç modüllere bölünür: `contracts`, `core`, `store`, `providers`, `auth`, `tools`, `policy`, `orchestration`, `context`, `memory`, `tui`, `cli`.
- `cli` dışındaki her modül yalnızca `src/harness/contracts` (ve `src/domain`, `node:*`, `zod`) modüllerine bağımlıdır. `contracts` yaprak modüldür; başka harness modülünü import etmez.
- `src/harness/cli` composition root'tur: somut implementasyonları bir araya getirir.
- `src/cli.ts` yeni komutlar için runtime'a yalnızca dinamik `import("./harness/cli/index.ts")` ile ulaşır. `src/cli.ts`, `src/application`, `src/domain`, `src/infrastructure`, `src/templates` harness'ı statik olarak import etmez.
- Mevcut `inspect/init/sync/doctor` komutları bayt düzeyinde aynı çıktıyı üretir.

## Alternatives

- **Ayrı workspace paketi (`@synorch/runtime`):** Canonical şema paylaşımı için üçüncü paket veya kopya gerekir; npm dağıtımı, sürüm eşlemesi ve `bin` yönetimi karmaşıklaşır. Reddedildi.
- **Harness'ı mevcut katmanlara dağıtmak (`application/`, `infrastructure/`):** Mevcut komutlar runtime kodunu dolaylı yükleyebilir; sınır testle korunamaz. Reddedildi.

## Consequences

- Paralel workstream'ler (I1–I6) ayrık dosya sahipliğiyle çalışır; tek ortak yüzey `contracts`'tır ve Faz D'de sabitlenmiştir.
- Runtime hatası veya ağır bağımlılık (ör. `@earendil-works/pi-tui`) mevcut komutların başlangıç süresini etkilemez.
- Sözleşme değişikliği tüm tüketicileri etkiler; [yönetişim](../workflow/governance.md) §4 uyarınca önce sözleşme görevi yapılır.

## Evidence

- `package.json` (`bin`, `files`, `check` script'i), `src/cli.ts` (mevcut komut dağıtımı).
- `src/harness/contracts/index.ts` ve alt dosyaları: tek sözleşme kaynağı.
- [Runtime mimarisi](../design/runtime-architecture.md) "Interface'ler somut package sayısı vaadi değildir" ilkesi.
- Ölçülmüş başlangıç süresi karşılaştırması henüz yok; I5 ile birlikte ölçülecek.

## Verification

- `tests/harness-boundary.test.ts`: mevcut katmanların harness'ı statik import etmediğini, `contracts`'ın yaprak olduğunu ve modüller arası izinli bağımlılık matrisini denetler.
- Mevcut testler (`tests/*.test.ts`) değişmeden geçer; I5, `syn inspect/init/sync/doctor` çıktılarının bayt eşitliği için snapshot testi ekler.
- `pnpm check`.

## Revisit trigger

Runtime'ın ayrı sürüm döngüsü gerektirmesi, `dist` boyutunun mevcut kullanıcılar için sorun olması veya üçüncü taraf bir tüketicinin yalnızca `contracts`'ı kullanmak istemesi.
