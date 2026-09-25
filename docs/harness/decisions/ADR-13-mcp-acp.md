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

## 2026-09-25 revizyon — K3 MCP istemcisi uygulandı

Harici MCP server'larına bağlanan istemci Faz 4'ten öne alındı (K3 + K4.3; ürün sahibi: "yetenekli bir araç", Playwright ile tarayıcı otomasyonu). Bu bölüm önceki kararları silmez; yalnız etki sınıfını günceller.

- **Kütüphane:** resmi `@modelcontextprotocol/sdk` (stdio, streamable HTTP, eski SSE); SDK yalnız ilk bağlantıda yüklenir. Modül: `src/harness/mcp/` (yalnız `contracts`'a bağımlı).
- **Yapılandırma:** kullanıcı `~/.synorch/config.yaml` `mcp.servers`; proje `.synorch/config.yaml` `mcp.servers` ve kökteki `.mcp.json` (`mcpServers`). Depo katmanı yalnız daraltabilir (SEC-C1): proje server'ı, kullanıcı o tanımı (digest) bu çalışma alanı için bir kez onaylamadan (`syn mcp approve` / `/mcp approve`) başlatılmaz; onay kullanıcı kapsamında (`mcp-approvals.json`). Tanım değişirse yeniden onay gerekir.
- **Etki sınıfı (revize):** `default-high-risk → external-write` yerine `effect_source: user-config`: `trust: full` (varsayılan) → `exec`, `trust: read-only` → `read`. Gerekçe: `external-write` `auto`'da her çağrıda sorar; ürün sahibinin "auto = otonom, izin yorgunluğu yok" kararıyla çelişir. Sonuç: `ask` sorar, `auto`/`full` sormaz, `plan` reddeder; sunucunun kendi `readOnlyHint` beyanı politika değildir.
- **Güvenilmeyen veri:** her MCP sonucu `<untrusted_mcp_content>` zarfında döner ve web içeriği gibi prompt-injection kalkanını tetikler (aynı turda dışa etkili eylem yine sorar). Büyük sonuç gateway'de blob'a kesilir; görsel içerik görsel blob olarak eklenir.
- **Roller:** `full` server'lar session/implementer/debugger; `read-only` server'lar ayrıca explorer/reviewer (orchestrator hiçbirini görmez); `roles:` ile daraltılabilir.
- **Başlatma:** `startup: lazy` (varsayılan) araç listesi önbellekteyse server'ı ilk çağrıda başlatır, değilse oturum başında bağlanır; `session` her oturumda bağlanır. stderr `~/.synorch/logs/mcp/<server>.log`'a gider; server'lar oturumla kapanır (Windows'ta süreç ağacı).
- **Claude Code native mod:** server'lar çift proxy yerine `--mcp-config` ile Claude'a verilir (Synorch relay'inin yanında); relay listesi o zaman `mcp__*` araçlarını dışarıda bırakır. `auto`/`full`'da `--allowedTools mcp__<server>` ile sorulmaz; `ask`'ta Claude'un izin istemi Synorch kartına gelir (`exec`), `plan` reddeder. Restricted modda araçlar relay (gateway) üzerinden gider. Sınırlama: native modda rol daraltması Claude'a uygulanmaz; oturum ortasındaki `/mcp disable` Claude'a bir sonraki oturumda yansır.
