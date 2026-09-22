# ADR-12: Plugin ve extension dağıtımı

## Status

Accepted

## Date

2026-09-22

## Context

Üçüncü taraf plugin kodu imza, yetki manifesti ve process izolasyonu gerektirir ([araçlar ve güvenlik](../design/tools-and-security.md) tehdit tablosu). "Her şey plugin" yaklaşımı küçük CLI için otomatik fayda sağlamaz ([karşılaştırma](../research/comparison.md)).

## Decision

- v1'de yalnızca yerleşik adapter'lar ve yerleşik araçlar vardır.
- Üçüncü taraf plugin/extension yükleme, dinamik `import` ile kullanıcı kodu çalıştırma veya npm'den eklenti keşfi yoktur.
- `toolMetadataSchema.source` değerleri `mcp` ve `extension` sözleşmede ileriye dönük olarak tanımlıdır; kendi etkilerini beyan edemezler (`effect_source`).

## Alternatives

- **İn-process extension API (OMP tarzı):** Yetki sınırı yok; güvenlik modeliyle çelişir. Reddedildi.
- **İmzalı plugin pazarı:** Kullanıcı talebi ve güvenlik altyapısı olmadan erken. Ertelendi.

## Consequences

- Kabiliyet genişlemesi Synorch sürümüyle gelir; saldırı yüzeyi dar kalır.

## Evidence

- `src/harness/contracts/tools.ts` (`TOOL_SOURCES`, `effect_source` refinement'ı).
- [Yol haritası](../delivery/roadmap.md) "Sonraki ürünler".

## Verification

- `tests/harness-boundary.test.ts`: harness modüllerinde değişken hedefli dinamik `import()` bulunmaması (yalnız `src/cli.ts`'deki sabit literal izinli).
- `tests/harness-contracts.test.ts`: yerleşik olmayan aracın kendi etkisini beyan edememesi.

## Revisit trigger

Somut kullanıcı talebi ve imza/izolasyon tasarımının hazır olması.
