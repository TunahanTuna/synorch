# Politika, hard rail ve onay sözleşmesi

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/policy.ts`, `paths.ts`; uygulama: `src/harness/policy/` (I3). Kararlar: [ADR-08](../decisions/ADR-08-approval-policy.md), [ADR-06](../decisions/ADR-06-sandbox.md), [ADR-15](../decisions/ADR-15-headless.md).

## 1. Etkin politika bir kesişimdir

```text
effective = platform ∩ user config ∩ workspace policy ∩ role ∩ task scope ∩ sandbox capability ∩ approvals
```

`PolicyEngine.compute(inputs)` bunu `EffectivePolicy` olarak üretir ve `policy/snapshot` olayıyla (`digest = digestOf(policy)`) kaydeder. Hiçbir katman diğerini genişletemez. Model mesajı, repo dosyası (`.ai/**` dahil), tool çıktısı, MCP sunucu açıklaması veya hafıza notu **politika kaynağı değildir**; repo içi politika dosyaları yalnızca daraltabilir. Her genişleme yeni bir `EffectivePolicy` sürümü ve olay gerektirir.

## 2. Modlar

Varsayılan mod `autonomous`'tur (ürün sahibi kararı, ADR-08): orchestrator oturumu baştan sona yönetmeye tam yetkilidir, eylem başına soru sorulmaz. `ask` açıkça seçilen daha katı moddur (`--policy ask` veya config `policy.mode: ask`).

| Eylem | `autonomous` | `ask` |
| --- | --- | --- |
| read (read_scope içinde) | allow | allow |
| workspace-write (write_scope içinde) | allow | ask |
| exec (yıkıcı olmayan) | allow | ask |
| external-write (`git push`, publish, dış API yazma) | yalnız kullanıcı allowlist'iyle allow, aksi halde **deny** | ask |
| control (task_spawn, memory_propose) | rol izin veriyorsa allow | allow |
| Plan onayı | orchestrator onaylar (`decided_by: orchestrator`, denetlenir) | kullanıcı |
| Paid provider değişimi / bütçe artışı | **insan** (`HUMAN_ONLY_APPROVAL_SUBJECTS`) | insan |
| Hard rail | **deny** | **deny** |

Şema kuralları: `autonomous` modda hiçbir etki `ask` olamaz; `autonomous` modda `external-write: allow` boş olmayan `external_write_allowlist` gerektirir.

## 3. Hard rail'ler

Prompt değil, retten ibarettir; hiçbir mod, grant, config veya onay gevşetemez (`HARD_RAILS`):

| Rail | Tetik |
| --- | --- |
| `write-outside-scope` | Çözülmüş (realpath/junction) hedef write_scope dışında veya forbidden ile kesişiyor |
| `reserved-path-write` | `.git/**`, `.synorch/**` yazımı (worktree yönetimi yalnız IsolationProvider üzerinden) |
| `destructive-command` | Aşağıdaki sınıflandırma |
| `credential-access` | Synorch credential dosyası/keychain girdisine tool ile erişim |
| `foreign-credential-store` | `FORBIDDEN_CREDENTIAL_SOURCES` okuma/yazma |
| `secret-egress` | Redaksiyon listesindeki değeri içeren argüman/ağ isteği |
| `policy-self-modification` | Etkin politika kaynaklarını (kullanıcı config'i) tool ile değiştirme |

Yıkıcı komut sınıflandırması (I3 veri olarak tutar, liste genişletilebilir, daraltılamaz): workspace kökü veya owned dışı özyinelemeli silme (`rm -rf`, `Remove-Item -Recurse`, `rd /s`), `git reset --hard`, `git clean -fdx`, `git checkout -- .`/`git restore .` (kullanıcı değişikliklerini ezer), `git push --force`/`--force-with-lease`, `git branch -D`, tag/branch silme push'u, `git filter-branch`/`filter-repo`, `npm|pnpm|yarn publish`, `mkfs`, `format`, `diskpart`, `dd of=/dev/*`, `sudo`/`runas`, `chmod -R` / `icacls /grant` workspace dışına, `curl|wget ... | sh`, `docker system prune`, sistem servisleri. Normal `git push` bir `external-write`'tır (allowlist).

## 4. EffectivePolicy alanları

`schema_version`, `policy_version`, `mode`, `role`, `run_id`, `task_id?`, `workspace_root` (attempt'in izole kökü olabilir), `write_scope`, `read_scope`, `forbidden`, `effects{read, workspace-write, exec, external-write, control}`, `external_write_allowlist`, `network{mode: deny|allowlist|allow, hosts}`, `sandbox{backend, enforcement}`, `require_full_sandbox`, `layers[]{layer, source, digest}`.

Şema tarafından reddedilenler: read-only rolde (explorer, reviewer) yazma kapsamı veya `workspace-write ≠ deny`; orchestrator için `.ai/tasks/` dışı yazma; tüm workspace (`**`, `.`) veya rezerve path yazma kapsamı; `require_full_sandbox` iken `full` olmayan sandbox ile `workspace-write`/`exec` izni; allowlist modu dışında host listesi.

## 5. Normalize eylem, karar ve digest

`NormalizedAction` = `tool_name`, `tool_version`, `effect`, `role`, `task_id?`, `args_digest`, `paths[]{path, access}`, `command?{argv, cwd}`, `network_hosts`, `destructive`. Onaylar `digestOf(action)` değerine bağlanır: aynı onay farklı argümana, yeni kapsama veya credential'a taşınamaz.

`PolicyDecision` = `decision (allow|ask|deny)`, `action_digest`, `policy_digest`, `reasons[]{code, layer, message}` (en az bir), `rail?`. `rail` varsa karar `deny`'dır. `--explain-permission` (salt okunur) aynı `evaluate` fonksiyonunu çağırır.

## 6. Onay

- `ApprovalRequest`: `approval_id`, `run_id`, `task_id?`, `subject_kind (plan|action|scope-expansion|provider-change|budget|memory)`, `subject_digest`, `summary`, `effect?`, `scope (once|plan|session)`, `requested_at`, `expires_at?`.
- `ApprovalDecision`: `outcome (allowed-once|allowed-for-scope|rejected|cancelled|unavailable|expired)`, `decided_by (user|orchestrator|config|broker)`, `mode`, `decided_at`, `reason?`. Yalnız `allowed-*` eylemi çalıştırır.
- Kurallar (şema): orchestrator yalnız `autonomous` modda karar verir ve `provider-change`/`budget` onaylayamaz; broker yalnız reddedebilir (`unavailable`, `expired`, `cancelled`); `unavailable`/`expired` yalnız broker üretir.
- Geçerlilik: `allowed-for-scope` yalnız eşleşen `subject_digest` ve kapsam için geçerlidir; plan yeni sürüme geçerse, kapsam/etkili yetki genişlerse veya policy digest'i değişirse `approval/invalidated` yazılır. Aynı oturumda aynı digest için ikinci soru sorulmaz.
- Headless (ADR-15): `ApprovalBroker.availability = headless`; insan gerektiren her istek `unavailable` → eylem çalışmaz, run exit 3 ile biter. `autonomous` headless run'da insan gerektiren şey yalnız human-only konular ve `ask` modudur.

## 7. Örnekler

```yaml example=effective-policy
- schema_version: 1
  policy_version: 3
  mode: autonomous
  role: implementer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
  workspace_root: /home/dev/.synorch/worktrees/synorch-1a2b3c4d/att_01K5T3Q8Z4X9V2M6N7P0R1S2T8
  write_scope: [src/auth/**, tests/auth/**]
  read_scope: ["**"]
  forbidden: [src/billing/**]
  effects: { read: allow, workspace-write: allow, exec: allow, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers:
    - { layer: platform, source: builtin-rails, digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" }
    - { layer: role, source: implementer, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }
    - { layer: task, source: packet, digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333" }
- schema_version: 1
  policy_version: 1
  mode: ask
  role: explorer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /home/dev/synorch
  write_scope: []
  read_scope: [src/**, docs/**]
  forbidden: []
  effects: { read: allow, workspace-write: deny, exec: ask, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: allowlist, hosts: [registry.npmjs.org] }
  sandbox: { backend: policy-only, enforcement: partial }
  require_full_sandbox: false
  layers: [{ layer: role, source: explorer, digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: orchestrator
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /home/dev/synorch
  write_scope: [.ai/tasks/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: deny, external-write: allow, control: allow }
  external_write_allowlist: ["git push origin harness"]
  network: { mode: deny, hosts: [] }
  sandbox: { backend: sandbox-exec, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: user, source: ~/.synorch/config.yaml, digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" }]
```

Yetki genişletme denemeleri (hepsi reddedilir): yazan explorer; `autonomous` modda prompt; allowlist'siz otomatik dış yazma; ürün dosyası yazan orchestrator; tam sandbox şartı varken kısmi sandbox'ta exec; tüm workspace'i yazma.

```yaml example=effective-policy invalid
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: explorer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: [src/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: deny, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: role, source: explorer, digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: implementer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: [src/auth/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: ask, exec: allow, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: role, source: implementer, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: implementer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: [src/auth/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: allow, external-write: allow, control: deny }
  external_write_allowlist: []
  network: { mode: allow, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: role, source: implementer, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: orchestrator
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: [src/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: deny, external-write: deny, control: allow }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: role, source: orchestrator, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: implementer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: [src/auth/**]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: allow, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: policy-only, enforcement: partial }
  require_full_sandbox: true
  layers: [{ layer: role, source: implementer, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }]
- schema_version: 1
  policy_version: 1
  mode: autonomous
  role: implementer
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  workspace_root: /w
  write_scope: ["**"]
  read_scope: ["**"]
  forbidden: []
  effects: { read: allow, workspace-write: allow, exec: allow, external-write: deny, control: deny }
  external_write_allowlist: []
  network: { mode: deny, hosts: [] }
  sandbox: { backend: bubblewrap, enforcement: full }
  require_full_sandbox: false
  layers: [{ layer: role, source: implementer, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }]
```

```yaml example=normalized-action
tool_name: exec
tool_version: "1.0.0"
effect: exec
role: implementer
task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6
args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
paths: [{ path: src/auth, access: read }]
command: { argv: [git, push, --force, origin, main], cwd: "." }
network_hosts: [github.com]
destructive: true
```

```yaml example=normalized-action invalid
tool_name: apply_patch
tool_version: "1.0.0"
effect: workspace-write
role: implementer
args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
paths: [{ path: ../outside/secrets.env, access: write }]
network_hosts: []
destructive: false
```

```yaml example=policy-decision
- decision: deny
  action_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  rail: destructive-command
  reasons: [{ code: force-push, layer: platform, message: "git push --force is irreversible" }]
- decision: allow
  action_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  reasons: [{ code: owned-path-write, layer: task, message: "src/auth/refresh-service.ts is owned by the task" }]
```

```yaml example=policy-decision invalid
- decision: allow
  action_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  rail: write-outside-scope
  reasons: [{ code: override, layer: approval, message: "user said yes" }]
- decision: allow
  action_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  policy_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  reasons: []
```

```yaml example=approval-request
approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
subject_kind: plan
subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
summary: "Plan v1: fix refresh rotation race (1 implementer, 1 reviewer)"
scope: plan
requested_at: "2026-09-22T10:01:00Z"
```

```yaml example=approval-decision
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: plan
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: allowed-for-scope
  decided_by: orchestrator
  mode: autonomous
  decided_at: "2026-09-22T10:01:00Z"
  reason: "autonomous mode: plan within hard rails, no external effects"
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: action
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: unavailable
  decided_by: broker
  mode: ask
  decided_at: "2026-09-22T10:01:00Z"
  reason: headless run
```

```yaml example=approval-decision invalid
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: action
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: allowed-once
  decided_by: orchestrator
  mode: ask
  decided_at: "2026-09-22T10:01:00Z"
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: provider-change
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: allowed-once
  decided_by: orchestrator
  mode: autonomous
  decided_at: "2026-09-22T10:01:00Z"
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: action
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: allowed-once
  decided_by: broker
  mode: ask
  decided_at: "2026-09-22T10:01:00Z"
- approval_id: apr_01K5T3Q8Z4X9V2M6N7P0R1S2TF
  subject_kind: action
  subject_digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999"
  outcome: unavailable
  decided_by: user
  mode: ask
  decided_at: "2026-09-22T10:01:00Z"
```
