# Kimlikler ve durum makineleri

> Durum: `accepted`, 2026-09-22. Sahip modül: `src/harness/contracts/ids.ts`, `src/harness/contracts/state.ts`. Kararlar: [ADR-02](../decisions/ADR-02-agent-loop-seams.md), [ADR-03](../decisions/ADR-03-session-store.md).

## 1. Kimlik tipleri

Her runtime kimliği `<önek>_<ULID>` biçimindedir (ULID: 26 karakter Crockford base32, `[0-9A-HJKMNP-TV-Z]`). Zod `brand` sayesinde tipler birbirinin yerine geçemez: `TaskId` bekleyen yere `AttemptId` verilemez (derleme hatası). ULID zaman sıralıdır ama **bir session içindeki tek sıra `seq`'tir**; saat ve kimlik sıralama kaynağı değildir.

| Tip | Önek | Şema | Anlam |
| --- | --- | --- | --- |
| `RunId` | `run_` | `runIdSchema` | Bir kullanıcı hedefi, profil ve bütçe |
| `SessionId` | `ses_` | `sessionIdSchema` | Tek yazıcılı event log |
| `PlanId` | `plan_` | `planIdSchema` | Plan (sürümleri `version` ile) |
| `TaskId` | `task_` | `taskIdSchema` | DAG düğümü |
| `AttemptId` | `att_` | `attemptIdSchema` | Bir task'ın bir worker çalıştırması |
| `TurnId` | `turn_` | `turnIdSchema` | Bir kullanıcı/orchestrator girdisinin işlenmesi |
| `StepId` | `step_` | `stepIdSchema` | Bir model isteği + istediği tool çağrıları |
| `RequestId` | `req_` | `requestIdSchema` | Tek model isteği |
| `ToolCallId` | `call_` | `toolCallIdSchema` | Runtime tool çağrısı (provider call id ayrı alan) |
| `ApprovalId` | `apr_` | `approvalIdSchema` | Onay isteği/kararı |
| `EventId` | `evt_` | `eventIdSchema` | Tek event |
| `ProposalId` | `prop_` | `proposalIdSchema` | Hafıza inceleme kuyruğu öğesi |

Diğer kimlikler:

- `ProviderId`: kebab-case servis adı (`openai`, `anthropic`). Model değildir.
- `ModelId`: sağlayıcının gerçek model kimliği, boşluksuz, olduğu gibi saklanır.
- `ProjectId`: `<basename-slug>-<8 hex>`; hex, çözülmüş çalışma kökünün `sha256`'sının ilk 8 karakteridir. Windows'ta kök önce küçük harfe çevrilir (`deriveProjectId`). Kişisel depolama köklerini (`~/.synorch/sessions/<project-id>`, `~/.synorch/memory/<project-id>`) adlandırır.
- `MemoryId`: `<tür-öneki>-<slug>` (`dec-0042`); bkz. [memory.md](./memory.md).
- Kabul ölçütü: `AC-<n>`; review bulgusu: `F-<n>`. Yalnızca kendi paketi içinde benzersizdir.

Kimlik üretimi `createId(kind)` ile yapılır; `encodeUlid(timeMs, random10)` saf yardımcıdır ve testte deterministik kullanılabilir. Provider'ın döndürdüğü çağrı kimliği (`provider_call_id`) hiçbir zaman `ToolCallId` yerine kullanılmaz.

## 2. Durum makineleri

Tablolar `TRANSITIONS` sabitinin birebir karşılığıdır. `validateTransition(machine, from, to)` saf fonksiyonu `{ ok: true }` veya `unknown-state | terminal-state | illegal-transition` döner. Projection, log'da tabloda olmayan bir geçiş görürse tahmin yürütmez; `session_corrupt` raporlar. Her geçiş `*_state_changed` olayıyla (`from`, `to`, `reason`, actor) kaydedilir.

### Run

| Durum | İzinli sonraki |
| --- | --- |
| `created` | `running`, `cancelled`, `failed` |
| `running` | `waiting_for_approval`, `interrupted`, `completed`, `failed`, `cancelled` |
| `waiting_for_approval` | `running`, `interrupted`, `failed`, `cancelled` |
| `interrupted` | `running` (resume), `failed`, `cancelled` |
| `completed`, `failed`, `cancelled` | — (terminal) |

### Plan

`draft → proposed → approved | rejected`; `draft|proposed → superseded`; `approved → superseded | invalidated`. Kapsam, risk veya etkili yetki genişlerse onaylı plan `invalidated` olur ve yeni sürüm gerekir. `autonomous` modda `proposed → approved` geçişini orchestrator yapar ve `approval/decided` (`decided_by: orchestrator`) ile denetlenir ([policy-and-approval.md](./policy-and-approval.md)).

### Task

| Durum | İzinli sonraki |
| --- | --- |
| `draft` | `awaiting_approval`, `ready`, `cancelled` |
| `awaiting_approval` | `ready`, `cancelled` |
| `ready` | `running`, `blocked`, `cancelled` |
| `running` | `needs_context`, `blocked`, `interrupted`, `failed`, `verifying`, `cancelled` |
| `needs_context` | `running`, `ready`, `cancelled` |
| `blocked` | `ready`, `cancelled` |
| `interrupted` | `ready`, `failed`, `cancelled` |
| `failed` | `retry_pending`, `cancelled` |
| `retry_pending` | `ready`, `cancelled` |
| `verifying` | `reviewing`, `completed`, `failed`, `cancelled` |
| `reviewing` | `changes_requested`, `completed`, `failed`, `cancelled` |
| `changes_requested` | `ready`, `cancelled` |
| `completed`, `cancelled` | — (terminal) |

`running → completed` **yoktur**: her task doğrulamadan geçer. `verifying → completed` yalnız `trivial` risk için orchestration tarafından kullanılır; `standard` ve `high-risk` görevler `reviewing` üzerinden kapanır ([ADR-09](../decisions/ADR-09-reviewer-independence.md)). `failed` terminal değildir; retry yeni `AttemptId` ile olur, eski attempt ve kanıtı silinmez.

### Attempt

`queued → running | cancelled`; `running → waiting_for_approval | succeeded | failed | cancelled | interrupted`; `waiting_for_approval → running | failed | cancelled | interrupted`. `succeeded`, `failed`, `cancelled`, `interrupted` terminaldir.

### Tool call

`proposed → awaiting_approval | executing | denied | cancelled`; `awaiting_approval → executing | denied | cancelled | interrupted`; `executing → succeeded | failed | cancelled | interrupted`. Terminal: `denied`, `succeeded`, `failed`, `cancelled`, `interrupted`. `executing` halindeyken çöken çağrı `interrupted` + `outcome: unknown` olur ve **otomatik tekrar edilmez** ([tools.md](./tools.md)).

### Approval

`pending → allowed | rejected | cancelled | unavailable | expired`; `allowed → invalidated | expired`.

### Step

`open → settled | aborted | errored`. İptal veya provider hatası hiçbir zaman `settled` sayılmaz.

## 3. Crash recovery eşlemesi

Resume sırasında log sonundaki açık varlıklar `RECOVERY_STATE` ile kapatılır ve `session/resumed.recovered` listesine yazılır:

| Makine | Açık durum → recovery |
| --- | --- |
| run | → `interrupted` |
| task | `running` → `interrupted` |
| attempt | → `interrupted` |
| toolCall | `executing`/`awaiting_approval` → `interrupted` |
| approval | `pending` → `cancelled` |
| step | `open` → `aborted` |

Kullanıcıya "devam", "yeniden dene", "iptal" seçenekleri sunulur; yan etkili bir çağrının sonucu bilinmiyorsa (`tool/interrupted`) yeniden deneme ayrı bir karar ve yeni `ToolCallId` gerektirir.

## 4. Örnekler

Geçerli geçişler:

```yaml example=transition
- { machine: run, from: created, to: running }
- { machine: run, from: interrupted, to: running }
- { machine: plan, from: proposed, to: approved }
- { machine: task, from: running, to: verifying }
- { machine: task, from: verifying, to: reviewing }
- { machine: task, from: reviewing, to: changes_requested }
- { machine: task, from: failed, to: retry_pending }
- { machine: attempt, from: running, to: interrupted }
- { machine: toolCall, from: executing, to: interrupted }
- { machine: approval, from: allowed, to: invalidated }
- { machine: step, from: open, to: aborted }
```

Reddedilmesi gereken geçişler (review atlama, terminalden çıkış, bilinmeyen durum):

```yaml example=transition invalid
- { machine: task, from: running, to: completed }
- { machine: task, from: completed, to: running }
- { machine: attempt, from: failed, to: running }
- { machine: toolCall, from: denied, to: executing }
- { machine: plan, from: rejected, to: approved }
- { machine: run, from: running, to: paused }
- { machine: approval, from: rejected, to: allowed }
```
