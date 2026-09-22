# Önerilen CLI runtime mimarisi

> Statü: tasarım önerisi. [Mevcut ürün](../foundation/current-state.md) bunu henüz uygulamıyor. Dış referanslar: [DSH core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core), [OMP agent](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/README.md).

## İşlem sınırları

```text
Terminal UI / JSON event client
          │ kullanıcı komutları, interrupt, onay
          ▼
Application coordinator ── task DAG / Synorch protokolleri / bütçe
          │
          ├── Session + event store ── append / replay / projection
          ├── Model router ── provider adapter ── LLM stream
          ├── Agent loop ── message assembly / step lifecycle
          ├── Tool gateway ── schema / policy / approval / audit
          │                    └── isolated runner ── fs, shell, git
          └── Worker manager ── role, packet, lease, worktree, result
```

Terminal UI, JSON machine output ve gelecekteki SDK aynı application coordinator'a bağlanır. UI kendi task state'ini uydurmaz; ledger projection'ını görüntüler. Başlangıçta tek yerel process kabul edilebilir; subprocess izolasyonu tool/worker tarafında ayrı tutulur. Daemon/remote runner sonraki aşamadır.

## Çekirdek arayüzler

| Arayüz | Tek sorumluluk | Yasak bağımlılık |
| --- | --- | --- |
| `EventStore` | Olay append, seq/versiyon, flush, snapshot, replay | TUI görünümü |
| `ModelAdapter` | Capability bildirimi, stream, cancel, usage | Synorch rol kararı |
| `AgentDriver` | Turn/step ve model-tool çevrimi | Provider'a özgü auth |
| `ToolRegistry` | Şema ve araç görünürlüğü | Policy kararı |
| `ToolGateway` | Normalize → validate → authorize → execute → record | UI prompt'u doğrudan çalıştırma |
| `PolicyEngine` | Etkin yetkiyi hesaplama | Model metninden yetki kabulü |
| `ApprovalBroker` | Tek eylem için kullanıcı/otomasyon kararı | Sandbox olarak davranma |
| `SandboxRunner` | Process/dosya/ağ sınırını uygulama ve raporlama | Kendi kendine permission kararı |
| `WorkerManager` | Task packet, concurrency, izolasyon, sonuç | Ebeveyn transkriptini otomatik sızdırma |
| `ContextBuilder` | Log + dosya/skill referanslarından model girdisi | Sessiz özet/kesme |

Interface'ler somut package sayısı vaadi değildir. Önce tek runtime içinde modüller, gerçek ikinci implementasyon çıktığında dış plugin seam'i önerilir.

## Turn ve step yaşam döngüsü

```text
user input → input accepted/logged → turn opened
  → effective policy + context assembled
  → provider request prepared and recorded
  → stream deltas (geçici UI) → settled assistant message (kalıcı)
  → tool call parsed → gateway → result recorded
  → gerekiyorsa yeni step
  → completion gate / review state → turn closed
```

Bir step **bir model isteği ve onun istediği araç çağrılarıdır**; bir turn bir veya daha çok step içerir. İptal, provider hatası veya policy reddi “başarılı assistant cevabı”na dönüştürülmez. Stream edilen kısmi metin UI'da gösterilebilir; tamamlanmamış çağrı ayrı `attempt` olayıdır. Modelin gördüğü bütün injected içerik event log veya immutable blob referansından yeniden kurulabilir olmalı. Bu ilke [DeepSeek mimarisinde](https://deepseek-harness.github.io/deepseek-harness/en/reference/) de açık.

## Sahiplik ve tek yazıcı ilkesi

- Bir session log'unun aynı anda tek yazıcısı olur. İkinci process `resume` yaparsa lock/lease sonucu açıkça bildirilir.
- Event append sırası ile model request sırası tutarlı tutulur; `callId` ile `tool/result` eşleşir.
- Bir worker'ın etkin write scope'u task packet'taki `owned_paths`, kullanıcı onayı ve sandbox izinlerinin **kesişimi**dir. Task packet tek başına sandbox yetkisi vermez.
- Aynı path'i iki implementer eşzamanlı yazmaz. Çakışma task DAG veya ayrı worktree ile çözülür; merge/uygulama explicit bir koordinasyon eylemidir.
- Reviewer'a implementer'ın final iddiası ve diff'i verilir; mümkün olduğunda kendi okuma/test kanıtı ayrıca üretilir.

## Dayanıklılık

`queued → running → waiting_for_approval → completed/failed/cancelled/interrupted` state geçişleri olaylara bağlıdır. Crash sonrası replay açık tool veya worker işini `interrupted` sayar; aynı yan etkili çağrı otomatik tekrar edilmez. Salt okunur veya idempotent adımlar da ancak açık retry policy ile yinelenir. Çıktı dosyaları tamamlanmış sonuç sayılmadan önce digest ve ownership doğrulamasından geçer.

## Model yönlendirmesi

Mevcut Synorch model tier'ları (`orchestrator`, `complex_worker`, `fast_worker`) mantıksal girdidir. Runtime bunları provider/model ID'sine çözer, gerçek capability'leri test eder, etkin profil ve override kaynağını kullanıcıya gösterir. Model yoksa sessiz fallback yapılmaz; karar kayda geçirilir. Credential depolama ve model erişim yolu resmi sağlayıcı sözleşmesine bağlı kalır. Ayrıntı için [önceki vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md).
