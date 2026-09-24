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
| `session/opened` (v2) | `writer`, `project_id`, `workspace_root`, `cwd`, `platform`, `git`, `policy_mode`, `parent?`, `config_ignored?[{layer, path, key}]` (v2: repo katmanında yok sayılan yapılandırma anahtarları, SEC-C1) | Hayır | store/cli |
| `session/resumed` (v2) | `previous_last_seq`, `recovered[]`, `torn_tail?{segment, bytes}` (v2) | Hayır | core |
| `session/closed` | `reason` | Hayır | cli |
| `run/created` | `goal`, `policy_mode`, `headless`, `budget` | Hedef metni evet | orchestration |
| `run/state_changed` | `from`, `to`, `reason` | Hayır | orchestration |
| `policy/snapshot` (v3) | `policy` (EffectivePolicy; v2: `policy.exec_confinement?`, `policy.verification_commands?`; v3: `policy.workspace_trusted?`), `digest` | Hayır | policy |
| `route/decided` | `decision` (RouteDecision) | Hayır | providers |
| `plan/proposed` | `plan`, `digest` | Seçilmiş projection | orchestration |
| `plan/state_changed` | `plan_id`, `digest`, `from`, `to`, `reason`, `approval_id?` | Hayır | orchestration |
| `approval/requested` | `request` | Hayır | policy |
| `approval/decided` | `decision` | Sonuç gerektiği kadar | policy |
| `approval/invalidated` | `approval_id`, `reason` | Hayır | policy |
| `task/created` | `task_id`, `plan_id`, `key`, `role`, `depends_on`, `owned_paths`, `risk` | Hayır | orchestration |
| `task/state_changed` | `task_id`, `from`, `to`, `reason` | Hayır | orchestration |
| `task/packet_issued` | `task_id`, `kind`, `packet_digest`, `blob` | Worker'a packet | orchestration |
| `attempt/started` (v3) | `attempt_id`, `task_id`, `role`, `route`, `packet_digest`, `isolation`, `session_id?` (v2: attempt'in kendi session'ı); v3 (ADR-19): `isolation.reused?`, `isolation.fallback?{from: worktree, reason, detail}`, `isolation.overlaid?[]`, `isolation.dependency_links?[]`, `isolation.submodules?[]` | Hayır | orchestration |
| `attempt/verification_ran` | `attempt_id`, `task_id`, `ordinal`, `command`, `argv?`, `status` (`passed`\|`failed`\|`not-run`), `termination?`, `exit_code`, `duration_ms`, `output_excerpt` (≤ 4 KiB, redakte), `output_blob?`, `artifact_digest?`, `reason?` — harness'in koştuğu doğrulama komutu (ADR-18) | Onarım turunda sorun olarak | orchestration |
| `attempt/repair_requested` | `attempt_id`, `task_id`, `kind` (`evidence-repair`\|`verification-repair`), `round` (≤ `budget`), `budget`, `problems[]` — aynı attempt session'ının session içi onarımı (ADR-18) | Sorunlar evet (onarım mesajı) | orchestration |
| `attempt/state_changed` | `attempt_id`, `from`, `to`, `reason` | Hayır | orchestration |
| `task/integrated` | `task_id`, `attempt_id`, `artifact_digest`, `paths[]` | Hayır | orchestration |
| `attempt/completion_recorded` | `attempt_id`, `task_id`, `status`, `completion_digest`, `blob` | Orchestrator'a | orchestration |
| `review/recorded` | `task_id`, `reviewer_attempt_id`, `review_digest`, `decision`, `blob` | Orchestrator'a | orchestration |
| `turn/started`, `turn/ended` | `turn_id`, `trigger` / `outcome` | Hayır | core |
| `step/started`, `step/ended` | `step_id`, `turn_id`, `request_id` / `state` | Hayır | core |
| `message/recorded` | `role`, `request_id?`, `message` **veya** `blob` | **Evet** | core |
| `model/request_prepared` | `request_id`, `step_id`, `route`, `envelope_digest`, `envelope_blob`, `tool_set_digest`, `context[]` | Hayır | core/context |
| `model/response_settled` | `request_id`, `stop_reason`, `usage?` | Hayır | core |
| `model/response_failed` | `request_id`, `error`, `partial_blob?` | Gerekli hata | core |
| `provider/usage` | `request_id`, `usage`, `quota?` | Hayır | core |
| `tool/call_proposed` (v2) | `tool_call_id`, `request_id?`, `provider_call_id`, `tool_name`, `args_digest`, `args_blob?`, `ref?` (v2: attempt içi kısa ref sırası, `[#n]`, ADR-18) | Call evet | tools |
| `tool/policy_decided` (v2) | `tool_call_id`, `action` (v2: `action.escapes?`), `decision` | Hayır | tools/policy |
| `tool/execution_started` | `tool_call_id`, `sandbox_enforcement` | Hayır | tools |
| `tool/result_recorded` (v2) | `tool_call_id`, `state`, `result` (v2: `result.digest?`, ADR-19), `duration_ms` | Result evet (`[#n] …`) | tools |
| `tool/interrupted` | `tool_call_id`, `outcome: unknown`, `idempotent` | Bildirim | core (recovery) |
| `context/compacted` | `from_seq`, `to_seq`, `first_kept_seq`, `method`, `summary_blob`, `trigger`, token sayıları | Özet evet | context |
| `context/source_changed` | `task_id?`, `path`, `expected`, `actual` | Bildirim | context |
| `memory/persisted` | `memory_id`, `kind`, `path`, `digest` | Hayır | memory |
| `memory/proposed` | `proposal_id`, `kind`, `target?` | Hayır | memory |
| `memory/proposal_decided` | `proposal_id`, `state`, `decided_by`, `reason` | Hayır | memory |
| `budget/exceeded` | `scope`, `metric`, `limit`, `used`, `action` | Hayır | orchestration |
| `steer/queued` | `text` | Sonraki step'te | core |
| `trust/granted` | `workspace_root` (kanonik kök), `repo_identity` (`git:`/`dir:` + 64 hex), `source` (`prompt`\|`command`) | Hayır | cli (`syn trust decisions` oturumu) |
| `trust/revoked` | `workspace_root`, `repo_identity` | Hayır | cli (`syn trust decisions` oturumu) |
| `trust/used` | `workspace_root`, `repo_identity`, `source` (`store`\|`flag`\|`session`), `sandbox_enforcement` | Hayır | orchestration (run günlüğü) |
| `checkpoint/recorded` | `turn_id?`, `tool_call_id`, `files[]` (`path`, `before`: blob ref \| null, `after`: digest \| null) | Hayır | cli (konuşma günlüğü, ADR-21 D6) |
| `checkpoint/restored` | `checkpoint_seq`, `restored[]`, `skipped[]` (`path`, `reason`) | Hayır | cli (konuşma günlüğü, `/undo`) |
| `command/allowed` | `workspace_root` (kanonik kök), `prefix` | Hayır | cli (konuşma günlüğü, `/allow`) |
| `task/delegated` | `task_id`, `attempt_id`, `key`, `role`, `provider_id`, `model_id`, `objective`, `attempt` (görevin 1 tabanlı attempt sırası, review'lar dahil) | Hayır | orchestration (run günlüğü, K1.7) |
| `task/user_message` | `task_id`, `attempt_id`, `text` | Hayır (worker'a `steer/queued` olarak gider; orchestrator'a sonraki danışma/triage'da) | orchestration (run günlüğü, K1.7) |
| `attempt/user_control` | `attempt_id`, `task_id`, `action` (`pause`\|`resume`\|`cancel`) | Hayır | orchestration (run günlüğü, K1.7) |

Eşleşme invariant'ları: her `tool/call_proposed` bir `tool/result_recorded` veya `tool/interrupted` ile; her `approval/requested` bir `approval/decided` ile; her `step/started` bir `step/ended` ile kapanır. Kapanmamış olanlar recovery'de [identity-and-state.md](./identity-and-state.md#3-crash-recovery-eşlemesi) tablosuyla kapatılır. Kayıtlı assistant mesajındaki her `tool_call` parçası runtime `tool_call_id` taşır.

## 4. Okuma, sürüm ve migration

`parseSessionEvent(raw)` üç sonuç verir: `ok`, `unsupported` (bilinmeyen `type` veya bilinen tipte daha yüksek `event_version`), `invalid` (bilinen tip şemaya uymuyor = bozulma). `unsupported` sessizce atlanmaz; projection "bu session daha yeni bir sürümle yazılmış" hatası verir ve yazma için açmaz. Payload değişikliği: alan eklemek bile `event_version` artırır; okuyucu eski sürümleri desteklemeye devam eder; eski log hiçbir zaman yeniden yazılmaz.

Sürümlü alanlar `EVENT_FIELD_VERSIONS` tablosundadır (tip → alan → alanı getiren sürüm); `EVENT_VERSIONS[type]` bu tablodaki en yüksek sürümdür ve yazıcılar her zaman onu damgalar. Yeni alanlar şemada opsiyoneldir, böylece eski sürüm olaylar aynı şemayla okunur; daha eski sürümle damgalanmış ama yeni alanı taşıyan olay `invalid`'dir (o sürüm yazamazdı). Dalga 2a: `session/resumed` v2 (`torn_tail`), `attempt/started` v2 (`session_id`), `tool/policy_decided` v2 (`action.escapes`); `task/integrated` yeni tip (v1) — onu tanımayan eski okuyucu `unsupported` raporlar. Güvenlik düzeltmesi: `session/opened` v2 (`config_ignored`). Exec kısıtı: `policy/snapshot` v2 (`policy.exec_confinement`, `policy.verification_commands`). Çalışma alanı güveni (SEC-N1): `policy/snapshot` v3 (`policy.workspace_trusted`); `trust/granted`, `trust/revoked`, `trust/used` yeni tipler (v1). Güven kararları (`syn trust`, etkileşimli tek seferlik soru) projenin `syn trust decisions` oturumuna, güvene dayanan run'ın `trust/used` olayı run günlüğüne yazılır. Canlı çalıştırma sağlamlaştırması (ADR-18/19): `tool/call_proposed` v2 (`ref`), `tool/result_recorded` v2 (`result.digest`), `attempt/started` v3 (`isolation.reused`, `isolation.fallback`, `isolation.overlaid`, `isolation.dependency_links`, `isolation.submodules`); `attempt/verification_ran` ve `attempt/repair_requested` yeni tipler (v1).

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

`digestOf(value)` = `sha256(canonicalJson(value))`. Canonical JSON: anahtarlar code point sırasıyla, `undefined` üyeler atılır, sonlu olmayan sayı/bigint reddedilir. Runtime digest'i her zaman 64 hex'tir; kısaltılmış digest kabul edilmez.

**Çalışma alanı dosyaları için tek şema (ADR-19):** `workspaceDigest(bytes)` = dosyanın bir çalışma alanı kökündeki ham baytlarının SHA-256'sı; kod çözme, EOL katlama, BOM ayıklama veya filtre yoktur. Modele görünen her dosya digest'i (paket `sources`/`known_facts` — `context.digest_scheme: workspace-raw-v1`, `read_file` başlığı ve `ToolResult.digest`, `write_file`/`apply_patch` önkoşulu, completion `changed_paths` before/after) bu şemayla ve modelin çalıştığı çalışma alanında hesaplanır; iki farklı ağacın digest'i birbiriyle hiç karşılaştırılmaz. Ağaçlar arası karşılaştırma (worktree ↔ ana ağaç: integrate çakışma tespiti) `ContentIdentity` ile yapılır: git'in izlediği dosyalar için `git hash-object --path=<p>` blob kimliği (o ağacın clean filtresi ve EOL dönüşümü uygulanmış), diğerleri için `workspaceDigest`; farklı şemalar asla eşit sayılmaz ve bu kimlik modele veya pakete yazılmaz. `digestText` (satır sonları `\n`'e normalize) yalnız statik observation ledger, hafıza `source_digest` ve ADR-19 öncesi paketler (`text-lf-v1`) içindir.

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

Dalga 2a sürümlü olaylar (v2 alanları ve yeni `task/integrated`):

```yaml example=session-event
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V1
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 49
  event_version: 2
  timestamp: "2026-09-22T11:00:00.000Z"
  actor: { kind: system }
  type: session/resumed
  data:
    previous_last_seq: 48
    recovered:
      - { machine: toolCall, id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE, from: executing, to: interrupted }
    torn_tail: { segment: 1, bytes: 37 }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V9
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T5
  seq: 1
  event_version: 2
  timestamp: "2026-09-23T09:00:00.000Z"
  actor: { kind: system }
  type: session/opened
  data:
    writer: { name: synorch, version: "0.4.0" }
    project_id: synorch-1a2b3c4d
    workspace_root: /home/dev/synorch
    cwd: /home/dev/synorch
    platform: linux
    git: null
    policy_mode: autonomous
    config_ignored:
      - { layer: project, path: /home/dev/synorch/.synorch/config.yaml, key: adapters }
      - { layer: project, path: /home/dev/synorch/.synorch/config.yaml, key: routes }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V2
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 11
  event_version: 2
  timestamp: "2026-09-22T10:02:00.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  type: attempt/started
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    role: implementer
    route: { provider_id: openai, model_id: gpt-5.6-sol, adapter_id: openai-chatgpt, adapter_kind: model, auth_method: oauth-subscription, profile: default, tier: complex_worker }
    packet_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    isolation: { mode: worktree, path: /home/dev/.synorch/worktrees/synorch-1a2b3c4d/att_01K5T3Q8Z4X9V2M6N7P0R1S2T8, base_commit: 62f0b12 }
    session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2V9
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V3
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 40
  event_version: 1
  timestamp: "2026-09-22T10:20:00.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  type: task/integrated
  data:
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    artifact_digest: "sha256:abababababababababababababababababababababababababababababababab"
    paths: [src/auth/refresh.ts, tests/auth/refresh.test.ts]
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V4
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 17
  event_version: 2
  timestamp: "2026-09-22T10:02:12.000Z"
  actor: { kind: policy }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  type: tool/policy_decided
  data:
    tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TF
    action:
      tool_name: write_file
      tool_version: "1.0.0"
      effect: workspace-write
      role: implementer
      task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
      args_digest: "sha256:acacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac"
      paths: []
      escapes: [{ requested: ../outside/secret.txt, access: write, reason: outside-workspace }]
      network_hosts: []
      destructive: false
    decision:
      decision: deny
      action_digest: "sha256:adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad"
      policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      reasons: [{ code: path-escape, layer: platform, message: "../outside/secret.txt cannot be expressed inside the workspace (outside-workspace)" }]
      rail: write-outside-scope
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V5
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T7
  seq: 2
  event_version: 1
  timestamp: "2026-09-23T09:00:00.000Z"
  actor: { kind: user }
  type: trust/granted
  data:
    workspace_root: /home/dev/synorch
    repo_identity: "git:5f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275"
    source: command
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V6
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 4
  event_version: 1
  timestamp: "2026-09-23T09:05:00.000Z"
  actor: { kind: system }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  type: trust/used
  data:
    workspace_root: /home/dev/synorch
    repo_identity: "git:5f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275"
    source: store
    sandbox_enforcement: partial
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V7
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T7
  seq: 3
  event_version: 1
  timestamp: "2026-09-24T09:00:00.000Z"
  actor: { kind: user }
  type: trust/revoked
  data:
    workspace_root: /home/dev/synorch
    repo_identity: "git:5f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275"
```

Canlı çalıştırma sağlamlaştırması olayları (ADR-18/19):

```yaml example=session-event
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W1
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 30
  event_version: 2
  timestamp: "2026-09-23T12:01:00.000Z"
  actor: { kind: worker, role: implementer, attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8 }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  type: tool/call_proposed
  data:
    tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE
    provider_call_id: fc_68d2a1
    tool_name: exec
    args_digest: "sha256:aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae"
    ref: 5
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W2
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 41
  event_version: 1
  timestamp: "2026-09-23T12:02:00.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  type: attempt/verification_ran
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    ordinal: 1
    command: node check.mjs
    argv: [node, check.mjs]
    status: passed
    termination: exited
    exit_code: 0
    duration_ms: 212
    output_excerpt: "ok\n"
    artifact_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W3
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 42
  event_version: 1
  timestamp: "2026-09-23T12:02:01.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  type: attempt/repair_requested
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    kind: evidence-repair
    round: 1
    budget: 2
    problems: ["AC-2: 'the tests pass' names no tool call, ref or path of this attempt"]
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W4
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 20
  event_version: 3
  timestamp: "2026-09-23T12:00:30.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  type: attempt/started
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    role: implementer
    route: { provider_id: openai, model_id: gpt-5.6-luna, adapter_id: openai-chatgpt, adapter_kind: model, auth_method: oauth-subscription, profile: default }
    packet_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666"
    isolation:
      mode: worktree
      path: /home/dev/.synorch/worktrees/syn-smoke-2fecb8f8/att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
      base_commit: 62f0b12
      reused: false
      overlaid: [check.mjs]
      dependency_links: [node_modules]
    session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T7
```

Reddedilmesi gerekenler: `seq: 0`, runtime kimliği olmayan kayıtlı tool call, strict payload'a fazladan alan (yetki alanı sızdırma denemesi), v2 alanı taşıyan v1 olay, sıfırdan farklı çıkışla `passed` doğrulama, bütçeyi aşan onarım turu:

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
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V5
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 5
  event_version: 1
  timestamp: "2026-09-22T10:00:00Z"
  actor: { kind: system }
  type: session/resumed
  data:
    previous_last_seq: 4
    recovered: []
    torn_tail: { segment: 1, bytes: 12 }
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2V8
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T7
  seq: 4
  event_version: 1
  timestamp: "2026-09-23T09:00:00.000Z"
  actor: { kind: user }
  type: trust/granted
  data:
    workspace_root: /home/dev/synorch
    repo_identity: "git:5f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275f2e2275"
    source: repository
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W5
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 30
  event_version: 1
  timestamp: "2026-09-23T12:01:00.000Z"
  actor: { kind: worker, role: implementer }
  type: tool/call_proposed
  data:
    tool_call_id: call_01K5T3Q8Z4X9V2M6N7P0R1S2TE
    provider_call_id: fc_68d2a1
    tool_name: exec
    args_digest: "sha256:aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae"
    ref: 5
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W6
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 41
  event_version: 1
  timestamp: "2026-09-23T12:02:00.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  type: attempt/verification_ran
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    ordinal: 1
    command: node check.mjs
    argv: [node, check.mjs]
    status: passed
    termination: exited
    exit_code: 1
    duration_ms: 212
    output_excerpt: "fail\n"
- schema_version: 1
  event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2W7
  session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
  seq: 43
  event_version: 1
  timestamp: "2026-09-23T12:02:02.000Z"
  actor: { kind: orchestrator, role: orchestrator }
  type: attempt/repair_requested
  data:
    attempt_id: att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
    task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
    kind: evidence-repair
    round: 3
    budget: 2
    problems: ["AC-2 still has no resolvable evidence"]
```

Son örnek: güveni yalnız kullanıcı verir (`prompt` veya `command`); depo içeriği bir güven kaynağı değildir (SEC-N1).

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

## Konuşma günlüğü (ADR-21, K0)

`syn agent` konuşması kendi oturumudur (manifest `title: "chat: <ilk mesaj>"`). Her kullanıcı mesajı bir **turdur** (`turn/started {trigger: user}` … `turn/ended`); konuşma turları hiçbir run'a ait değildir: zarfta `run_id` yoktur, korelasyon `turn_id` iledir. Ana ajanın olayları `actor: {kind: agent, role: session}` taşır (`ACTOR_KINDS += agent`, `AGENT_ROLES += session`). Konuşmada `plan/*`, `task/*`, `attempt/*`, `run/*` olayı yazılmaz; `/plan <hedef>` coordinator'ı ayrı run oturumunda çalıştırır ve konuşmaya yalnız özet olarak döner (K1'de gömülü pano).

- `checkpoint/recorded` (v1): başarılı her `apply_patch`/`write_file` çağrısından sonra, ön görüntü blob'u (`before`, dosya yoksa `null`) ve düzenlemenin bıraktığı `workspaceDigest` (`after`, silindiyse `null`). Git stash kullanılmaz.
- `checkpoint/restored` (v1): `/undo` son geri alınmamış checkpoint'i yalnız dosya hâlâ `after` digest'indeyse `before`'a döndürür; aksi halde `skipped` ile atlar. Exec yan etkileri kapsam dışıdır ve kullanıcıya söylenir.
- `command/allowed` (v1): kullanıcı `/allow <önek>` ile konuşma ajanının exec allowlist'ini bu çalışma alanı için genişletti; kalıcı kayıt kullanıcı kapsamında `<synorch home>/command-grants.json`'dadır ([policy ve onay §8](./policy-and-approval.md#8-konuşma-ajanı-session-adr-21)).
- JSONL `turn` frame'i ve `syn run` konuşma eşlemesi K1c'dedir; K0'da `syn run` çıktısı değişmez.

```yaml example=session-event
- schema_version: 1
  event_id: evt_01K5V0A8Z4X9V2M6N7P0R1S2A1
  session_id: ses_01K5V0A8Z4X9V2M6N7P0R1S2A0
  seq: 21
  event_version: 1
  timestamp: "2026-09-23T10:00:05.000Z"
  actor: { kind: agent, role: session }
  type: checkpoint/recorded
  data:
    turn_id: turn_01K5V0A8Z4X9V2M6N7P0R1S2A2
    tool_call_id: call_01K5V0A8Z4X9V2M6N7P0R1S2A3
    files:
      - path: src-add.mjs
        before: { digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111", size_bytes: 44, media_type: application/octet-stream }
        after: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
- schema_version: 1
  event_id: evt_01K5V0A8Z4X9V2M6N7P0R1S2A4
  session_id: ses_01K5V0A8Z4X9V2M6N7P0R1S2A0
  seq: 30
  event_version: 1
  timestamp: "2026-09-23T10:01:00.000Z"
  actor: { kind: user }
  type: checkpoint/restored
  data: { checkpoint_seq: 21, restored: [src-add.mjs], skipped: [] }
- schema_version: 1
  event_id: evt_01K5V0A8Z4X9V2M6N7P0R1S2A5
  session_id: ses_01K5V0A8Z4X9V2M6N7P0R1S2A0
  seq: 31
  event_version: 1
  timestamp: "2026-09-23T10:01:10.000Z"
  actor: { kind: user }
  type: command/allowed
  data: { workspace_root: /home/dev/syn-smoke, prefix: node check.mjs }
```

## Worker'lara girme (K1.7)

Coordinator, çalışan worker'lara giriş için run günlüğüne üç yeni tip yazar (hepsi v1):

- `task/delegated`: orchestrator bir görevi worker (veya reviewer) attempt'ine verdi. Ana sohbet bunu katlanabilir "→ worker'a gönderildi" satırı olarak gösterir (`key`, rol, model, hedef). `attempt` görevin 1 tabanlı attempt sırasıdır (retry, revizyon ve review attempt'leri dahil).
- `task/user_message`: kullanıcı çalışan bir worker'a doğrudan yazdı (`/worker <key> <mesaj>` veya worker görünümü). Metin o attempt'in sürücüsüne steer olarak verilir ve bir sonraki güvenli adım sınırında attempt günlüğüne `steer/queued` olarak düşer; orchestrator'ın bir sonraki danışma veya triage turunda "kullanıcı worker'lara doğrudan yazdı" bölümüyle görünür. Attempt bitmişse hiçbir şey yazılmaz, kullanıcıya açık bir hata döner.
- `attempt/user_control`: kullanıcı bir attempt'i duraklattı (`pause`: sürücü mevcut adımı bitirir, yenisini başlatmaz), sürdürdü (`resume`) veya iptal etti (`cancel`: mevcut iptal yolu; coordinator bunu diğer iptal edilmiş attempt'ler gibi ele alır ve ardından `attempt/state_changed … cancelled` gelir).

```yaml example=session-event
- schema_version: 1
  event_id: evt_01K5W0A8Z4X9V2M6N7P0R1S2B1
  session_id: ses_01K5W0A8Z4X9V2M6N7P0R1S2B0
  seq: 41
  event_version: 1
  timestamp: "2026-09-24T10:00:05.000Z"
  run_id: run_01K5W0A8Z4X9V2M6N7P0R1S2B2
  task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3
  attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4
  actor: { kind: orchestrator, role: orchestrator }
  type: task/delegated
  data:
    task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3
    attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4
    key: edit-a
    role: implementer
    provider_id: openai
    model_id: gpt-6-luna
    objective: Fix the typo in docs/a.md
    attempt: 1
- schema_version: 1
  event_id: evt_01K5W0A8Z4X9V2M6N7P0R1S2B5
  session_id: ses_01K5W0A8Z4X9V2M6N7P0R1S2B0
  seq: 52
  event_version: 1
  timestamp: "2026-09-24T10:00:40.000Z"
  run_id: run_01K5W0A8Z4X9V2M6N7P0R1S2B2
  task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3
  attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4
  actor: { kind: user }
  type: task/user_message
  data: { task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3, attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4, text: keep the heading unchanged }
- schema_version: 1
  event_id: evt_01K5W0A8Z4X9V2M6N7P0R1S2B6
  session_id: ses_01K5W0A8Z4X9V2M6N7P0R1S2B0
  seq: 53
  event_version: 1
  timestamp: "2026-09-24T10:00:45.000Z"
  run_id: run_01K5W0A8Z4X9V2M6N7P0R1S2B2
  task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3
  attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4
  actor: { kind: user }
  type: attempt/user_control
  data: { attempt_id: att_01K5W0A8Z4X9V2M6N7P0R1S2B4, task_id: task_01K5W0A8Z4X9V2M6N7P0R1S2B3, action: pause }
```
