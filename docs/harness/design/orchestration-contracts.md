# Synorch orkestrasyonunun runtime sözleşmeleri

> Statü: öneri. Canonical rol/protokol/skill tanımları [mevcut mimaride](../../AI-ORCHESTRATION-ARCHITECTURE.md) belgeli. Buradaki alan adları şema taslağıdır; mevcut Zod şeması gibi sunulmamalı.

## Görev hiyerarşisi

```text
Run (kullanıcı isteği, profil ve bütçe)
 └─ Plan (sürüm, kapsam, onay)
     └─ Task DAG (bağımlılıklar ve path ownership)
         └─ Attempt (worker/model/lease/sonuç)
             └─ Step → model isteği / tool çağrıları
```

`RunId`, `PlanId`, `TaskId`, `AttemptId`, `SessionId`, `ToolCallId`, `ApprovalId` birbirinin yerine kullanılamayan tipler olmalı. Bir task'ın yeni attempt'i önceki attempt'i silmez. Aynı plan sürümü için verilmiş onay, kapsam veya etkili yetki genişlerse geçersizleşir.

## Plan ve yetki kapısı

Plan kaydı en az şunları içermeli: hedef, kapsam/path'ler, yapılacak işler, risk sınıfı, bağımlılıklar, beklenen dış etkiler, doğrulama yöntemi, tahmini bütçe, varsayımlar ve plan sürümü/digest'i. Onay kaydı `subjectDigest`, kapsam, veren aktör, zaman, karar ve varsa son kullanma durumunu taşır. Bir onay yalnızca eşleşen plan/eylem için geçerli olur. Mevcut Synorch'un “her iş planlanır” ilkesi korunur; onay tekrarı ve trivial iş politikası [açık karar](../delivery/decisions.md).

## Task Context Packet vNext

```yaml
schema_version: 2             # önerilen sürüm; henüz uygulanmadı
task_id: task-123
plan_id: plan-456
plan_digest: sha256:...
role: implementer
model_tier: complex_worker
objective: ...
scope:
  owned_paths: [src/auth/**]
  read_paths: [src/session/**]
  forbidden_paths: [src/billing/**]
known_facts:
  - statement: ...
    source: src/auth/service.ts
    source_digest: sha256:...
acceptance_criteria:
  - id: AC-1
    statement: ...
verification:
  commands: [pnpm test]
limits:
  max_steps: 30
  max_wall_time_seconds: 1800
  max_cost_estimate: ...
```

Packet içeriği mevcut Synorch [bağlam aktarımı](../../AI-ORCHESTRATION-ARCHITECTURE.md) ile uyumlu tutulur. `known_facts` kaynak veya digest kaybetmez. Worker'a gerekli bilgi verilir; geniş transkript varsayılan olarak devredilmez. `extends` + parent digest ile delta handoff yapılabilir. Kaynak digest değişmişse worker durur ve orchestrator yeniden paketler.

## Completion ve review

Completion packet: `task_id`, `attempt_id`, durum, değişen yollar/digest'ler, yapılan tool çağrılarının özet kimlikleri, her kabul ölçütü için kanıt referansı, test komutu/exit code, açık riskler ve worker'ın verdiği kararlar. Review packet: incelenen artifact digest, ölçüt bazında karar, bağımsız kanıt, bulgular (şiddet, yol/konum, tekrar yolu), `accept/revise/block` önerisi. Orchestrator bunlardan final raporu üretir; implementer'ın kendi raporu tek başına nihai kabul değildir.

## Rol yetkileri

| Rol | Varsayılan yetki | Sınır |
| --- | --- | --- |
| Orchestrator | Okuma, plan/ledger metadata, delegasyon | Ürün dosyası yazmaz; kendi kararını reviewer yerine geçirmez |
| Explorer | Kaynak okuma/arama | Yazma ve etkili dış işlem yok |
| Implementer | Sahip olduğu dosyaları izole çalışma alanında değiştirme | Başka worker kapsamına yazma yok |
| Debugger | RCA; izin verilirse sınırlı düzeltme | Yazma modu task'ta ayrıca belirtilir |
| Reviewer | Diff, kaynak, test kanıtı okuma; gerekirse izole doğrulama | İncelediği artifact'a sessiz yazma yok |

Politika yalnızca role bağlı değildir. `effective = platform ∩ user approval ∩ workspace policy ∩ role ∩ task scope ∩ sandbox capability`. Her genişleme yeni karar ve olay gerektirir. Bu, modelin prompt ile kendine yetki vermesini engeller.

## Scheduler ve bağımsızlık

Task DAG çevrimsiz doğrulanır; concurrency limit global, sağlayıcı ve workspace düzeyinde uygulanır. Aynı dosya sahipliği isteyen iki task eşzamanlı yürütülmez. İnceleme task'ı, implementasyon artifact'ı sabitlenmeden başlamaz. Risk artışı planı yeniden sürümler; yetki genişlemesi ve kullanıcı onayı gerekiyorsa dispatch durur. Hata sonrası retry yeni `AttemptId` üretir; önceki kanıt korunur.

## Provider adapter sözleşmesi

Adapter `discoverCapabilities`, `prepareRequest`, `stream`, `cancel`, `usage`, `health` gibi dar işlemler sağlar. Desteklenmeyen özellik `unsupported` döner; sahte sessiz emülasyon yapmaz. Model adı ve provider adı farklı kimliklerdir. API key veya resmi OAuth akışı dışındaki erişim yöntemleri varsayılmaz. Her request log'a gerçek provider/model route'u ve ölçüm kaynağını kaydeder.
