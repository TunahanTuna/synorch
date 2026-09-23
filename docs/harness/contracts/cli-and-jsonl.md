# CLI komutları, renderer seçimi ve JSONL makine modu

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/jsonl.ts`, `errors.ts`, `renderer.ts`; uygulama: `src/harness/cli/`, `src/harness/tui/` (I5), auth komutları I2, memory komutları I6. Kararlar: [ADR-01](../decisions/ADR-01-package-boundary.md), [ADR-04](../decisions/ADR-04-terminal-renderer.md), [ADR-15](../decisions/ADR-15-headless.md).

## 1. Geriye uyumluluk sınırı

`syn inspect`, `syn init`, `syn sync`, `syn doctor` (bayraksız veya mevcut bayraklarla) bugünkü çıktıyı ve exit code'ları **bayt bayt** korur. `src/cli.ts` runtime modüllerini statik olarak import etmez; yeni komutlar yalnız `await import("./harness/cli/index.ts")` ile yüklenir. Bu `tests/harness-boundary.test.ts` ile zorlanır. `doctor --runtime` yeni bir bayraktır; bayrak yoksa `doctor` davranışı aynıdır.

## 2. Komutlar (v1)

| Komut | Davranış | Sahip |
| --- | --- | --- |
| `syn agent [--resume <ses>] [--fork <ses>[@seq]]` | Etkileşimli oturum | I5 |
| `syn run "<hedef>" [--mode jsonl \| --json] [--stream-deltas] [--trust-workspace]` | Tek hedef; TTY'de etkileşimli akış, aksi halde plain/JSONL. `--trust-workspace` çalışma alanına yalnız bu run için güvenir (kalıcı değil, `trust/used source: flag`) | I5 |
| `syn runs [--json]` | Bu proje için oturum/run listesi | I5 |
| `syn show <run\|ses> [--json]` | Plan, task, attempt, onay, kanıt, maliyet, route | I5 |
| `syn doctor --runtime [--probe-model] [--json]` | Node/terminal, sandbox, store, auth, capability; ücretli istek yalnız `--probe-model` ile | I5 (+ I1/I2/I3 probe'ları) |
| `syn login <provider> [--method oauth-subscription\|api-key\|cli-bridge] [--profile <p>] [--device-code]` | Kimlik bağlama | I2 |
| `syn logout <provider> [--profile <p>]` | Credential silme | I2 |
| `syn auth status [--json]` | `AuthStatus` listesi, secret'sız | I2 |
| `syn memory status\|search\|show\|related\|review\|accept\|reject\|open\|reindex` | Hafıza | I6 |
| `syn trust [--target <path>]`, `syn trust --revoke [--target <path>]` | Çalışma alanı güveni (SEC-N1): kaydı yalnız kullanıcı kapsamında `<synorch home>/trust.json`'a yazar/siler; `trust/granted`/`trust/revoked` projenin `syn trust decisions` oturumuna eklenir. Home çalışma alanının içindeyse exit 2 (`config_invalid`) | I5 |

Çalışma alanı güveni: sandbox `full` değilken doğrulama ve build/test komutları depo kodunu, oturum sırasında yapay zekânın yazdığı her kodla birlikte, kullanıcının izinleriyle çalıştırır; bu kod çalışma alanı dışındaki dosyalara, Synorch kimlik bilgileri dahil, erişebilir. Bu komutlar yalnız güvenilen çalışma alanında çalışır ([policy ve onay §4](./policy-and-approval.md#4-effectivepolicy-alanları)). Etkileşimli bir oturum (`syn run`/`syn agent`, TTY) güvenilmeyen çalışma alanında ilk run'dan önce bir kez sorar (`subject_kind: workspace-trust`, metin `WORKSPACE_TRUST_NOTICE`). Soru genel onay seçeneklerini değil kendi seçeneklerini (`WORKSPACE_TRUST_CHOICES`) gösterir: **"Not now"** (ilk ve önceden seçili; düz modda Enter, `n` veya tanınmayan her cevap) güvensiz devam eder; **"Trust for this session only"** (`s`, karar `allowed-once`) güveni yalnız bu runtime için verir, `trust.json`'a yazmaz ve `trust/granted` üretmez, run `trust/used {source: session}` kaydeder; **"Trust this workspace"** (`t`, karar `allowed-for-scope`) güveni `trust.json`'a yazar ve `trust/granted {source: prompt}` ile denetler. Headless bir run'ın planı doğrulama komutu içeriyor ve güven yoksa hiçbir işçi başlamadan `approval_unavailable` (exit 3, `next_command: syn trust (or syn run --trust-workspace for one run)`) ile biter. `doctor --runtime` güven durumunu `trust` kontrolünde gösterir.

Ortak bayraklar: `--target <path>`, `--policy autonomous|ask` (varsayılan `autonomous`), `--plain`, `--color always|never|auto`, `--profile <tier=route>` (yalnız oturum için, kalıcı yazılmaz).

## 3. Renderer seçimi

`selectRendererKind`:

```text
--mode jsonl | --json                                   → jsonl
--plain | SYN_PLAIN (boş/0 değil) | TERM=dumb | !stdin.isTTY | !stdout.isTTY → plain
aksi halde                                              → tui (@earendil-works/pi-tui, adapter arkasında)
renk: --color > config > NO_COLOR (boş değil) > FORCE_COLOR > stream.hasColors()   (selectColor)
```

`CI` değişkeni tek başına modu değiştirmez. Renderer yalnız olay tüketicisidir; kuyruğu sınırlıdır ve dolduğunda yalnız `delta`'lar düşürülür, kalıcı olaylar asla. Etkileşimli modda `Ctrl+C` (veya `Esc`) önce etkin isteği iptal eder; ikinci `Ctrl+C` güvenli kapanış önerir. Kapanışta terminal modu (raw, bracketed paste, keyboard protokolü, alt-screen) geri yüklenir.

Oturum içi komutlar: `/plan`, `/tasks`, `/context`, `/permissions`, `/model`, `/diff`, `/evidence`, `/cancel`, `/memory`, `/help` ([CLI deneyimi](../design/cli-experience.md)).

## 4. JSONL frame'leri

- stdout **yalnız** frame içerir; her satır `JSON.stringify(frame) + "\n"` (yalnız LF). İnsan metni, spinner ve log stderr'e gider. Okuyucular `readline` kullanmaz (U+2028/U+2029); `splitJsonlLines` yalnız LF'de böler, sondaki CR'ı tolere eder.
- Ortak alanlar: `schema_version: 1`, `run_id`, `seq` (frame sırası, 1'den, yoğun; event `seq`'inden bağımsız), `timestamp`, `type`, `data`.
- Tipler: `hello` (ilk frame: `protocol: synorch.jsonl`, `harness_version`, `session_id`, `policy_mode`, `stream_deltas`), `event` (redakte edilmiş tam `SessionEvent`), `delta` (yalnız `--stream-deltas` ile `ModelStreamEvent`; kümülatif snapshot yazılmaz), `result`, `error`.
- Dizi invariant'ları (`validateFrameSequence`): ilk frame `hello`; tam bir `result` veya `error`; terminal frame en sonda; `seq` 1..n; tüm frame'ler aynı `run_id`.
- JSONL tek yönlüdür. Stdin üzerinden onay/steer ayrı bir RPC modudur ve v1 kapsamı dışındadır.

## 5. Exit code'lar

| Kod | Ad | Harness hata kodları |
| --- | --- | --- |
| 0 | success | — (kabul edilmiş başarı) |
| 1 | internal | `internal`, `session_corrupt`, `store_write_failed` |
| 2 | usage | `usage_invalid`, `config_invalid` |
| 3 | approval | `approval_rejected`, `approval_unavailable` |
| 4 | provider | `provider_failed`, `tool_failed` |
| 5 | verification | `verification_failed`, `review_blocked`, `stale_packet` |
| 6 | policy | `policy_denied`, `sandbox_insufficient` |
| 7 | auth | `auth_required`, `auth_expired` |
| 8 | session_locked | `session_locked` |
| 9 | budget | `budget_exceeded` |
| 130 | cancelled | `cancelled` |

0–2 mevcut `syn` komutlarıyla aynı anlamdadır. `exitCodeFor(code)` totaldir (`HARNESS_ERROR_EXIT`).

## 6. Hata mesajı standardı

`HarnessErrorInfo` = `code`, `message` (ne oldu), `ids?` (hangi run/task/attempt/tool call), `workspace_effect (none|partial|unknown)`, `retry_safe`, `next_command?`. İnsan modunda aynı alanlar okunur biçimde stderr'e yazılır. Secret ve ham prompt hiçbir alanda yer almaz.

## 7. Örnekler

```yaml example=jsonl-frame
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 1
  timestamp: "2026-09-22T10:00:00Z"
  type: hello
  data: { protocol: synorch.jsonl, harness_version: "0.4.0", session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4, policy_mode: autonomous, stream_deltas: false }
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 2
  timestamp: "2026-09-22T10:00:01Z"
  type: event
  data:
    schema_version: 1
    event_id: evt_01K5T3Q8Z4X9V2M6N7P0R1S2TB
    session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4
    seq: 2
    event_version: 1
    timestamp: "2026-09-22T10:00:01Z"
    actor: { kind: orchestrator, role: orchestrator }
    run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
    type: run/state_changed
    data: { from: created, to: running, reason: "plan approved" }
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 3
  timestamp: "2026-09-22T10:20:00Z"
  type: result
  data:
    status: succeeded
    exit_code: 0
    summary: "1 task completed, review accepted"
    tasks: [{ task_id: task_01K5T3Q8Z4X9V2M6N7P0R1S2T6, state: completed }]
    usage: { input_tokens: 182000, output_tokens: 9100, source: provider-reported }
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 3
  timestamp: "2026-09-22T10:00:02Z"
  type: error
  data:
    code: approval_unavailable
    message: "provider-change requires a human decision; headless run cannot ask"
    ids: { run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
    workspace_effect: none
    retry_safe: true
    next_command: "syn run --policy ask ..."
    exit_code: 3
```

```yaml example=jsonl-frame invalid
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 9
  timestamp: "2026-09-22T10:00:02Z"
  type: result
  data: { status: succeeded, exit_code: 42, summary: done, tasks: [] }
- schema_version: 1
  run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  seq: 2
  timestamp: "2026-09-22T10:00:02Z"
  type: log
  data: { text: "human text on stdout" }
```

```yaml example=harness-error
code: session_locked
message: "session ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4 is held by pid 48122 on dev-laptop"
ids: { session_id: ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4 }
workspace_effect: none
retry_safe: true
next_command: "syn agent --fork ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4"
```
