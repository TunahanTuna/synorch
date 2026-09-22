# ADR-16: Hafıza konumu ve Obsidian'ın rolü

## Status

Accepted

## Date

2026-09-22

## Context

Varsayılan hafıza kökünün proje içinde mi kullanıcı alanında mı olacağı açıktı ([Obsidian ile yerel hafıza](../obsidian/README.md) §10). Kişisel hafıza ile ekip bilgisi aynı gizlilik ve paylaşım politikasına sahip değildir; harness dokümanlarının Git'te tutulması kişisel hafızanın Git'e yazılacağı anlamına gelmez.

## Decision

- Kişisel hafıza varsayılanı: `~/.synorch/memory/<project-id>/` (`DEFAULT_MEMORY_ROOT_SEGMENTS`); `memory.root` konfigürasyonuyla değiştirilebilir.
- Depo içinde ekip vault'u açık opt-in'dir (`memory.team_root`); buradaki `decision` ve `preference` notları her zaman review gerektirir.
- Hafıza düz Markdown + YAML frontmatter'dır; Obsidian isteğe bağlı görüntüleyicidir, asla runtime bağımlılığı değildir. URI/CLI entegrasyonu kolaylıktır.
- `project-id`, `deriveProjectId` ile çalışma kökünden türetilir.

## Alternatives

- **Varsayılan olarak repo içi `.ai/memory/`:** Kişisel tercih ve kanıtların istemeden commit edilmesi riski. Reddedildi.
- **Obsidian plugin veya REST eklentisi zorunluluğu:** Kurulum bağımlılığı ve güvenlik riski. Reddedildi.

## Consequences

- Obsidian kurulu değilken tüm hafıza işlemleri CLI ile çalışır.
- Ekip paylaşımı bilinçli bir konfigürasyon adımıdır.

## Evidence

- [Obsidian ile yerel hafıza](../obsidian/README.md) §3, §5.2, §7.
- `src/harness/contracts/memory.ts` (`DEFAULT_MEMORY_ROOT_SEGMENTS`, `MemoryStore`), `ids.ts` (`deriveProjectId`).
- Sözleşme: [hafıza](../contracts/memory.md).

## Verification

- `tests/harness-contracts.test.ts`: `deriveProjectId` kararlılığı (Windows büyük/küçük harf), not frontmatter örnekleri.
- I6: Obsidian olmadan yazma/arama/kaynak gösterme; `memory.root` override; ekip vault'unda review zorunluluğu.

## Revisit trigger

Ekip kullanımının baskın hale gelmesi veya çoklu makine senkronizasyonu talebi.
