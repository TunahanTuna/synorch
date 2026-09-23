# Harness mimari karar kayıtları (ADR)

> Durum: normatif; ADR'ler `Accepted`. Tarih: 2026-09-22 (ADR-18…20: 2026-09-23, canlı çalıştırma sağlamlaştırması). `Accepted` seçeneğin gerekçeyle seçildiğini gösterir, kodun yayımlandığı anlamına gelmez; `Implemented` statüsü yalnız kod/test kanıtıyla verilir. Yaşam döngüsü (`Proposed → Accepted → Implemented → Superseded | Rejected`) ve değişiklik kuralları: [yönetişim](../workflow/governance.md) §3. Karar kuyruğunun tarihçesi: [açık kararlar](../delivery/decisions.md).

Her ADR, [ADR şablonundaki](../delivery/decisions.md#adr-şablonu) bölümleri taşır: Status, Date, Context, Decision, Alternatives, Consequences, Evidence, Verification, Revisit trigger. Gereksinim eşlemesi: [gereksinim izlenebilirliği](../foundation/requirements-traceability.md). Terimler: [terminoloji](../foundation/terminology.md).

| ID | Başlık | Statü | Tarih | Dosya | İlgili sözleşme | HREQ |
| --- | --- | --- | --- | --- | --- | --- |
| ADR-01 | Paket sınırı ve runtime modül yerleşimi | Accepted | 2026-09-22 | [ADR-01](./ADR-01-package-boundary.md) | [identity-and-state](../contracts/identity-and-state.md), [cli-and-jsonl](../contracts/cli-and-jsonl.md) | HREQ-001 |
| ADR-02 | Sabit agent loop ve arayüz seam'leri | Accepted | 2026-09-22 | [ADR-02](./ADR-02-agent-loop-seams.md) | [model-adapter](../contracts/model-adapter.md), [tools](../contracts/tools.md) | HREQ-002, HREQ-021 |
| ADR-03 | Oturum deposu — segmentli append-only JSONL | Accepted | 2026-09-22 | [ADR-03](./ADR-03-session-store.md) | [events-and-storage](../contracts/events-and-storage.md) | HREQ-005, HREQ-006 |
| ADR-04 | Terminal renderer | Accepted | 2026-09-22 | [ADR-04](./ADR-04-terminal-renderer.md) | [cli-and-jsonl](../contracts/cli-and-jsonl.md) | HREQ-013 |
| ADR-05 | Sağlayıcılar ve kimlik doğrulama | Accepted | 2026-09-22 | [ADR-05](./ADR-05-provider-auth.md) | [model-adapter](../contracts/model-adapter.md) | HREQ-009, HREQ-010, HREQ-011, HREQ-012, HREQ-022 |
| ADR-06 | Sandbox tabanı | Accepted | 2026-09-22 | [ADR-06](./ADR-06-sandbox.md) | [tools](../contracts/tools.md), [policy-and-approval](../contracts/policy-and-approval.md) | HREQ-008, HREQ-020 |
| ADR-07 | Worker izolasyonu (ADR-19 ile kısmen değiştirildi) | Accepted | 2026-09-22 | [ADR-07](./ADR-07-worker-isolation.md) | [task-packets](../contracts/task-packets.md) | HREQ-015 |
| ADR-08 | Onay politikası — otonom varsayılan ve hard rail'ler | Accepted | 2026-09-22 | [ADR-08](./ADR-08-approval-policy.md) | [policy-and-approval](../contracts/policy-and-approval.md) | HREQ-007, HREQ-008 |
| ADR-09 | Reviewer bağımsızlığı (ADR-18 ile kısmen değiştirildi) | Accepted | 2026-09-22 | [ADR-09](./ADR-09-reviewer-independence.md) | [task-packets](../contracts/task-packets.md) | HREQ-004 |
| ADR-10 | Debugger yazma yetkisi | Accepted | 2026-09-22 | [ADR-10](./ADR-10-debugger-write.md) | [task-packets](../contracts/task-packets.md) | HREQ-002, HREQ-003 |
| ADR-11 | Başlangıç compaction yöntemi | Accepted | 2026-09-22 | [ADR-11](./ADR-11-compaction.md) | [events-and-storage](../contracts/events-and-storage.md) | HREQ-006, HREQ-017 |
| ADR-12 | Plugin ve extension dağıtımı | Accepted | 2026-09-22 | [ADR-12](./ADR-12-extensions.md) | [tools](../contracts/tools.md) | HREQ-021 |
| ADR-13 | MCP ve ACP kapsamı | Accepted | 2026-09-22 | [ADR-13](./ADR-13-mcp-acp.md) | [model-adapter](../contracts/model-adapter.md), [tools](../contracts/tools.md) | HREQ-010, HREQ-021 |
| ADR-14 | Bütçe aşımı | Accepted | 2026-09-22 | [ADR-14](./ADR-14-budget.md) | [model-adapter](../contracts/model-adapter.md), [events-and-storage](../contracts/events-and-storage.md) | HREQ-016 |
| ADR-15 | Headless çalışma ve onay | Accepted | 2026-09-22 | [ADR-15](./ADR-15-headless.md) | [cli-and-jsonl](../contracts/cli-and-jsonl.md), [policy-and-approval](../contracts/policy-and-approval.md) | HREQ-007, HREQ-014 |
| ADR-16 | Hafıza konumu ve Obsidian'ın rolü | Accepted | 2026-09-22 | [ADR-16](./ADR-16-memory-location.md) | [memory](../contracts/memory.md) | HREQ-018 |
| ADR-17 | Hafıza yazma politikası ve review kuyruğu | Accepted | 2026-09-22 | [ADR-17](./ADR-17-memory-write-policy.md) | [memory](../contracts/memory.md) | HREQ-019 |
| ADR-18 | Harness'in hesapladığı kanıt, toleranslı çözümleme, model dostu düzenleme araçları (ADR-09'u kısmen değiştirir) | Accepted | 2026-09-23 | [ADR-18](./ADR-18-harness-computed-evidence.md) | [task-packets](../contracts/task-packets.md), [tools](../contracts/tools.md), [events-and-storage](../contracts/events-and-storage.md), [runtime-seams](../contracts/runtime-seams.md) | HREQ-003, HREQ-004 |
| ADR-19 | Çalışma alanı sadakati — tek digest şeması, izolasyon, integrate (ADR-07'yi kısmen değiştirir) | Accepted | 2026-09-23 | [ADR-19](./ADR-19-workspace-fidelity.md) | [events-and-storage](../contracts/events-and-storage.md), [runtime-seams](../contracts/runtime-seams.md), [task-packets](../contracts/task-packets.md) | HREQ-015 |
| ADR-20 | Bağlam verimliliği — terminal araçta tur sonu, prompt cache, rol başına kapsam | Accepted | 2026-09-23 | [ADR-20](./ADR-20-context-efficiency.md) | [model-adapter](../contracts/model-adapter.md), [tools](../contracts/tools.md) | HREQ-006, HREQ-016 |
| ADR-21 | Konuşma öncelikli runtime — ana ajan (`session` rolü), kabiliyet olarak orkestrasyon (ADR-02/08/09/15'i kısmen değiştirir) | Proposed | 2026-09-23 | [ADR-21](./ADR-21-conversation-first-runtime.md) | [policy-and-approval](../contracts/policy-and-approval.md), [runtime-seams](../contracts/runtime-seams.md), [cli-and-jsonl](../contracts/cli-and-jsonl.md) | HREQ-023…HREQ-040 |

## Açık alt kararlar

Bu alt kararlar ilgili workstream içinde ADR ekiyle kapanır; üst karar değişmez:

- ADR-05: OS keychain için native bağımlılık seçimi (I2).
- ADR-05: Anthropic'ten Claude Code köprüsü için yazılı onay talebi (ürün sahibi).
- ADR-06: Windows için tam OS backend'i (v1 sonrası).
- ADR-04: pi-tui spike ölçümleri (I5).
