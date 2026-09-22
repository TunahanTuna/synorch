# ADR-02: Sabit agent loop ve arayüz seam'leri

## Status

Accepted

## Date

2026-09-22

## Context

DeepSeek Harness her kabiliyeti plugin yapar; OMP in-process extension/hook sunar; Synorch ise küçük bir CLI'dır ([karşılaştırma](../research/comparison.md)). "Her şey plugin" yaklaşımı yükleme, sürümleme ve yetki maliyeti getirir. Buna karşın test edilebilirlik ve paralel geliştirme için dar arayüzler gerekir. pi'nin `beforeToolCall` gibi hook'ları policy'nin yerine geçmemeli ([pi agent kalıpları](../research/tui/pi-agent-patterns.md) §3, §10).

## Decision

- `core` modülünde sabit ve küçük bir `AgentDriver` döngüsü: context → istek → stream → gateway üzerinden tool çağrıları → sonraki step. Döngü değiştirilebilir plugin değildir.
- Seam'ler `src/harness/contracts` içindeki arayüzlerdir: `ModelAdapter`, `AgentBackendAdapter`, `AuthProvider`, `CredentialStore`, `Tool`/`ToolRegistry`/`ToolGateway`, `PolicyEngine`, `ApprovalBroker`, `SandboxRunner`, `EventStore`/`SessionStore`/`BlobStore`, `ContextBuilder`, `WorkerManager`, `IsolationProvider`, `MemoryStore`, `TerminalRenderer`.
- Her arayüzün tek sahibi olan modül vardır ([uygulama planı](../implementation-plan.md)).
- Dinamik plugin yükleme yok (bkz. [ADR-12](./ADR-12-extensions.md)). Hook/callback varsa yalnız gözlem veya audit içindir; policy/approval kararını değiştiremez.

## Alternatives

- **DeepSeek tarzı plugin bileşimi:** Esnek; ancak ikinci implementasyon ihtiyacı kanıtlanmadan yükleme/sürüm/izolasyon maliyeti. Reddedildi.
- **`@earendil-works/pi-agent-core` kullanmak:** `pi-ai` dört provider SDK'sını ve `typebox`'ı çeker; Synorch'un zod şemaları ve policy katmanıyla çakışır ([pi agent kalıpları](../research/tui/pi-agent-patterns.md)). Reddedildi; yalnız kalıplar alınır.

## Consequences

- Test seam'leri hazır: her arayüz için sahte implementasyonla birim testi yazılabilir.
- Yeni kabiliyet (MCP istemcisi, ikinci sandbox backend) önce sözleşmeye eklenir, sonra implementasyona.
- Hook tabanlı kullanıcı özelleştirmesi v1'de yok.

## Evidence

- `src/harness/contracts/runtime.ts` (`AgentDriver`, `ContextBuilder`, `WorkerManager`, `IsolationProvider`), `model.ts`, `auth.ts`, `tools.ts`, `policy.ts`, `store.ts`, `memory.ts`, `renderer.ts`.
- [Runtime mimarisi](../design/runtime-architecture.md) "Çekirdek arayüzler" tablosu.

## Verification

- `tests/harness-boundary.test.ts` modüllerin yalnız `contracts` üzerinden bağlandığını doğrular.
- I1: `AgentDriver` sahte `ModelAdapter` ve `ToolGateway` ile replay testleri; I3: gateway'in hook'la atlanamadığını gösteren negatif test.

## Revisit trigger

Aynı seam için ikinci gerçek implementasyonun kullanıcı tarafından talep edilmesi veya üçüncü taraf entegrasyon ihtiyacı (bkz. ADR-12).
