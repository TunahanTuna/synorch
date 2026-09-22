# Harness terminolojisi

> Durum: normatif sözlük; 2026-09-22. Kod kimlikleri `src/harness/contracts/` altındadır. Bütün tasarım, sözleşme ve ADR belgeleri bu sözcükleri bu anlamda kullanır. Kararlar: [ADR dizini](../decisions/README.md).

## Yürütme hiyerarşisi

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Session (oturum) | Bir çalışma kökü için tek yazıcılı, append-only olay günlüğü; resume ile devam eder, fork ile dallanır. | `SessionId` (`ids.ts`), `SessionManifest` (`store.ts`) | Run: bir oturumda birden çok run olabilir. |
| Run | Tek kullanıcı hedefi için profil, policy modu ve bütçeyle açılan yürütme. | `RunId` (`ids.ts`), `RunState` (`state.ts`) | Session; Plan. |
| Turn | Bir tetikleyiciyle (kullanıcı mesajı, dispatch, steer) başlayıp döngü duruncaya kadar süren bir veya daha çok step. | `TurnId`, `turn/started` (`events.ts`) | Step. |
| Step | Bir model isteği ve onun istediği tool çağrıları. | `StepId`, `StepState` | Turn; Attempt. |
| Plan | Hedef, kapsam, görev DAG'ı, risk, doğrulama ve bütçeyi taşıyan sürümlü, digest'li kayıt. | `PlanId`, `planSchema` (`packets.ts`), `PlanState` | Task packet. |
| Task | Plan içindeki tek rol ve sahiplikli iş birimi. | `TaskId`, `TaskState`, `planTaskSchema` | Attempt: task'ın her denemesi. |
| Attempt | Bir task'ın belirli worker/model/izolasyonla tek yürütmesi; retry yeni attempt üretir, eskisi silinmez. | `AttemptId`, `AttemptState` | Step; Task. |
| Tool call | Modelin istediği tek araç eylemi; gateway hattından geçer ve olaylarla eşleşir. | `ToolCallId`, `ToolCallState`, `toolCallRequestSchema` (`tools.ts`) | `provider_call_id`: provider'ın kendi çağrı kimliği. |
| Request | Provider'a giden tek model isteği; envelope'u kaydedilir. | `RequestId`, `modelRequestSchema` (`model.ts`) | Step (bir step bir request taşır). |

## Yetki ve güvenlik

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Approval (onay) | Belirli bir subject digest'i için verilmiş karar kaydı. | `ApprovalId`, `approvalRequestSchema`, `approvalDecisionSchema` (`policy.ts`) | Policy; Grant. |
| Grant | İzin veren bir approval kararı (`allowed-once`, `allowed-for-scope`); yalnız eşleşen digest'e uygulanır. | `ALLOWING_OUTCOMES` | Kalıcı izin preset'i. |
| Effective policy | Katmanların kesişimiyle hesaplanan etkin yetki: platform ∩ user ∩ workspace ∩ role ∩ task ∩ sandbox ∩ approval. | `effectivePolicySchema`, `PolicyEngine` | Rol tanımı tek başına. |
| Hard rail | Hiçbir mod, grant veya konfigürasyonla gevşetilemeyen ret kuralı. | `HARD_RAILS` | Onay sorusu. |
| Policy mode | `autonomous` (varsayılan; eylem başına prompt yok) veya `ask` (açık sıkı mod). | `POLICY_MODES`, `DEFAULT_POLICY_MODE` | Sandbox seviyesi. |
| Sandbox enforcement | OS'in uygulayabildiği koruma seviyesi: `full`, `partial`, `unavailable`. | `SANDBOX_ENFORCEMENT`, `sandboxReportSchema` (`tools.ts`) | Policy kararı. |
| Isolation mode | Attempt'in çalışma alanı: `worktree`, `scoped-dir`, `shared-read-only`. | `IsolationProvider` (`runtime.ts`), packet `isolation` | Sandbox. |
| Normalized action | Policy'nin değerlendirdiği, kanonikleştirilmiş eylem; digest'i onayın bağlandığı şeydir. | `normalizedActionSchema` | Ham tool argümanları. |
| Tool effect | Aracın etki sınıfı: `read`, `workspace-write`, `exec`, `external-write`, `control`. | `TOOL_EFFECTS` | Risk sınıfı. |
| Risk class | Görev risk sınıfı: `trivial`, `standard`, `high-risk`. | `RISK_CLASSES` (`common.ts`) | Tool effect. |

## Kanıt ve paketler

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Blob | İçerik adresli, digest'le doğrulanan büyük veri (tool çıktısı, envelope, packet). | `BlobRef` (`common.ts`), `BlobStore` (`store.ts`) | Artifact. |
| Artifact | Görevin ürettiği sabitlenmiş sonuç (ör. diff); digest'iyle review'a verilir. | `artifact_digest`, `reviewed_artifact_digest` (`packets.ts`) | Blob (artifact bir blob'da saklanabilir). |
| Evidence (kanıt) | Log'un çözebildiği kanıt işaretçisi; serbest metin değildir. | `evidenceRefSchema` (`common.ts`) | Compaction özeti. |
| Task Context Packet (full) | Worker'ın sürümlü, kaynaklı, kapsamlı girdisi (v2). | `taskContextPacketSchema` | Ebeveyn transkripti. |
| Delta packet | Aynı task'a ek ölçüt/kanıt/bilgi; kapsamı veya yetkiyi değiştiremez. | `deltaTaskPacketSchema` | Yeni full packet. |
| Completion packet | Worker'ın sonuç, değişen yollar ve ölçüt bazında kanıt raporu. | `completionPacketSchema` | Nihai kabul. |
| Review packet | Reviewer'ın bağımsız kanıtla ölçüt kararları ve `accept/revise/block` önerisi. | `reviewPacketSchema` | Completion packet. |
| Digest | `sha256:<64 hex>`; plan, packet, eylem ve envelope'u bağlar. | `digestSchema`, `digestOf` (`digest.ts`) | Kısaltılmış statik ledger digest'i. |

## Sağlayıcı ve model

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Provider | Servis veya yerel endpoint (`openai`, `anthropic`). | `ProviderId` (`ids.ts`) | Model. |
| Model | Provider'ın gerçek model kimliği, aynen. | `ModelId` | Tier. |
| Tier | Mantıksal kabiliyet katmanı: `orchestrator`, `complex_worker`, `fast_worker`. | `modelTierSchema` (`common.ts`) | Model adı. |
| Route | Tier'ın çözüldüğü provider + model + adapter + auth yöntemi + profil. | `modelRouteSchema`, `routeDecisionSchema` (`model.ts`) | Tercih edilen profil. |
| ModelAdapter | Döngü Synorch'ta; tek istek → tek stream. | `ModelAdapter` | AgentBackendAdapter. |
| AgentBackendAdapter | Döngü kullanıcının resmi istemcisinde; araçlar köprüyle Synorch gateway'ine yönlenir. | `AgentBackendAdapter`, `ToolBridge` | CLI komutunu shell tool ile çalıştırmak. |
| Auth method | `oauth-subscription` (Synorch'un kendi OAuth'u), `cli-bridge` (resmi istemcinin kendi girişi), `api-key`. | `AUTH_METHODS` (`auth.ts`) | Billing türü. |
| Profile | Aynı provider+yöntem için adlandırılmış kimlik (`default`, `work`). | `profileNameSchema`, `credentialRefSchema` | Model profili. |
| Credential store | Synorch'un sahip olduğu secret'ları saklayan soyutlama; önce OS keychain, sonra `0600` dosya. | `CredentialStore` | Başka uygulamaların token dosyaları (yasak). |

## Oturum mekaniği

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Event envelope | Log'daki tek satır: kimlik, `seq`, sürüm, aktör, payload. | `sessionEventSchema` (`events.ts`) | JSONL frame. |
| Segment | Header satırıyla başlayan, en fazla 8 MiB'lık JSONL dosyası. | `segmentHeaderSchema`, `SEGMENT_MAX_BYTES` | Session. |
| Lease | Oturumun tek yazıcısını belirleyen süreli kilit (TTL 30 s). | `sessionLeaseSchema`, `LEASE_TTL_MS` | Refresh kilidi. |
| Projection | Log'dan hesaplanan görünüm (görev tablosu, sohbet geçmişi). | — (I1) | Kaynak veri. |
| Replay | Log ve blob'lardan state'in ve model girdisinin yeniden kurulması. | `parseSessionEvent` | Resume. |
| Compaction | Eski geçmişin özetle değiştirilmesi; orijinaller silinmez, özet kanıt değildir. | `context/compacted` | Kesme (truncation). |

## Hafıza

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Memory note | Frontmatter'lı Markdown bilgi notu (decision, evidence, concept …). | `memoryNoteFrontmatterSchema`, `MemoryId` (`memory.ts`) | Olay günlüğü. |
| Memory proposal | Review kuyruğundaki önerilmiş not, ilişki, çelişki veya durum değişikliği. | `memoryProposalSchema`, `ProposalId` | Kabul edilmiş not. |
| Review queue | Review gerektiren önerilerin bekleme listesi; orchestrator otonom modda audit'li kabul edebilir. | `REVIEW_REQUIRED_KINDS`, `memory/proposal_decided` | Approval kuyruğu. |

## Arayüz

| Terim | Tanım | Kod kimliği | Karıştırılmamalı |
| --- | --- | --- | --- |
| Renderer kind | `tui` (pi-tui), `plain` (yalnız append), `jsonl` (makine). | `RENDERER_KINDS`, `selectRendererKind` (`renderer.ts`) | Policy modu. |
| Frame | Makine modunda stdout'a yazılan tek JSONL satırı (`hello`, `event`, `delta`, `result`, `error`). | `jsonlFrameSchema` (`jsonl.ts`) | Event envelope (frame onu taşıyabilir). |
| Exit code | Process çıkış kodu; harness hata kodundan tam eşlemeyle türetilir. | `EXIT_CODES`, `exitCodeFor` (`errors.ts`) | Tool `exit_code`. |
