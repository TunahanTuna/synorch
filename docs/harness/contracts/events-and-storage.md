# Event envelope ve oturum depolama

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/events.ts`, `store.ts`, `digest.ts`; uygulama: `src/harness/store/` (I1). Karar: [ADR-03](../decisions/ADR-03-session-store.md).

## 1. Temel ilkeler

1. Session'ın kalıcı aslı tipli, sıralı, append-only event log'dur. Sohbet geçmişi, task tablosu, UI ve `syn show` bu log'un **projection**'ıdır.
2. Eski olay değiştirilmez veya silinmez; düzeltme yeni olaydır.
3. `seq` session içinde 1'den başlar, boşluksuz ve kesin artandır. Sıralama kaynağı saat değil `seq`'tir.
4. `EventStore.append` satır diske `fsync` ile yazıldıktan sonra resolve olur. Append reddedilirse çağıran hiçbir yeni yan etkili tool çalıştırmaz ve UI "kaydedildi" demez.
5. Modelin gördüğü her girdi log + immutable blob'lardan yeniden kurulabilir (`model/request_prepared.envelope_blob`).
6. Secret'lar log'a/blob'a yazılmadan önce redakte edilir; redaksiyon sayısı ilgili sonuçta (`redactions`) izlenir.

## 2. Envelope

| Alan | Tip | Kural |
| --- | --- | --- |
| `schema_version` | `1` | Envelope biçimi |
| `event_id` | `EventId` | Benzersiz |
| `session_id` | `SessionId` | Segment header ile aynı |
| `seq` | int ≥ 1 | Yoğun, artan; store atar |
| `event_version` | int ≥ 1 | Payload sürümü, tip başına (`EVENT_VERSIONS`) |
| `timestamp` | ISO-8601, offset'li | Bilgi amaçlı; sıralama değil |
| `actor` | `{kind, role?, attempt_id?}` | `kind`: `user`, `orchestrator`, `worker`, `system`, `policy`, `provider` |
| `run_id`, `task_id`, `attempt_id` | opsiyonel | Korelasyon |
| `causation_seq` | opsiyonel int | Bu olayı tetikleyen olayın `seq`'i |
| `type` | string | Aşağıdaki katalogdan biri |
| `data` | nesne | Tipe özgü, strict (bilinmeyen alan reddedilir) |

Yazıcı `SessionEventDraft` verir (`schema_version`, `event_id`, `session_id`, `seq`, `timestamp` hariç); store bunları atar.

## 3. Event kataloğu

"Model" sütunu, olayın ContextBuilder tarafından model girdisine dönüştürülüp dönüştürülmediğini söyler.

| Tip | `data` alanları | Model | Üreten |
| --- | --- | --- | --- |
| `session/opened` | `writer`, `project_id`, `workspace_root`, `cwd`, `platform`, `git`, `policy_mode`, `parent?` | Hayır | store/cli |
| `session/resumed` | `previous_last_seq`, `recovered[]` | Hayır | core |
| `session/closed` | `reason` | Hayır | cli |
| `run/created` | `goal`, `policy_mode`, `headless`, `budget` | Hedef metni evet | orchestration |
| `run/state_changed` | `from`, `to`, `reason` | Hayır | orchestration |
| `policy/snapshot` | `policy` (EffectivePolicy), `digest` | Hayır | policy |
| `route/decided` | `decision` (RouteDecision) | Hayır | providers |
| `plan/proposed` | `plan`, `digest` | Seçilmiş projection | orchestration |
| `plan/state_changed` | `plan_id`, `digest`, `from`, `to`, `reason`, `approval_id?` | Hayır | orchestration |
| `approval/requested` | `request` | Hayır | policy |
| `approval/decided` | `decision` | Sonuç gerektiği kadar | policy |
| `approval/invalidated` | `approval_id`, `reason` | Hayır | policy |
| `task/created` | `task_id`, `plan_id`, `key`, `role`, `depends_on`, `owned_paths`, `risk` | Hayır | orchestration |
| `task/state_changed` | `task_id`, `from`, `to`, `reason` | Hayır | orchestration |
| `task/packet_issued` | `task_id`, `kind`, `packet_digest`, `blob` | Worker'a packet | orchestration |
| `attempt/started` | `attempt_id`, `task_id`, `role`, `route`, `packet_digest`, `isolation` | Hayır | orchestration |
| `attempt/state_changed` | `attempt_id`, `from`, `to`, `reason` | Hayır | orchestration |
| `attempt/completion_recorded` | `attempt_id`, `task_id`, `status`, `completion_digest`, `blob` | Orchestrator'a | orchestration |
| `review/recorded` | `task_id`, `reviewer_attempt_id`, `review_digest`, `decision`, `blob` | Orchestrator'a | orchestration |
| `turn/started`, `turn/ended` | `turn_id`, `trigger` / `outcome` | Hayır | core |
| `step/started`, `step/ended` | `step_id`, `turn_id`, `request_id` / `state` | Hayır | core |
| `message/recorded` | `role`, `request_id?`, `message` **veya** `blob` | **Evet** | core |
| `model/request_prepared` | `request_id`, `step_id`, `route`, `envelope_digest`, `envelope_blob`, `tool_set_digest`, `context[]` | Hayır | core/context |
| `model/response_settled` | `request_id`, `stop_reason`, `usage?` | Hayır | core |
| `model/response_failed` | `request_id`, `error`, `partial_blob?` | Gerekli hata | core |
| `provider/usage` | `request_id`, `usage`, `quota?` | Hayır | core |
| `tool/call_proposed` | `tool_call_id`, `request_id?`, `provider_call_id`, `tool_name`, `args_digest`, `args_blob?` | Call evet | tools |
| `tool/policy_decided` | `tool_call_id`, `action`, `decision` | Hayır | tools/policy |
| `tool/execution_started` | `tool_call_id`, `sandbox_enforcement` | Hayır | tools |
| `tool/result_recorded` | `tool_call_id`, `state`, `result`, `duration_ms` | Result evet | tools |
| `tool/interrupted` | `tool_call_id`, `outcome: unknown`, `idempotent` | Bildirim | core (recovery) |
| `context/compacted` | `from_seq`, `to_seq`, `first_kept_seq`, `method`, `summary_blob`, `trigger`, token sayıları | Özet evet | context |
| `context/source_changed` | `task_id?`, `path`, `expected`, `actual` | Bildirim | context |
| `memory/persisted` | `memory_id`, `kind`, `path`, `digest` | Hayır | memory |
| `memory/proposed` | `proposal_id`, `kind`, `target?` | Hayır | memory |
| `memory/proposal_decided` | `proposal_id`, `state`, `decided_by`, `reason` | Hayır | memory |
| `budget/exceeded` | `scope`, `metric`, `limit`, `used`, `action` | Hayır | orchestration |
| `steer/queued` | `text` | Sonraki step'te | core |

Eşleşme invariant'ları: her `tool/call_proposed` bir `tool/result_recorded` veya `tool/interrupted` ile; her `approval/requested` bir `approval/decided` ile; her `step/started` bir `step/ended` ile kapanır. Kapanmamış olanlar recovery'de [identity-and-state.md](./identity-and-state.md#3-crash-recovery-eşlemesi) tablosuyla kapatılır. Kayıtlı assistant mesajındaki her `tool_call` parçası runtime `tool_call_id` taşır.

## 4. Okuma, sürüm ve migration

`parseSessionEvent(raw)` üç sonuç verir: `ok`, `unsupported` (bilinmeyen `type` veya bilinen tipte daha yüksek `event_version`), `invalid` (bilinen tip şemaya uymuyor = bozulma). `unsupported` sessizce atlanmaz; projection "bu session daha yeni bir sürümle yazılmış" hatası verir ve yazma için açmaz. Payload değişikliği: alan eklemek bile `event_version` artırır; okuyucu eski sürümleri desteklemeye devam eder; eski log hiçbir zaman yeniden yazılmaz.

## 5. Disk yerleşimi

Kök `~/.synorch/` (veya `$SYNORCH_HOME`):

```text
sessions/<project-id>/<session-id>/
  session.json            SessionManifest (oluşturmada bir kez yazılır)
  lock.json               SessionLease (tek yazıcı)
  segments/000001.jsonl   1. satır SegmentHeader, sonra envelope satırları
blobs/sha256/<ilk 2 hex>/<kalan 62 hex>
worktrees/<project-id>/<attempt-id>/   (ADR-07)
```

- Satır = `JSON.stringify(envelope) + "\n"`; yalnız LF. UTF-8, BOM yok.
- Segment `SEGMENT_MAX_BYTES` (8 MiB) aşınca yeni segment açılır; yeni header `first_seq` taşır. Bir event iki segmente bölünmez.
- `INLINE_PAYLOAD_MAX_BYTES` (16 KiB) üzerindeki mesaj/tool çıktısı/packet/envelope blob'a yazılır; event `BlobRef` (`digest`, `size_bytes`, `media_type`) taşır. Blob içerik adreslidir; okumada digest doğrulanır (`blob_digest_mismatch`).
- **Yarım son satır (torn tail):** son segmentin sonunda `\n` ile bitmeyen veya parse edilemeyen tek satır `torn-tail` olarak raporlanır; yazma için açılırken bu bayt aralığı `<segment>.torn-<n>` dosyasına taşınır ve olay olarak `session/resumed` içinde bildirilir. Ortadaki bozuk satır `session_corrupt`'tır; otomatik onarılmaz.
- Fork: yeni session `parent: {session_id, up_to_seq}` taşır; ataya ait olaylar kopyalanmaz, okuma sırasında atadan `up_to_seq`'e kadar okunur.

## 6. Tek yazıcı ve lease

`openForWrite` `lock.json`'u atomik oluşturur (`O_EXCL`; varsa okur). Lease `LEASE_TTL_MS` (30 s) geçerlidir, yazıcı her `LEASE_HEARTBEAT_MS` (10 s) yeniler. Süresi dolmamış lease varsa `session_locked` (exit 8) döner ve sahibi (`pid`, `host`) gösterilir; süresi dolmuşsa lease devralınır ve `session/resumed` yazılır. `token` her açılışta rastgeledir; heartbeat token eşleşmezse yazıcı hemen durur (başka process devraldı).

## 7. Digest

`digestOf(value)` = `sha256(canonicalJson(value))`. Canonical JSON: anahtarlar code point sırasıyla, `undefined` üyeler atılır, sonlu olmayan sayı/bigint reddedilir. Metin kaynakları `digestText` ile satır sonları `\n`'e normalize edilerek özetlenir (statik observation ledger ile aynı kural). Runtime digest'i her zaman 64 hex'tir; kısaltılmış digest kabul edilmez.

## 8. Örnekler

```yaml example=session-event
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TA
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 1
  event_version: 1
  timestamp: "2026-09-22T10:00:00.000Z"
  actor: { kind: system }
  type: session/opened
  data:
    writer: { name: synorch, version: "0.4.0" }
    project_id: synorch-1a2b3c4d
    workspace_root: /home/dev/synorch
    cwd: /home/dev/synorch
    platform: linux
    git: { branch: harness, head: 62f0b12 }
    policy_mode: autonomous
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TB
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 2
  event_version: 1
  timestamp: "2026-09-22T10:00:01.000Z"
  actor: { kind: user }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  type: run/created
  data:
    goal: Fix refresh token rotation race
    policy_mode: autonomous
    headless: false
    budget: { max_wall_time_seconds: 3600, max_cost_usd: 5 }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TC
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 14
  event_version: 1
  timestamp: "2026-09-22T10:02:10.000Z"
  actor: { kind: worker, role: implementer, attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8 }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  causation_seq: 13
  type: message/recorded
  data:
    role: assistant
    request_id: req_01K5T3Q8Z4X9V2M6N7P0R1S2TD
    message:
      role: assistant
      content:
        - { type: text, text: "Running the auth tests." }
        - type: tool_call
          provider_call_id: toolu_01
          tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE
          name: exec
          arguments: { argv: [pnpm, test, auth] }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TK
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 16
  event_version: 1
  timestamp: "2026-09-22T10:02:11.000Z"
  actor: { kind: policy }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  type: tool/policy_decided
  data:
    tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE
    action:
      tool_name: exec
      tool_version: "1.0.0"
      effect: exec
      role: implementer
      task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
      args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      paths: []
      command: { argv: [pnpm, test, auth], cwd: "." }
      network_hosts: []
      destructive: false
    decision:
      decision: allow
      action_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      reasons: [{ code: exec-in-worktree, layer: task, message: "exec allowed inside the attempt worktree" }]
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TM
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 18
  event_version: 1
  timestamp: "2026-09-22T10:02:30.000Z"
  actor: { kind: system }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  type: tool/result_recorded
  data:
    tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE
    state: succeeded
    duration_ms: 18234
    result:
      status: ok
      text: "42 tests passed"
      truncated: true
      exit_code: 0
      redactions: 0
      blob: { digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", size_bytes: 48213, media_type: text/plain }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TN
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 12
  event_version: 1
  timestamp: "2026-09-22T10:02:05.000Z"
  actor: { kind: system }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  type: model/request_prepared
  data:
    request_id: req_01K5T3Q8Z4X9V2M6N7P0R1S2TD
    step_id: step_01K5T3Q8Z4X9V2M6N7P0R1S2TH
    route:
      provider_id: openai
      model_id: gpt-5.6-sol
      adapter_id: openai-chatgpt
      adapter_kind: model
      auth_method: oauth-subscription
      profile: default
      tier: complex_worker
    envelope_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    envelope_blob: { digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", size_bytes: 20411, media_type: application/json }
    tool_set_digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    context:
      - { block_id: constitution, source: constitution, trust: harness, tokens_estimate: 410, truncated: false }
      - { block_id: packet, source: packet, trust: harness, tokens_estimate: 1250, truncated: false }
      - { block_id: history, source: history, trust: untrusted, tokens_estimate: 8800, truncated: false }
```

Reddedilmesi gerekenler: `seq: 0`, runtime kimliği olmayan kayıtlı tool call, strict payload'a fazladan alan (yetki alanı sızdırma denemesi):

```yaml example=session-event invalid
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TP
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 0
  event_version: 1
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: system }
  type: session/closed
  data: { reason: user }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TQ
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 3
  event_version: 1
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: worker, role: implementer }
  type: message/recorded
  data:
    role: assistant
    message:
      role: assistant
      content:
        - { type: tool_call, provider_call_id: toolu_02, name: exec, arguments: {} }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TR
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 4
  event_version: 1
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: worker, role: explorer }
  type: task/state_changed
  data:
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    from: running
    to: verifying
    reason: done
    grant_write: true
```

Okuyucunun `unsupported` raporlaması gerekenler (bilinmeyen tip, daha yeni payload sürümü):

```yaml example=session-event unsupported
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TS
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 5
  event_version: 1
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: system }
  type: worker/heartbeat
  data: {}
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TT
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 6
  event_version: 2
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: system }
  type: session/closed
  data: { reason: user, note: newer }
```

Depolama nesneleri:

```yaml example=session-manifest
schema_version: 1
session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
project_id: synorch-1a2b3c4d
workspace_root: /home/dev/synorch
created_at: "2026-09-22T10:00:00Z"
```

```yaml example=segment-header
kind: segment
schema_version: 1
session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
segment: 2
first_seq: 48211
created_at: "2026-09-22T12:00:00Z"
writer: { name: synorch, version: "0.4.0" }
```

```yaml example=session-lease
schema_version: 1
session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
holder: { pid: 48122, host: dev-laptop, token: 3f9a1c2e7b4d8f60a1b2 }
acquired_at: "2026-09-22T10:00:00Z"
heartbeat_at: "2026-09-22T10:00:20Z"
expires_at: "2026-09-22T10:00:50Z"
```
