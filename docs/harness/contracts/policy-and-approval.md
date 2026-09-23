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
| control (task_spawn, memory_propose, task_report, review_report, plan_propose) | rol izin veriyorsa allow | allow |
| Plan onayı | orchestrator onaylar (`decided_by: orchestrator`, denetlenir) | kullanıcı |
| Paid provider değişimi / bütçe artışı / çalışma alanı güveni | **insan** (`HUMAN_ONLY_APPROVAL_SUBJECTS`) | insan |
| Tam sandbox yokken doğrulama ve build/test komutu, güvenilmeyen çalışma alanı | **deny** (`workspace-untrusted`) | ask |
| Hard rail | **deny** | **deny** |

Şema kuralları: `autonomous` modda hiçbir etki `ask` olamaz; `autonomous` modda `external-write: allow` boş olmayan `external_write_allowlist` gerektirir.

## 3. Hard rail'ler

Prompt değil, retten ibarettir; hiçbir mod, grant, config veya onay gevşetemez (`HARD_RAILS`):

| Rail | Tetik |
| --- | --- |
| `write-outside-scope` | Çözülmüş (realpath/junction) hedef write_scope dışında veya forbidden ile kesişiyor |
| `reserved-path-write` | `.git/**` (özellikle `.git/hooks/**`, `.git/config`), `.synorch/**` yazımı; kanonik yolu (realpath + Windows'ta harf duyarsız) Synorch home altında kalan yazma (işçinin kendi workspace kökü hariç); `git config` yazma biçimleri ve `core.hooksPath` ayarlayan komutlar (worktree yönetimi yalnız IsolationProvider üzerinden) |
| `destructive-command` | Aşağıdaki sınıflandırma |
| `credential-access` | Synorch credential dosyası/keychain girdisine tool ile erişim |
| `foreign-credential-store` | `FORBIDDEN_CREDENTIAL_SOURCES` okuma/yazma |
| `secret-egress` | Redaksiyon listesindeki değeri içeren argüman/ağ isteği |
| `policy-self-modification` | Etkin politika kaynaklarını (kullanıcı config'i) tool ile değiştirme |

Yıkıcı komut sınıflandırması (I3 veri olarak tutar, liste genişletilebilir, daraltılamaz): workspace kökü veya owned dışı özyinelemeli silme (`rm -rf`, `Remove-Item -Recurse`, `rd /s`), `git reset --hard`, `git clean -fdx`, `git checkout -- .`/`git restore .` (kullanıcı değişikliklerini ezer), `git push --force`/`--force-with-lease`, `git branch -D`, tag/branch silme push'u, `git filter-branch`/`filter-repo`, `npm|pnpm|yarn publish`, `mkfs`, `format`, `diskpart`, `dd of=/dev/*`, `sudo`/`runas`, `chmod -R` / `icacls /grant` workspace dışına, `curl|wget ... | sh`, `docker system prune`, sistem servisleri. Normal `git push` bir `external-write`'tır (allowlist).

## 4. EffectivePolicy alanları

`schema_version`, `policy_version`, `mode`, `role`, `run_id`, `task_id?`, `workspace_root` (attempt'in izole kökü olabilir), `write_scope`, `read_scope`, `forbidden`, `effects{read, workspace-write, exec, external-write, control}`, `external_write_allowlist`, `network{mode: deny|allowlist|allow, hosts}`, `sandbox{backend, enforcement}`, `require_full_sandbox`, `exec_confinement?` (`full-sandbox|allowlist|ask`), `verification_commands?` (varsayılan `[]`), `workspace_trusted?` (v3, yoksa güvenilmez), `layers[]{layer, source, digest}`.

**Exec kısıtı (`exec_confinement`, `policy/snapshot` v2).** Varsayılan-ret: yalnız olumlu tanınan komut çalışır. `full-sandbox`: sandbox `full`, OS backend her child'ı sınırlar; yazan roller için yalnız yıkıcı komut sınıflandırması geçerlidir. `allowlist` (sandbox `full` değil, `autonomous`): yalnız birebir `verification_commands`, salt-okunur komut listesi ve incelenmiş build/test listesi çalışır, geri kalanı `sandbox` katmanında `exec-not-allowlisted` ile reddedilir (gateway `sandbox_insufficient`). `ask` (sandbox `full` değil, `ask` modu): listede olmayan komut `exec-unconfined` ile sorulur. Read-only işçiler (explorer, reviewer, owned path'i olmayan rca-only debugger) sandbox'tan bağımsız olarak yalnız salt-okunur listeyi ve birebir doğrulama komutlarını çalıştırır (`role` katmanı). Alan `compute` tarafından her zaman yazılır ve `execConfinementFor(sandbox.enforcement, mode)` ile tutarlı olmak zorundadır; eski (v1) snapshot'larda bulunmaz. `verification_commands` = `PolicyInputs.taskScope.verification_commands` (packet `verification.commands`); eşleşme kelime kelime tam argv'dir. Ortam ataması (`NODE_OPTIONS=... node --test`) içeren bir doğrulama dizesi hiçbir argv ile eşleşmez.

**Değerlendirme sırası (SEC-N5).** Birebir doğrulama komutu eşleşmesinden **önce**: (1) çalışma alanını yazan git biçimleri (`add`, `commit`, `stash`, `checkout`, `reset`, `switch`, `restore`, `rebase`, `merge`, `tag`, `branch` yazma biçimleri, `cherry-pick`, `revert`, `apply`, `am`, `mv`, `rm`, `pull`, `clean`, `worktree`, `config`, …) her işçi için, her sandbox'ta `role` katmanında reddedilir — yalnız harness entegre eder (SEC-N3); (2) `node` için modül/yapılandırma yükleyen seçenekler (`--import`, `--require`/`-r`, `--loader`, `--experimental-loader`, `--env-file*`, `--experimental-config-file`, `--test-global-setup`, `--inspect*`, …), yerleşik olmayan `--test-reporter` (yalnız `spec`, `tap`, `dot`, `junit`, `lcov`) ve çalışma alanı dışına işaret eden `--test-reporter-destination` güvenden bağımsız reddedilir (SEC-N1); (3) git'in çalışma alanı dışını okuyup yazdığı biçimler (`--no-index`, `-O<dosya>`/`--orderfile`, `--contents`, `--output*`, `--ext-diff`, `--textconv`, ve `rev:yol` dahil dışarı çözülen her yol argümanı) hem salt-okunur roller hem yazanlar için reddedilir (SEC-N2); (4) düz kelime olmayan program adı ve satır içi kod (`node -e`, `bash -c`, `pwsh -Command`, …) tanınmaz. Bu kontrollerden geçmeyen argv, bir plan onu doğrulama komutu olarak listelese bile çalışmaz. Git komutları doğrulama listesi üzerinden değil, yalnız salt-okunur liste (veya kullanıcının birebir allowlist girdisi) üzerinden çalışır.

**Çalışma alanı güveni (SEC-N1, `workspace_trusted`).** Doğrulama komutları ve build/test listesi depo kodunu, oturum sırasında yapay zekânın yazdığı kod dahil, çalıştırır; `full` olmayan sandbox bu kodu sınırlayamaz: kullanıcının izinleriyle çalışır ve çalışma alanı dışındaki dosyalara, Synorch kimlik bilgileri dahil, erişebilir. Bu yüzden `exec_confinement ≠ full-sandbox` iken bu komutlar çalışma alanının güvenilir olmasını ister; güvenilmezse `autonomous` modda `workspace-untrusted` (katman `user`, gateway `policy_denied`) ile reddedilir, `ask` modunda sorulur. Salt-okunur liste güven gerektirmez. Güven yalnız kullanıcı kapsamındadır: `<synorch home>/trust.json`, kanonik kök + depo kimliği (git dizininin veya kökün dosya kimliği ve oluşturma zamanı) anahtarlı; home çalışma alanının içindeyse güven yok sayılır ve verilemez. Kaynaklar: `syn trust [--target]` / `syn trust --revoke`, etkileşimli oturumda bir kez sorulan `workspace-trust` konusu (yalnız insan; seçenekler "Not now" önceden seçili, "Trust for this session only" = `allowed-once`, yalnız bu runtime ve kalıcı değil, `trust/used.source: session`, "Trust this workspace" = `allowed-for-scope`, kalıcı), veya tek bir run için `syn run --trust-workspace` (kalıcı değil). Depo içeriği, yapılandırma katmanları veya model metni güven veremez. `PolicyEngine`'e güveni yalnız composition root (`createPolicyEngine({ workspaceTrusted })`) verir. Kararlar `trust/granted`/`trust/revoked` (projenin `syn trust decisions` oturumu), kullanım `trust/used` (run günlüğü) olarak denetlenir. Headless bir run'ın planı doğrulama komutu içeriyor ve güven yoksa run hiçbir işçi başlamadan exit 3 (`approval_unavailable`, `next_command: syn trust`) ile biter.

Şema tarafından reddedilenler: read-only rolde (explorer, reviewer) yazma kapsamı veya `workspace-write ≠ deny`; orchestrator için `.ai/tasks/` dışı yazma; tüm workspace (`**`, `.`) veya rezerve path yazma kapsamı; `require_full_sandbox` iken `full` olmayan sandbox ile `workspace-write`/`exec` izni; sandbox ve modla çelişen `exec_confinement`; allowlist modu dışında host listesi.

## 5. Normalize eylem, karar ve digest

`NormalizedAction` = `tool_name`, `tool_version`, `effect`, `role`, `task_id?`, `args_digest`, `paths[]{path, access}`, `escapes?[]{requested, access, reason}`, `command?{argv, cwd}`, `network_hosts`, `destructive`. Onaylar `digestOf(action)` değerine bağlanır: aynı onay farklı argümana, yeni kapsama veya credential'a taşınamaz.

**Kaçan yollar (`escapes`).** Workspace içinde ifade edilemeyen bir yol (`..` kaçışı, dışarıdaki mutlak yol, UNC/cihaz yolu, dışarı çıkan link, sarkan link, çoklu hard link) `paths`'e yazılamaz (`pathPatternSchema`); yine de eylem normalize edilir ve yol `escapes`'e girer (`requested` ≤ 1024 karakter, redakte edilmiş ham argüman; `reason` ∈ `PATH_ESCAPE_REASONS`). PolicyEngine her kaçışı reddeder: yazmada `rail: write-outside-scope` + `code: path-escape`, okumada rail'siz `code: read-outside-workspace` (`PATH_ESCAPE_REASON_CODE`). Böylece her ret `tool/policy_decided` (v2) olarak denetim kaydına girer; gateway sonucu `path_outside_scope` olur. `escapes` yalnız boş değilse bulunur, bu yüzden kaçış içermeyen eylemlerin digest'i değişmez.

`PolicyDecision` = `decision (allow|ask|deny)`, `action_digest`, `policy_digest`, `reasons[]{code, layer, message}` (en az bir), `rail?`. `rail` varsa karar `deny`'dır. `--explain-permission` (salt okunur) aynı `evaluate` fonksiyonunu çağırır.

## 6. Onay

- `ApprovalRequest`: `approval_id`, `run_id`, `task_id?`, `subject_kind (plan|action|scope-expansion|provider-change|budget|memory|workspace-trust)`, `subject_digest`, `summary`, `effect?`, `scope (once|plan|session)`, `requested_at`, `expires_at?`.
- `ApprovalDecision`: `outcome (allowed-once|allowed-for-scope|rejected|cancelled|unavailable|expired)`, `decided_by (user|orchestrator|config|broker)`, `mode`, `decided_at`, `reason?`. Yalnız `allowed-*` eylemi çalıştırır.
- Kurallar (şema): orchestrator yalnız `autonomous` modda karar verir ve `provider-change`/`budget`/`workspace-trust` onaylayamaz; broker yalnız reddedebilir (`unavailable`, `expired`, `cancelled`); `unavailable`/`expired` yalnız broker üretir.
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
  exec_confinement: full-sandbox
  verification_commands: ["pnpm test"]
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
  exec_confinement: ask
  verification_commands: []
  workspace_trusted: false
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
  exec_confinement: full-sandbox
  verification_commands: []
  layers: [{ layer: user, source: ~/.synorch/config.yaml, digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" }]
```

Yetki genişletme denemeleri (hepsi reddedilir): yazan explorer; `autonomous` modda prompt; allowlist'siz otomatik dış yazma; ürün dosyası yazan orchestrator; tam sandbox şartı varken kısmi sandbox'ta exec; tüm workspace'i yazma; kısmi sandbox'ta kendini `full-sandbox` ilan eden exec kısıtı.

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
  require_full_sandbox: false
  exec_confinement: full-sandbox
  verification_commands: []
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

```yaml example=normalized-action
tool_name: read_file
tool_version: "1.0.0"
effect: read
role: explorer
args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
paths: []
escapes: [{ requested: "C:\\Users\\dev\\.ssh\\id_ed25519", access: read, reason: outside-workspace }]
network_hosts: []
destructive: false
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

Boş `escapes` listesi de reddedilir (alan yalnız kaçış varken bulunur):

```yaml example=normalized-action invalid
tool_name: write_file
tool_version: "1.0.0"
effect: workspace-write
role: implementer
args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
paths: [{ path: src/auth/a.ts, access: write }]
escapes: []
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
