# Araç hattı, izin ve güvenlik sınırları

> Statü: öneri. Referanslar: [DeepSeek tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools), [approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval), [sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox), [OMP approval](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md), [Claude permissions](https://code.claude.com/docs/en/permissions).

## Her tool call aynı hattan geçer

```text
model call → JSON parse/schema validate → canonicalize args/path/URL
           → role/task/policy evaluation → approval (gerekiyorsa)
           → sandbox capability check → execute with timeout/cancel
           → redact + bound output → durable result/audit → model
```

Tool ismi veya prompt metni policy'yi atlayamaz. Shell, MCP, extension, browser, git ve worker-spawn dahil tüm eylemler gateway'e kaydedilir. Custom tool bilinmiyorsa varsayılanı yüksek risk ve `ask/deny` olur. Tool metadata: id/versiyon, JSON schema, etki sınıfı (`read`, `workspace-write`, `exec`, `external-write`), idempotency, network gereksinimi, çıktı sınırı, timeout, cancellation desteği.

## İzin ve sandbox ayrı kavramlar

- **Policy:** Bu rol ve task bu eylemi isteyebilir mi?
- **Approval:** Kullanıcı bu somut eylemi/onay kapsamını kabul etti mi?
- **Sandbox:** Process eylemi teknik olarak sadece tanımlı path/ağ/process sınırında yapabilir mi?

Bir katmanın `allow` kararı diğerini genişletmez. Sandbox backend'i bu host'ta sadece `partial` koruma sağlıyorsa açıkça raporlanır; yüksek riskli iş tam enforcement gerektiriyorsa durur. DeepSeek'in [sandbox referansı](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox) platform enforcement düzeyini raporlama fikri için iyi örnektir. Dosya path'leri lexical normalize ve `realpath`/junction/symlink çözümüyle kontrol edilir; izin yalnızca `cwd` string'ine güvenmez. Windows shell quoting ve komut ayrıştırma için ayrı test matrisi gerekir.

## Onay nesnesi

`approvalId`, `runId`, `taskId`, `actionDigest`, çözülmüş args/etki özeti, scope, zaman ve sonucu taşır. Sonuçlar `allowed-once`, `rejected`, `cancelled`, `unavailable` olarak ayrılır; son üçü eylemi çalıştırmaz. Etkileşimsiz mod `unavailable` durumunda fail-closed davranır. Onay aynı digest dışındaki eyleme veya yeni kapsam/credential'a taşınmaz. Geniş izin preset'leri ancak açık kullanıcı yapılandırmasıyla uygulanır; hook ya da model çıktısı kendiliğinden izin kaynağı olamaz.

## İlk tool kümesi

| Tool | Gerekçe | Temel sınır |
| --- | --- | --- |
| `read`/`search` | Kaynak keşfi | Path scope, boyut, binary ve secret redaksiyonu |
| `patch` | Deterministik değişiklik | Beklenen eski içerik/digest; atomic write |
| `exec` | Test/build ve gerekli shell | Argv/CWD/env ayrımı, timeout, sandbox, output cap |
| `git_status`/`git_diff` | Değişiklik ve review kanıtı | Read-only; kullanıcı değişikliklerini koru |
| `task_spawn`/`task_result` | Synorch delegasyonu | DAG, bütçe, path ownership, worker rolü |
| `ask_user` | Eksik bilgi ve onay | UI/machine modu sınırı, kayıt |

MCP, web ve LSP ilk sürüme ihtiyaçla eklenebilir. MCP'nin [resmi mimarisi](https://modelcontextprotocol.io/specification/2025-06-18/architecture) harici server ile client arasında açık protokol sunar; server'ın bildirdiği tool açıklaması güvenilir policy değildir. MCP tool'ları da yukarıdaki gateway'den geçer.

## Tehditler ve karşılıklar

| Tehdit | Runtime karşılığı |
| --- | --- |
| Repo dokümanındaki prompt injection | Untrusted kaynak etiketi; policy/system önceliğini değiştirmez |
| Tool çıktısındaki gizli token | Env ayrımı, redaction, log/blob öncesi filtre, varsayılan dış ağ kısıtı |
| Shell ile kapsam dışı dosya yazma | OS sandbox, gerçek path check, worktree; yalnızca regex onayı yeterli değil |
| Symlink/junction escape | Eylem anında çözülmüş yol ve root kontrolü; TOCTOU testi |
| Sonsuz agent/tool döngüsü | Step, süre, maliyet, child sayısı limitleri; no-progress algılama |
| Yan etkili çağrının crash sonrası tekrarı | `ToolCallId`/idempotency key; uncertain state ve kullanıcı kararı |
| Tainted reviewer | Ayrı context, sabit diff/artifact, bağımsız kaynak/test gözlemi |
| Üçüncü taraf plugin kodu | İmzalı/digested kaynak, kapalı yetki manifesti, process izolasyonu kararı |

## CLI'da görünürlük

`doctor` etkili sandbox/permission seviyesini, provider capability'sini, çözülen politika kaynağını ve hangi garantinin uygulanamadığını raporlamalı. `--explain-permission <tool> <args>` benzeri salt okunur tanılama, bir çağrının neden allow/ask/deny alacağını göstermeli. Güvenlik iddiası pazarlama cümlesi değil, test edilebilir invariant olmalı.
