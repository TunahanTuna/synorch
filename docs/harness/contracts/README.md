# Harness normatif sözleşmeleri

> Durum: `accepted` (şema dondurma: 2026-09-22). Sahip: `src/harness/contracts/`. Bu klasördeki alan adları, durum makineleri ve hata kodları **kodla aynı kaynaktan** gelir: tek doğruluk kaynağı `src/harness/contracts/*.ts` içindeki Zod şemaları ve TypeScript arayüzleridir. Belge ile kod ayrışırsa [yönetişim](../workflow/governance.md) kuralıyla sapma kaydı açılır.

| Belge | Konu | Kod |
| --- | --- | --- |
| [identity-and-state.md](./identity-and-state.md) | Kimlik tipleri, durum makineleri, recovery | `ids.ts`, `state.ts` |
| [events-and-storage.md](./events-and-storage.md) | Event envelope, katalog, segmentli JSONL, lease, blob | `events.ts`, `store.ts`, `digest.ts` |
| [model-adapter.md](./model-adapter.md) | ModelAdapter, AgentBackendAdapter, stream, capability, hata, auth | `model.ts`, `auth.ts` |
| [tools.md](./tools.md) | Tool metadata, gateway hattı, sonuç, sandbox | `tools.ts` |
| [policy-and-approval.md](./policy-and-approval.md) | Etkin politika, modlar, hard rail, onay | `policy.ts`, `paths.ts` |
| [task-packets.md](./task-packets.md) | Plan, Task Context Packet v2, delta, completion, review | `packets.ts` |
| [cli-and-jsonl.md](./cli-and-jsonl.md) | Komutlar, renderer seçimi, JSONL frame, exit code | `jsonl.ts`, `errors.ts`, `renderer.ts` |
| [memory.md](./memory.md) | Markdown hafıza notu, ilişki, öneri kuyruğu | `memory.ts` |
| [runtime-seams.md](./runtime-seams.md) | ContextBuilder, AgentDriver, WorkerManager, IsolationProvider, projection, rapor araçları, glob eşleştirici | `runtime.ts`, `projection.ts`, `paths.ts` |

## Örnek blokları

Bu klasördeki her ```` ```yaml example=<ad> ```` bloğu `tests/harness-contracts.test.ts` tarafından ilgili şemayla parse edilir. `invalid` işaretli bloklar **reddedilmelidir**; `unsupported` işaretli event blokları okuyucu tarafından `unsupported` raporlanmalıdır. Kök düzeyde liste verilirse her eleman ayrı örnektir. Yeni örnek eklemek, testi değiştirmeden yeni bir kabul/ret vakası eklemek demektir.

Ortak örnek kimlikleri (geçerli ULID'ler): `run_01K5T3Q8Z4X9V2M6N7P0R1S2T3`, `ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4`, `plan_01K5T3Q8Z4X9V2M6N7P0R1S2T5`, `task_01K5T3Q8Z4X9V2M6N7P0R1S2T6`, `att_01K5T3Q8Z4X9V2M6N7P0R1S2T8`.
