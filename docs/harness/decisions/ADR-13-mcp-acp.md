# ADR-13: MCP ve ACP kapsamı

## Status

Accepted

## Date

2026-09-22

## Context

MCP harici server ile client arasında açık protokol sunar; server'ın bildirdiği tool açıklaması güvenilir policy değildir ([araçlar ve güvenlik](../design/tools-and-security.md)). ADR-05 ile Claude köprüsü Synorch araçlarını MCP üzerinden almak zorundadır ([cli-bridges](../research/provider-auth/cli-bridges.md)).

## Decision

- v1'de Synorch yalnızca dahili bir MCP server'ı olarak çalışır: `cli-bridge` adapter'larının araç kanalı (`ToolBridge`, `serverName: "synorch"`). Diğer istemcilere açılmaz; her çağrı `ToolGateway`'den geçer.
- Harici MCP server'larına bağlanan MCP istemcisi v1 sonrasına (Faz 4) ertelenir. Eklendiğinde bu araçlar varsayılan olarak `external-write` sayılır veya etkileri kullanıcı konfigürasyonundan gelir (`effect_source: default-high-risk | user-config`).
- ACP host desteği daha sonraki bir karardır.

## Alternatives

- **v1'de MCP istemcisi:** Kapsamı ve güvenlik yüzeyini büyütür; ilk dikey dilim için gerekmiyor. Ertelendi.
- **Köprü araç kanalı için MCP dışı özel protokol:** Claude Code resmi olarak MCP destekliyor; özel protokol mümkün değil. Reddedildi.

## Consequences

- MCP server implementasyonu I2 (köprü) ile I3 (gateway) arasında bir entegrasyon seam'idir.

## Evidence

- `src/harness/contracts/model.ts` (`ToolBridge`, `ApprovalBridge`, `tool_channel`), `tools.ts` (`effect_source`).
- Sözleşme: [model adapter](../contracts/model-adapter.md), [araçlar](../contracts/tools.md).

## Verification

- `tests/harness-contracts.test.ts`: `default-high-risk` kaynaklı aracın `external-write` dışında sınıflanamaması.
- I2/I3: köprü MCP çağrısının gateway olaylarını (`tool/call_proposed` … `tool/result_recorded`) üretmesi.

## Revisit trigger

Kullanıcıların harici MCP araçlarına ihtiyaç bildirmesi veya ACP istemci ekosisteminin olgunlaşması.
