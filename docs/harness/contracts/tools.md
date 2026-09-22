# Tool sözleşmesi

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/tools.ts`; uygulama: `src/harness/tools/` + sandbox (I3). Kararlar: [ADR-06](../decisions/ADR-06-sandbox.md), [ADR-12](../decisions/ADR-12-extensions.md), [ADR-13](../decisions/ADR-13-mcp-acp.md).

## 1. Tek hat

Yerleşik, MCP köprüsü veya gelecekteki MCP client araçları dahil her eylem `ToolGateway.invoke` üzerinden geçer:

```text
tool/call_proposed      ← ToolCallId atanır, args digest'i + gerekirse blob kaydedilir
  → registry lookup      (yok → unknown_tool)
  → input schema (zod)   (hata → invalid_arguments)
  → Tool.normalize       (realpath/junction çözümü, argv, cwd, host → NormalizedAction)
  → PolicyEngine.evaluate → tool/policy_decided  (deny → denied)
  → ApprovalBroker       (yalnız decision=ask ise) → approval/*
  → sandbox check        (require_full_sandbox && enforcement≠full → sandbox_insufficient)
tool/execution_started
  → Tool.execute(timeout, signal)
  → redact + bound (16 KiB satır içi, fazlası blob)
tool/result_recorded    → model'e tool_result
```

`ToolGateway` olayları kendisi yazar; hiçbir modül kayıtsız tool çalıştıramaz. Gateway reddedilen veya başarısız çağrı için throw etmez; `ToolCallOutcome` döner ve model bir hata sonucu görür. Hook veya model metni hattın hiçbir adımını atlayamaz.

## 2. Metadata

| Alan | Kural |
| --- | --- |
| `name` | snake_case, ≤64; modele aynı adla gösterilir (köprüde `mcp__synorch__<name>`) |
| `version` | semver; `NormalizedAction.tool_version` ile digest'e girer |
| `source` | `builtin` \| `mcp` \| `extension` (v1'de yalnız builtin, ADR-12) |
| `effect` | `read`, `workspace-write`, `exec`, `external-write`, `control` |
| `effect_source` | `builtin` yalnız builtin araçlar için; diğerlerinde `user-config` veya `default-high-risk` (= `external-write`). Sunucunun kendi beyanı politika kaynağı değildir |
| `idempotent` | Crash sonrası otomatik tekrar değerlendirmesinin girdisi (tek başına izin vermez) |
| `network` | `none` \| `optional` \| `required` (`required` ise `read` olamaz) |
| `output_limit_bytes` | 1 KiB–4 MiB; üstü kesilir, `truncated: true` |
| `timeout_ms` | 100 ms–1 saat |
| `cancellable`, `concurrency` | `sequential` araç varsa bütün batch sıralı çalışır |
| `visible_to` | Rol listesi; `ToolRegistry.visibleTo(role, policy)` policy ile kesiştirir |

### v1 yerleşik araçlar

| Ad | Etki | Roller | Not |
| --- | --- | --- | --- |
| `read_file` | read | hepsi | read_scope; binary/boyut sınırı; secret redaksiyonu |
| `search` | read | hepsi | ripgrep benzeri; read_scope |
| `list_dir` | read | hepsi | |
| `git_status`, `git_diff` | read | hepsi | Kullanıcı değişikliklerini ayrı gösterir |
| `apply_patch` | workspace-write | implementer, debugger (owned-paths), orchestrator (`.ai/tasks/**`) | Beklenen eski digest zorunlu (`stale_precondition`); atomik yazma |
| `write_file` | workspace-write | implementer, debugger (owned-paths) | Yeni dosya veya digest eşleşmeli üzerine yazma |
| `exec` | exec | implementer, debugger, reviewer (izole) | argv (shell string değil), cwd, env allowlist, timeout, output cap; yıkıcı komut sınıflandırması |
| `task_spawn`, `task_status` | control | orchestrator | Packet şeması + DAG + ownership; bkz. [task-packets.md](./task-packets.md) |
| `ask_user` | control | orchestrator | Headless'ta `approval_unavailable` |
| `memory_propose` | control | orchestrator, worker | Yalnız öneri; kalıcı yazım memory modülünde ([memory.md](./memory.md)) |

## 3. Sonuç

`ToolResult`: `status (ok|error)`, `text` (≤16 KiB), `blob?`, `truncated`, `exit_code?`, `changed_paths?`, `redactions`, `error?{code, message}`. `status: error` ⇔ `error` mevcut. Hata kodları: `unknown_tool`, `invalid_arguments`, `policy_denied`, `approval_rejected`, `approval_unavailable`, `sandbox_insufficient`, `path_outside_scope`, `stale_precondition`, `timeout`, `cancelled`, `execution_failed`, `outcome_unknown`.

## 4. İptal, crash ve idempotency

- İptal sinyali çalışan child process'e iletilir (önce SIGINT/CTRL_BREAK, süre sonunda SIGKILL/TerminateProcess). Sonuç `cancelled`.
- `tool/execution_started` yazılmış ama `tool/result_recorded` yazılmamış çağrı recovery'de `tool/interrupted {outcome: unknown}` olur. **Otomatik tekrar yoktur**; `read` + `idempotent` araçlar bile yalnız açık retry politikasıyla ve yeni `ToolCallId` ile yinelenir.
- Model isteği retry'si, önceki step'in tool çağrılarını tekrar çalıştırmaz.

## 5. Sandbox

`SandboxRunner.probe()` → `SandboxReport {backend, platform, enforcement, filesystem, network, process, notes}`; her boyut `full | partial | unavailable`. v1 backend'leri: Linux `bubblewrap` (varsa), macOS `sandbox-exec` (varsa), Windows `policy-only` (partial). Probe hatası `unavailable` sayılır (fail-closed). `partial` durum UI başlığında, `tool/execution_started.sandbox_enforcement`'ta ve `doctor --runtime`'da görünür. Sandbox izin kararı vermez; yalnız uygular ve raporlar. Child process'ler stdio pipe ile başlatılır (console codepage mirası yok), env `ProcessSpec.env` ile açıkça verilir.

## 6. Örnekler

```yaml example=tool-metadata
- name: apply_patch
  version: "1.0.0"
  description: Apply a unified diff to owned files; every hunk states the expected pre-image digest.
  source: builtin
  effect: workspace-write
  effect_source: builtin
  idempotent: false
  network: none
  output_limit_bytes: 65536
  timeout_ms: 30000
  cancellable: true
  concurrency: sequential
  visible_to: [implementer, debugger, orchestrator]
- name: exec
  version: "1.0.0"
  description: Run a program with argv, cwd and environment inside the sandbox.
  source: builtin
  effect: exec
  effect_source: builtin
  idempotent: false
  network: optional
  output_limit_bytes: 1048576
  timeout_ms: 600000
  cancellable: true
  concurrency: sequential
  visible_to: [implementer, debugger, reviewer]
- name: jira_create_issue
  version: "0.3.1"
  description: Create an issue through an external MCP server.
  source: mcp
  effect: external-write
  effect_source: default-high-risk
  idempotent: false
  network: required
  output_limit_bytes: 16384
  timeout_ms: 60000
  cancellable: false
  concurrency: sequential
  visible_to: [orchestrator]
```

Reddedilenler: MCP sunucusunun kendini `read` ilan etmesi; sınıflandırılmamış aracın düşük etki alması.

```yaml example=tool-metadata invalid
- name: innocent_reader
  version: "1.0.0"
  description: Claims to only read.
  source: mcp
  effect: read
  effect_source: builtin
  idempotent: true
  network: none
  output_limit_bytes: 16384
  timeout_ms: 1000
  cancellable: true
  concurrency: parallel
  visible_to: [explorer]
- name: unknown_ext
  version: "1.0.0"
  description: Unclassified extension tool.
  source: extension
  effect: read
  effect_source: default-high-risk
  idempotent: true
  network: none
  output_limit_bytes: 16384
  timeout_ms: 1000
  cancellable: true
  concurrency: parallel
  visible_to: [explorer]
```

```yaml example=tool-result
- status: ok
  text: "@@ applied 2 hunks to src/auth/refresh-service.ts"
  truncated: false
  changed_paths: [src/auth/refresh-service.ts]
  redactions: 0
- status: error
  text: ""
  truncated: false
  redactions: 0
  error: { code: path_outside_scope, message: "src/billing/invoice.ts resolves outside owned paths" }
```

```yaml example=tool-result invalid
- { status: error, text: "failed", truncated: false, redactions: 0 }
- { status: ok, text: "ok", truncated: false, redactions: 0, error: { code: timeout, message: "late" } }
```

```yaml example=sandbox-report
- { backend: bubblewrap, platform: linux, enforcement: full, filesystem: full, network: full, process: full, notes: [] }
- backend: policy-only
  platform: win32
  enforcement: partial
  filesystem: partial
  network: unavailable
  process: partial
  notes: ["no OS filesystem sandbox on Windows in v1; writes are checked by the gateway at action time"]
```
