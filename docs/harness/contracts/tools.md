# Tool sözleşmesi

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/tools.ts`; uygulama: `src/harness/tools/` + sandbox (I3). Kararlar: [ADR-06](../decisions/ADR-06-sandbox.md), [ADR-12](../decisions/ADR-12-extensions.md), [ADR-13](../decisions/ADR-13-mcp-acp.md), [ADR-18](../decisions/ADR-18-harness-computed-evidence.md) (kısa ref, düzenleme araçları, rapor düzeltmesi), [ADR-19](../decisions/ADR-19-workspace-fidelity.md) (workspace digest'i), [ADR-20](../decisions/ADR-20-context-efficiency.md) (terminal araçlar).

## 1. Tek hat

Yerleşik, MCP köprüsü veya gelecekteki MCP client araçları dahil her eylem `ToolGateway.invoke` üzerinden geçer:

```text
tool/call_proposed      ← ToolCallId ve kısa ref (`ref`, attempt içi sıra) atanır, args digest'i + gerekirse blob kaydedilir
  → registry lookup      (yok → unknown_tool)
  → input schema (zod)   (hata → invalid_arguments)
  → Tool.normalize       (realpath/junction çözümü, argv, cwd, host → NormalizedAction)
  → PolicyEngine.evaluate → tool/policy_decided  (deny → denied)
  → ApprovalBroker       (yalnız decision=ask ise) → approval/*
  → sandbox check        (require_full_sandbox && enforcement≠full → sandbox_insufficient)
tool/execution_started
  → Tool.execute(timeout, signal)
  → redact + bound (16 KiB satır içi, fazlası blob)
tool/result_recorded    → model'e tool_result (`renderToolResultText(ref, result)`: `[#n] …`)
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
| `ends_turn?` | Yalnız `control` araçlar (şema uygular). Çağrı `succeeded` + `status: ok` bitince gateway `ToolCallOutcome.endsTurn = true` döner ve driver yeni model isteği göndermeden turu `completed` bitirir; aynı batch'te sonraki çağrılar çalıştırılmaz, sentetik "turn ended by <tool>" hata sonucu alır (ADR-20). `task_report`, `review_report`, `plan_propose` (yalnız kabul edilince `ok` döner), `task_triage` |

### v1 yerleşik araçlar

| Ad | Etki | Roller | Not |
| --- | --- | --- | --- |
| `read_file` | read | hepsi | read_scope; binary/boyut sınırı; secret redaksiyonu. İlk satır başlıktır: `<path> · digest sha256:<hex> · lines <a>-<b> of <n>`; digest attempt çalışma alanındaki ham baytların `workspaceDigest`'idir (`ToolResult.digest`), aynen `expected_digest` olarak kullanılabilir. Modele gösterilen metin 32 KiB'la sınırlıdır (baş + son; tamamı blob'ta, "truncated; use offset/limit" notu) |
| `search` | read | hepsi | ripgrep benzeri; read_scope |
| `list_dir` | read | hepsi | |
| `git_status`, `git_diff` | read | hepsi | Kullanıcı değişikliklerini ayrı gösterir |
| `apply_patch` | workspace-write | implementer, debugger (owned-paths), orchestrator (`.ai/tasks/**`) | Önkoşul: `expected_digest` verilmezse bu attempt'te o yolun son okunan/yazılan digest'i (`AttemptFileLedger.lastSeen`); hiçbiri yoksa `invalid_arguments` "read the file first". Kabul edilen biçimler: unified diff (`@@ -a,b +c,d @@`), sayısız `@@` başlıkları (hunk bağlamdan bulunur) ve `*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** End Patch` biçimi. Satır sonu satır başına korunur (CRLF, LF, yalnız CR), BOM korunur ve eşleşmede yok sayılır; geçersiz UTF-8 dosya `invalid_arguments` ile **reddedilir** (asla bozularak yazılmaz). Hata mesajı kabul edilen biçimleri ve 3 satırlık bir örneği içerir; `stale_precondition` güncel digest'i ve "re-read and retry" der. Atomik yazma |
| `write_file` | workspace-write | implementer, debugger (owned-paths) | Yeni dosya veya önkoşullu üzerine yazma (`expected_digest` varsayılanı `apply_patch` ile aynı). Var olan dosya tek tip EOL taşıyorsa içerik o EOL'e çevrilir, BOM korunur; geçersiz UTF-8 hedef reddedilir. Sonuç `digest` yeni içeriğin digest'idir |
| `exec` | exec | implementer, debugger, reviewer (izole) | argv (shell string değil), cwd, env allowlist, timeout, output cap; yıkıcı komut sınıflandırması |
| `task_spawn`, `task_status` | control | orchestrator | Packet şeması + DAG + ownership; bkz. [task-packets.md](./task-packets.md) |
| `ask_user` | control | orchestrator | Headless'ta `approval_unavailable` |
| `memory_propose` | control | orchestrator, worker | Yalnız öneri; kalıcı yazım memory modülünde ([memory.md](./memory.md)) |
| `task_report` | control | explorer, implementer, debugger | Attempt raporu (`taskReportInputSchema`); callback gerekmez, orchestration kaydı günlükten okur ([runtime-seams.md](./runtime-seams.md#5-yapılandırılmış-rapor-araçları)) |
| `review_report` | control | reviewer | Review hükmü (`reviewReportInputSchema`) |
| `plan_propose` | control | orchestrator | Plan önerisi (`planProposalSchema`); kimlik alanlarını harness ekler, `planSchema` doğrular |

## 3. Sonuç

`ToolResult`: `status (ok|error)`, `text` (≤16 KiB), `blob?`, `truncated`, `exit_code?`, `changed_paths?`, `digest?` (tek dosyalı araçlarda çağrıdan sonraki `workspaceDigest`; `tool/result_recorded` v2), `redactions`, `error?{code, message}`. `status: error` ⇔ `error` mevcut. Hata kodları: `unknown_tool`, `invalid_arguments`, `policy_denied`, `approval_rejected`, `approval_unavailable`, `sandbox_insufficient`, `path_outside_scope`, `stale_precondition`, `timeout`, `cancelled`, `execution_failed`, `outcome_unknown`.

### Modele gösterim ve kısa ref (ADR-18)

- Gateway her çağrıya attempt içinde (attempt yoksa session içinde) 1'den başlayan bir sıra verir, `tool/call_proposed.ref` (v2) olarak yazar ve `ToolCallOutcome.ref` ile döner. Resume sonrası sayaç, o attempt'in kayıtlı `tool/call_proposed` olaylarından devam eder; aynı sayı iki çağrıya verilmez.
- Driver model mesajındaki tool sonucunu yalnız `renderToolResultText(ref, result)` ile kurar: `[#n] ` + metin (+ hata satırı `Error [<code>]: <message>`; boş başarılı sonuç `ok`). Adapter'lar metni aynen gönderir; `provider_call_id` yalnız sağlayıcı eşlemesi içindir.
- Araç çağrısı sırasında `ToolExecutionContext.ref` ve `ToolExecutionContext.files` (`AttemptFileLedger`: attempt'in yol başına son okunan/yazılan digest'i; anahtar NFC + platform katlama politikası) araçlara verilir. Ledger bir kolaylıktır, izin değildir.
- Rapor araçları (`task_report`, `review_report`) kanıtı çağrı içinde çözer; çözülmeyen işaretçide `invalid_arguments` döner, `text` alanı `formatEvidenceCorrection` çıktısıdır (geçerli `#n` listesi) ve aynı session'da bir düzeltme hakkı vardır ([task-packets §8](./task-packets.md#8-harness-kanıtı-çözümleme-ve-onarım-adr-18)).

## 4. İptal, crash ve idempotency

- İptal sinyali çalışan child process'e iletilir (önce SIGINT/CTRL_BREAK, süre sonunda SIGKILL/TerminateProcess). Sonuç `cancelled`.
- `tool/execution_started` yazılmış ama `tool/result_recorded` yazılmamış çağrı recovery'de `tool/interrupted {outcome: unknown}` olur. **Otomatik tekrar yoktur**; `read` + `idempotent` araçlar bile yalnız açık retry politikasıyla ve yeni `ToolCallId` ile yinelenir.
- Model isteği retry'si, önceki step'in tool çağrılarını tekrar çalıştırmaz.

## 5. Sandbox

`SandboxRunner.probe()` → `SandboxReport {backend, platform, enforcement, filesystem, network, process, notes}`; her boyut `full | partial | unavailable`. v1 backend'leri: Linux `bubblewrap` (varsa), macOS `sandbox-exec` (varsa), Windows `policy-only` (partial). Probe hatası `unavailable` sayılır (fail-closed). `partial` durum UI başlığında, `tool/execution_started.sandbox_enforcement`'ta ve `doctor --runtime`'da görünür. Sandbox izin kararı vermez; yalnız uygular ve raporlar. Sandbox `full` değilse PolicyEngine `exec`'i varsayılan-ret bir allowlist ile sınırlar (`EffectivePolicy.exec_confinement`, bkz. [policy ve onay §4](./policy-and-approval.md)); allowlist dışı exec reddi `sandbox` katmanındadır ve gateway'de `sandbox_insufficient` olur. Child process'ler stdio pipe ile başlatılır (console codepage mirası yok), env `ProcessSpec.env` ile açıkça verilir.

`SandboxRunner.run(spec, signal)` → `ProcessResult {termination, exitCode, signal, stdout, stderr, truncated, spawnError, durationMs}`. `termination` (`PROCESS_TERMINATIONS`) sonucu açıkça söyler: `exited` (süreç çalıştı ve kendi kodu/sinyaliyle bitti), `timeout` ve `cancelled` (runner ağacın tamamını sonlandırdı), `spawn-failed` (hiçbir şey çalışmadı; `spawnError` nedeni taşır, örn. `ENOENT`). Araçlar sonucu `exitCode === null` gibi dolaylı işaretlerden çıkarmaz; `cancelled` → `cancelled`, `timeout` → `timeout`, `spawn-failed` → `execution_failed`.

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

Terminal kontrol aracı (ADR-20):

```yaml example=tool-metadata
name: task_report
version: "1.1.0"
description: Finish the attempt with status, summary and evidence per acceptance criterion (cite tool results as "#n").
source: builtin
effect: control
effect_source: builtin
idempotent: false
network: none
output_limit_bytes: 65536
timeout_ms: 60000
cancellable: true
concurrency: sequential
visible_to: [explorer, implementer, debugger]
ends_turn: true
```

Reddedilenler: MCP sunucusunun kendini `read` ilan etmesi; sınıflandırılmamış aracın düşük etki alması; kontrol dışı aracın turu bitirmesi.

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
- name: read_file
  version: "1.1.0"
  description: Read a file.
  source: builtin
  effect: read
  effect_source: builtin
  idempotent: true
  network: none
  output_limit_bytes: 65536
  timeout_ms: 10000
  cancellable: true
  concurrency: parallel
  visible_to: [implementer]
  ends_turn: true
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
- status: ok
  text: "src-add.mjs · digest sha256:9754e1f0c2b4a6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7 · lines 1-3 of 3\n1  export function add(a, b) {\n2    return a - b;\n3  }\n"
  truncated: false
  digest: "sha256:9754e1f0c2b4a6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7"
  redactions: 0
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
