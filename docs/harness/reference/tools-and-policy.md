# Referans: tools, policy ve sandbox (I3)

> Durum: `implemented`, 2026-09-22. Sahip: I3. Kod: `src/harness/tools/**`, `src/harness/policy/**`. Sözleşmeler: [tools](../contracts/tools.md), [policy ve onay](../contracts/policy-and-approval.md). Kararlar: [ADR-06](../decisions/ADR-06-sandbox.md), [ADR-08](../decisions/ADR-08-approval-policy.md), [ADR-15](../decisions/ADR-15-headless.md). Tasarım: [araçlar ve güvenlik](../design/tools-and-security.md).

Bu belge I3'ün **uyguladığı** davranışı anlatır. Sözleşmenin kendisi `src/harness/contracts/**` altındadır; burada implementasyon kararları, bilinen sınırlar ve tüketici modüllerin (I1 driver, I2 köprü, I4 orkestrasyon, I5 CLI) bilmesi gerekenler vardır.

## 1. Dışa açık fabrikalar

| Fabrika | Modül | Döndürdüğü |
| --- | --- | --- |
| `createPolicyEngine(options?)` | policy | `PolicyEngine` (`compute` + `evaluate`); `options.synorchHome` Synorch home yazma korumasını açar (composition root `home`'u verir) |
| `explainPermission(action, policy, options?)` | policy | `PolicyDecision` (`--explain-permission`, salt okunur); exec allowlist kararı (`exec-allowlisted`, `exec-not-allowlisted`, `exec-unconfined`) gerekçelerden biridir |
| `createHeadlessApprovalBroker(options?)` | policy | `ApprovalBroker` (yalnız reddeder) |
| `classifyCommand(argv, scope)` | policy | Yıkıcı/dış yazma/yazan komut sınıflandırması |
| `DESTRUCTIVE_COMMAND_RULES`, `EXTERNAL_WRITE_RULES` | policy | Veri tabloları (örnekleriyle) |
| `createToolRegistry(options?)` | tools | v1 yerleşik araçlarla `ToolRegistry` |
| `createToolGateway(deps)` | tools | `ToolGateway` |
| `probeSandbox(options?)` | tools | `Promise<SandboxReport>` |
| `createSandboxRunner(report)` | tools | `SandboxRunner` |

`createToolRegistry` seçenekleri: `builtins` (varsayılan `true`), `environment` (child env allowlist'inin okuduğu üst ortam, varsayılan `process.env`), `classifyCommand` (composition root policy modülündeki `classifyCommand`'ı buraya bağlar; böylece kaydedilen `NormalizedAction` `destructive`/`external-write` bilgisini zaten taşır), `control` (control araçlarının davranış callback'leri, §5).

`createToolGateway` bağımlılıkları: `events`, `blobs`, `registry`, `policy`, `approvals`, `sandbox` (plan tablosundaki küme) ve iki opsiyonel alan: `redactionValues` (I2 `ResolvedCredential.redactionValues()` birleşimi; hem çıktı redaksiyonu hem argümanda `secret-egress` reddi için), `onUpdate` (çalışan aracın redakte edilmiş ara çıktısı). `now` yalnız deterministik testler içindir.

`src/harness/tools/testing.ts` yalnız test çiftlerini içerir: `createMemoryEventStore` (her taslağı `sessionEventSchema` ile doğrular, `failWhen` ile append reddi simüle eder), `createMemoryBlobStore`, `createGatewayHarness`, `replayToolCallTransitions` (tool olaylarını sözleşmedeki `toolCall` durum makinesinden geçirir). Üretim kodu bunları kullanmaz.

Modül sınırı: `tools` ve `policy` birbirini import etmez (ADR-01). Gateway `PolicyEngine` arayüzünü enjeksiyonla alır. Yol eşleştirme sözleşmedeki tek eşleştiricidir (`matchesPathPattern`, `matchesAnyPathPattern`, `isAncestorOfAnyPattern`, `hasReservedSegment`; Dalga 2a'da iki yerel kopyanın yerine geçti). Karar yetkisi policy'dedir; tools eşleştiriciyi yalnız çok yollu okumaları (search, git çıktısı) ve eylem anı yeniden kontrolünü süzmek için kullanır.

## 2. Etkin politika (`compute`)

`effective = platform ∩ user ∩ workspace ∩ role ∩ task ∩ sandbox ∩ approval`. Uygulama kararları:

- **Mod:** `inputs.mode`, kullanıcı config'i ve workspace config'indeki `policy.mode` içinden en katısı (`ask` > `autonomous`). Workspace dosyası modu yalnız sıkılaştırabilir.
- **Rol tavanı** (`ROLE_EFFECT_CEILINGS`): orchestrator `exec: deny`, yazma yalnız `.ai/tasks/**`; explorer yazma/exec yok; reviewer exec var, yazma yok; implementer/debugger tümü. `control` her rolde açıktır; hangi control aracını görebileceğini `visible_to` belirler.
- **Yazma kapsamı:** packet `owned` listesinden; tüm workspace (`**`, `.`) ve rezerve (`.git`, `.synorch`) desenleri sessizce düşürülür (daraltmak her zaman güvenlidir). Kapsam boşsa `workspace-write: deny`.
- **Forbidden:** packet + kullanıcı + workspace birleşimi. Okunamayan bir forbidden deseni **düşürülmez**, `config_invalid` ile hesaplama durur (bir reddi düşürmek genişletmek olurdu).
- **Allowlist ve ağ:** `external_write_allowlist` ve `network` kullanıcı katmanından gelir; workspace katmanı bunları yalnız kesiştirir (repo içindeki bir dosya allowlist ekleyemez, ağ modunu yükseltemez).
- **Mod dönüşümü:** `ask` modunda `workspace-write`/`exec`/`external-write` → `ask`. `autonomous` modda `external-write` yalnız boş olmayan allowlist ile `allow`, aksi halde `deny`.
- **Sandbox:** `require_full_sandbox` (kullanıcı veya workspace) ve rapor `full` değilse `workspace-write` ve `exec` → `deny`.
- **Exec kısıtı:** `exec_confinement = execConfinementFor(sandbox.enforcement, mode)`: `full` → `full-sandbox`, aksi halde `autonomous` → `allowlist`, `ask` → `ask`. `verification_commands` = `taskScope.verification_commands` (I4 `worker-manager` packet'in `verification.commands` listesini verir), kırpılmış ve tekilleştirilmiş. İkisi de `policy/snapshot` v2 alanıdır.
- **Grant'ler** `approval` katmanı olarak digest'le kaydedilir, kapsamı veya etkileri **genişletmez**; eylem onayı gateway'de digest'e bağlanır (§4).
- Config şeması (`policyConfigSchema`) katıdır: `policy` altındaki bilinmeyen anahtar `config_invalid` verir. `policy_version` her hesaplamada `1`'dir; sürüm artırımı çağıranın (I4) sorumluluğundadır.
- Sonuç `effectivePolicySchema.parse` ile doğrulanır; şema invariant'ı bozulursa hesaplama throw eder.

## 3. Karar (`evaluate`)

Sıra: yollar → komut → ağ → etki matrisi. Herhangi bir `deny` kalıcıdır; `ask` yalnız hiçbir deny yoksa verilir. Hard rail varsa karar her iki modda da `deny`'dır ve ilk rail `rail` alanına yazılır.

- **Yazma yolu:** `.git/hooks/**` veya `.git/config` (hem leksik yolda hem kanonik realpath'te, duyarsız) → `reserved-path-write` + `git-hooks-or-config`; diğer rezerve segmentler → `reserved-path-write`; kanonik yolu (en derin var olan atanın `realpath`'i, Windows/macOS'ta harf katlanmış) Synorch home altında olan yazma → `reserved-path-write` + `synorch-home-write` — yalnız işçinin kendi workspace kökü home içindeyse (attempt worktree'si) o kökün altı serbesttir; forbidden ile eşleşme (duyarsız) veya write_scope dışı (duyarlı) → `write-outside-scope`. (Eski, hiçbir zaman eşleşmeyen "policy katmanı kaynağı" kontrolü kaldırıldı; policy dosyaları rezerve segmentler ve Synorch home koruması ile korunur.)
- **Okuma yolu:** forbidden → deny; read_scope dışı → deny. Bir read deseninin üstündeki dizinler (`.`/`src` için `src/auth/**`) listelenebilir.
- **Komut:** `classifyCommand` her argv'yi kendisi yeniden sınıflandırır; aracın `destructive: true` ipucu yalnız ekleyebilir, `false` hiçbir bulguyu silmez. Sınıflandırıcı `external-write` bulursa etki `exec`'ten `external-write`'a yükselir. Read-only rolde (explorer, reviewer) dosya yazabilen komut (shell sarmalayıcıları, yönlendirme, `git commit`, paket kurulumları, `node -e` gibi satır içi kod, PowerShell `Set-Content` vb.) → deny.
- **Exec allowlist (`policy/exec-allowlist.ts`, varsayılan-ret):** kötü komutları saymaz; yalnız olumlu tanınan, tam ayrıştırılmış argv çalışır.
  - *Read-only işçiler* (explorer, reviewer, owned path'i olmayan rca-only debugger), sandbox seviyesinden bağımsız: yalnız dosya yazan bayrak içermeyen yazmayan git alt komutları (`status`, `diff`, `log`, `show`, `blame`, `ls-files`, `rev-parse`; alt komut ilk argüman olmalı, `--output`/`--ext-diff` yok), dizin listeleme/dosya görüntüleme (`ls`, `dir`, `tree`, `cat`, `type`, `head`, `tail`, `wc`, `stat`, `file`, `pwd`; argümanlar workspace dışını adlandıramaz), `rg`/`grep`/`findstr` (`rg --pre` yok) ve birebir `verification_commands`. Diğer her şey `role` katmanında `exec-not-allowlisted` (`policy_denied`).
  - *Sandbox `full` değilse* (Windows'ta bugün her zaman) tüm roller `autonomous` modda yalnız: birebir `verification_commands`, kullanıcı `external_write_allowlist`'inin birebir (yıldızsız) girdileri, read-only liste ve incelenmiş build/test listesi — paket yöneticisi (`npm|pnpm|yarn|bun`) `test`/`build`/`typecheck`/`run <script>`/`install --frozen-lockfile` (`npm ci`), `node --test` (yalnız `--test-*` bayrakları ve dosyalar), `tsc` (`-p`, `--noEmit`, `-b` …), yazmayan git alt komutları + workspace içinde `git add`/`git commit -m`, `dotnet build|test`, `mvn test`, `gradle test`, `cargo build|test`, `go build|test`, `pytest`. Script kabuğunu/config'i değiştiren paket yöneticisi bayrakları (`--script-shell`, `--config.*`, `-C` …), `go -exec/-toolexec`, `cargo --config`, `gradle --init-script` ve workspace dışını adlandıran argümanlar (mutlak, sürücü, UNC, `~`, `..`) listeyi düşürür. Satır içi kodla çağrılan yorumlayıcı (node/bun `-e|-p|--eval|--print`, python `-c`, powershell/pwsh `-Command|-EncodedCommand`, bash/sh `-c` kümeleri, `cmd /c`, `deno eval`, ruby `-e`, perl `-e|-E`) listede değildir. Program adı düz bir kelime değilse (`$SHELL`, `./x`, `C:\x\node.exe`) komut sınıflandırılamaz. Listede olmayan komut `autonomous` modda `sandbox` katmanında `exec-not-allowlisted` ile reddedilir (gateway `sandbox_insufficient`); `ask` modunda `exec-unconfined` ile sorulur. Başka bir katman zaten reddettiyse sandbox gerekçesi eklenmez (daha açık kod maskelenmez).
  - *Sandbox `full`*: yazan roller için davranış değişmez.
  - Birebir eşleşme: doğrulama dizesi POSIX kurallarıyla ayrıştırılır; ikame, yönlendirme veya pipe içeren dize hiçbir argv ile eşleşmez; `a && b` biçimindeki her basit komut ayrı ayrı eşleşebilir. Windows'ta `.cmd` shim'leri (`pnpm`, `npm`) doğrudan çalıştırılamadığından (§8) bu makinelerde build komutları pratikte birebir doğrulama komutu olarak gelir.
- **Git ayarları:** `git config`'in yazma biçimleri (varsayılan-ret: yalnız `--get*`, `--list`, `get`/`list` veya tek anahtar okuma sayılır) ve `core.hooksPath` içeren her git çağrısı (`git -c core.hooksPath=…` dahil) `reserved-path-write` bulgusudur.
- **Ağ:** `network_hosts` boş değilse `deny` modunda red, `allowlist` modunda liste dışı host red.
- **Allowlist eşleşmesi** kelime kelime tam argv'dir; girdinin son kelimesi `*` ise önek eşleşmesidir. `["git","push origin harness"]` gibi birleştirme hileleri eşleşmez.
- Glob anlamı: `**` sıfır veya daha çok segment, `*`/`?` segment içi, `[...]`/`{a,b}` segment içi. Glob içermeyen desen kendisini ve altındaki her şeyi kapsar. Grant eşleşmesi büyük/küçük harfe duyarlıdır (duyarsız bir diskte bu yalnız daraltır); red eşleşmeleri duyarsızdır.

## 4. Gateway hattı ve olaylar

```text
policy/snapshot (her yeni policy digest'inde bir kez)
tool/call_proposed → lookup → zod → normalize → görünürlük + credential değeri + evaluate
tool/policy_decided → [approval/requested → approval/decided] → sandbox kontrolü
tool/execution_started → execute (timeout + iptal) → redaksiyon → sınırlama → tool/result_recorded
```

- Sonraki tüm olayların `causation_seq`'i `tool/call_proposed`'un `seq`'idir. Actor `orchestrator` veya `worker` + rol + attempt'tir.
- **Durum makinesi:** `tool/execution_started`'tan önce reddedilen her çağrı (bilinmeyen araç, geçersiz argüman, normalize hatası, policy, onay, sandbox) `denied` ile, kullanıcı iptali `cancelled` ile biter; `succeeded`/`failed` yalnız çalışmış çağrıya yazılır. `replayToolCallTransitions` testleri her senaryoda olay dizisini `validateTransition("toolCall", …)` ile doğrular (I1 projection'ı ile aynı kural).
- **Append reddi:** `policy/snapshot` veya `tool/call_proposed` yazılamazsa hiçbir şey başlatılmaz ve olay bırakılmaz (driver bunu `write_failed` olarak görür). Sonraki olaylardan biri yazılamazsa çağrı o noktada durur; `tool/execution_started` yazılamadıysa araç çalışmaz. Sonuç kaydı yazılamazsa dönen durum `interrupted`'dır (recovery `tool/interrupted` yazar).
- **Kaçan yol:** workspace içinde ifade edilemeyen yol (`..` kaçışı, dışarıdaki mutlak yol, UNC, dışarı çıkan link, sarkan link, çoklu hard link) normalize sırasında `ToolScopeViolation` (`escape {requested, access, reason}`) ile raporlanır. Gateway eylemi `paths: []` ve `escapes: [...]` ile kurar (`requested` redakte edilir), PolicyEngine'e değerlendirtir ve `tool/policy_decided` (v2) olarak **kaydeder**; motor yazmada `write-outside-scope` + `path-escape`, okumada rail'siz `read-outside-workspace` ile reddeder, sonuç `path_outside_scope` olur. Böylece her ret denetim kaydındadır (§11 CCR-1).
- **Görünürlük:** rol `visible_to` içinde değilse `tool-not-visible` (role katmanı) ile reddedilir; bu karar da `tool/policy_decided` olarak kaydedilir.
- **Onay:** yalnız `ask` kararında. İstek `subject_kind: action`, `subject_digest = action_digest`, `scope: once`. Yanıt şemaya uymuyorsa veya başka bir `approval_id`/`subject_digest` taşıyorsa broker adına `cancelled` kaydedilir ve eylem çalışmaz (AC-5). `allowed-for-scope` aynı oturumda aynı `action_digest` + `policy_digest` çifti için tekrar sorulmaz; argüman değişince digest değişir ve yeni karar gerekir. `allowed-once` önbelleğe alınmaz. Hata kodları: `rejected` → `approval_rejected`, `unavailable`/`expired` → `approval_unavailable`, `cancelled` → `cancelled`.
- **Sandbox kontrolü:** etkin seviye = canlı `probe()` ile policy snapshot'ındaki seviyenin zayıfı. `require_full_sandbox` iken bu `full` değilse ve etki `workspace-write`/`exec` ise `sandbox_insufficient` (policy sandbox katmanında reddettiyse de aynı kod). Seviye her `tool/execution_started.sandbox_enforcement` alanına yazılır.
- **Timeout:** `metadata.timeout_ms` dolunca araç sinyali iptal edilir ve sonuç `timeout` olur.

## 5. Yerleşik araçlar

| Ad | Etki | Roller | Uygulama notu |
| --- | --- | --- | --- |
| `read_file` | read | hepsi | 1 MiB sınır, NUL içeren dosya binary sayılır, `offset`/`limit` satır bazlı |
| `list_dir` | read | hepsi | `depth` 1–4; linkler `@` ile gösterilir, izlenmez; forbidden girdiler gizlenir |
| `search` | read | hepsi | JS regex (`u`), `glob` filtresi; `.git`, `node_modules`, `.synorch` atlanır; linkler izlenmez; sonuçlar read_scope/forbidden ile süzülür; 2 MiB üstü dosya atlanır |
| `git_status` | read | hepsi | `--porcelain=v1`; görev kapsamındaki değişiklikler ile kullanıcı/diğer görev değişiklikleri ayrı bölümde |
| `git_diff` | read | hepsi | `--no-ext-diff --no-textconv`; forbidden desenler `:(exclude,glob)` ile hariç |
| `write_file` | workspace-write | implementer, debugger | Var olan dosya için `expected_digest` (ham baytların sha256'sı) zorunlu; yeni dosyada boş/null |
| `apply_patch` | workspace-write | implementer, debugger, orchestrator | Katı unified diff (fuzz yok), dokunulan her yol için `expected` digest (yeni dosyada `null`), CRLF korunur, çok dosyada hata olursa yazılanlar geri alınır |
| `exec` | exec | implementer, debugger, reviewer | argv (shell yok), `cwd` workspace içinde, env allowlist, `timeout_ms` ≤ 600 s, 1 MiB çıktı üst sınırı |
| `ask_user` | control | orchestrator | `control.askUser` yoksa `approval_unavailable` |
| `task_spawn`, `task_status` | control | orchestrator | Yalnız tanım; davranış `control.taskSpawn`/`taskStatus` (I4). Packet'i I4 doğrular |
| `memory_propose` | control | hepsi | Yalnız öneri; davranış `control.memoryPropose` (I6) |
| `task_report` | control | explorer, implementer, debugger | Girdi `taskReportInputSchema`; callback opsiyonel (`control.taskReport`), yoksa `report recorded` onayı |
| `review_report` | control | reviewer | Girdi `reviewReportInputSchema`; callback opsiyonel |
| `plan_propose` | control | orchestrator | Girdi `planProposalSchema`; callback opsiyonel |

Callback bağlanmamış control aracı `execution_failed` döner; rapor araçları bunun istisnasıdır: kayıtlı, doğrulanmış çağrının kendisi rapordur ve I4 onu attempt günlüğünden okur. Tüm araçların `descriptor().input_schema`'sı zod şemasından `z.toJSONSchema` ile üretilir.

## 6. Yol güvenliği (AC-1)

`resolveWorkspacePath(root, aday, access)` eylem anında çalışır:

1. NUL, boş, UNC/cihaz yolu (`\\server`, `//server`, `\\?\`, `\\.\`) → red. Eşleştirmeden önce Windows'un sessizce yeniden yazdığı veya farklı yorumladığı biçimler de reddedilir: nokta veya boşlukla biten segment (`src.`, `a /b`), `:` içeren segment (alternatif veri akışı `file:stream`, sürücüye göreli `C:x`; yalnız mutlak yolun sürücüsü serbest), ayrılmış cihaz adları (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`, uzantılı biçimleri dahil, ör. `nul.txt`).
2. Leksik çözüm (`path.resolve`) kökün dışındaysa → red. Windows'ta `path.relative` büyük/küçük harfe duyarsızdır.
3. Var olan her segment `realpath` ile çözülür (symlink ve junction); kanonik kökün dışına çıkan her ara sonuç → red. Sarkan link → red. `~<rakam>` içeren (8.3 kısa ad) ve realpath uzun adı farklı olan segment → red.
4. Kanonik göreli yol dosya sisteminden gelir: Windows'ta `SRC/AUTH/x.ts` var olan `src/auth` üzerinden `src/auth/x.ts` olur. Var olmayan segmentler verildiği gibi kalır (Linux'ta `SRC/...` bu yüzden kapsam dışıdır).
5. Yazmada var olan dosyanın `nlink > 1` olması → red (diğer adları kapsam dışında olabilir).

**TOCTOU:** `normalize` çözdüğü kanonik yolu `ToolCallId` ile hafızaya alır (`NormalizedMemo`, sınırlı). `execute` yolu yeniden çözer; sonuç policy'nin gördüğüyle birebir aynı değilse veya artık write_scope dışında/forbidden/rezerve ise `path_outside_scope`. Yazma geçici dosya + `rename` ile yapılır; `rename` dizin girdisini değiştirdiği için sonradan yerleştirilen hard link yazmayı dışarı yönlendiremez; rename'den hemen önce hedef symlink olmuşsa yazma iptal edilir.

## 7. Yıkıcı komut sınıflandırması (AC-3)

`DESTRUCTIVE_COMMAND_RULES` veri tablosudur: her kural `code`, `programs`, bir argüman yüklemi ve testlerin tek tek doğruladığı `examples` taşır. Liste büyüyebilir; kural veya örnek silmek rail'i zayıflatır ve ADR gerektirir. Kapsanan sınıflar: özyinelemeli silme (`rm -rf`, `Remove-Item -Recurse`, `del /s`, `rd /s`, `rimraf`, `find -delete`), güvenli silme (`shred`, `sdelete`), `git push --force/--force-with-lease/--mirror/--delete/+ref/:ref`, `git reset --hard`, `git clean -f`, çalışma ağacını ezen `git checkout/restore/switch` biçimleri, `git branch -D`, geçmiş yeniden yazma (`filter-branch`, `filter-repo`, `reflog expire`, `stash clear`, `gc --prune=now`), paket yayınlama, disk biçimlendirme/bölümleme, `dd of=/dev/…`, yetki yükseltme (`sudo`, `runas`, `Start-Process -Verb RunAs` …), kapsam dışına özyinelemeli izin değişikliği (`chmod -R`, `icacls /grant`, `takeown /r`), uzak betik çalıştırma (`curl … | sh`, `iwr … | iex`), container/volume prune, sistem servisleri, registry ve gölge kopya silme.

- Özyinelemeli silme ve izin değişikliği **kapsama duyarlıdır**: her hedef düz, göreli ve write_scope içinde ise yıkıcı değildir (`rm -rf src/auth/tmp`). Değişken (`$HOME`, `%USERPROFILE%`), `~`, mutlak/UNC yol, `..`, `.`, önek içermeyen glob veya hedefsiz (pipe'tan beslenen) biçim kapsam dışı sayılır.
- Program adı küçük harfe çevrilmiş basename'dir (`.exe/.cmd/.bat/.com/.ps1` atılır).
- **Sarmalayıcılar:** `bash/sh/zsh… -c`, `cmd /c|/k`, `powershell/pwsh -Command`, konumsal komut ve `-EncodedCommand` (UTF-16LE base64 çözülür) içindeki betik ayrıştırılır; her pipeline'daki her komut ayrı sınıflandırılır. Kaçış kuralları lehçeye göredir (POSIX `\`, cmd `^`, PowerShell backtick). `env`, `nohup`, `time`, `nice`, `timeout`, `xargs`, `sudo`, `npx`, `pnpm dlx`, `wsl`, `start` önekleri açılır. `git -c alias.x='!…'` ve komut çalıştıran git ayarları (`core.sshCommand`, `core.pager` …) ile `find -exec …` içindeki komutlar da sınıflandırılır. Dört seviyeden derin shell iç içeliği veya sekizden fazla sarmalayıcı katmanı yıkıcı sayılır (fail closed).
- Aynı analiz diğer argv rail'lerini de üretir: `secret-egress` (ağ programına secret biçimli değer, `.env`/anahtar dosyası veya `$…TOKEN` gibi değişken; `env | curl` gibi pipe), `credential-access` (Synorch credential dosyası, keychain CLI'ları), `foreign-credential-store` (`FORBIDDEN_CREDENTIAL_SOURCES`), `policy-self-modification` (`~/.synorch/config…`, `syn config`).
- `EXTERNAL_WRITE_RULES`: normal `git push`, GitHub CLI yazma komutları, gövdeli/yazma metotlu HTTP istekleri, uzak kopya, `ssh`, registry push, bulut/cluster yazmaları → etki `external-write` (autonomous modda allowlist gerekir).

## 8. Process, env ve sandbox (AC-6, AC-8)

- **Spawn:** `shell: false`, `stdio: pipe` (konsol kod sayfası mirası yok), `windowsHide`, POSIX'te `detached` (kendi process grubu). Windows'ta `.cmd/.bat` doğrudan çalıştırılamaz (Node güvenlik düzeltmesi); `cmd /c` ile çağrılmalıdır, bu da sınıflandırıcıdan geçer.
- **İptal ve timeout:** Windows'ta `taskkill /PID <pid> /T /F`; POSIX'te gruba SIGINT, 1,5 s sonra SIGKILL. Pipe'lar 5 s içinde kapanmazsa sonuç zorla tamamlanır. `ProcessResult.termination` bunu açıkça bildirir (`exited | timeout | cancelled | spawn-failed`, başlatılamayan süreçte `spawnError`); iptal edilen `exec` `cancelled`, süre aşımı `timeout`, başlatılamayan süreç `execution_failed` döner; AC-8 testi torunu olan bir süreç ağacının tamamen sonlandığını pid kontrolüyle doğrular.
- **Env:** yalnız `INHERITED_ENV_ALLOWLIST` (PATH, sistem kökleri, TEMP, HOME/USERPROFILE, dil/saat dilimi, CI …) üst ortamdan geçer. Model tarafından verilen `env` loader/shell kancası/yol/credential değişkenlerini (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `GIT_SSH_COMMAND`, `BRIDGE_STRIPPED_ENV` …) ayarlayamaz → `invalid_arguments`.
- **Stdin:** shell programlarına (`bash`, `cmd`, `powershell` …) stdin ile betik verilemez; betik policy'nin görebilmesi için `-c`/`/c`/`-Command` ile satır içi verilmelidir.
- **Çıktı:** stdout+stderr ortak `output_limit_bytes` bütçesi; fazlası atılır, `truncated: true`.
- **Probe:** Linux `bwrap` gerçek bir namespace denemesiyle, macOS `/usr/bin/sandbox-exec` bir profil denemesiyle `full`; bulunamazsa `policy-only` (`partial`). Windows v1 her zaman `policy-only` (`filesystem: partial`, `network: unavailable`, `process: partial`). Probe exception'ı `backend: none`, `unavailable` (fail closed); bilinmeyen platform `unavailable`.
- **Runner:** `full` bubblewrap'te `--ro-bind / /`, write root'lar için `--bind`, `--unshare-all` (ağ izinliyse `--share-net`), `--die-with-parent --new-session --chdir`; sandbox-exec'te `(deny file-write*)` + write root'lar + geçici dizinler, ağ kapalıysa `(deny network*)`. Read-only rollerde write root listesi boştur. `policy-only`'de argv olduğu gibi çalışır.

## 9. Redaksiyon ve sınırlama (AC-7)

- Gateway her sonucu (metin ve hata mesajı) blob'a veya olaya yazmadan **önce** redakte eder: önce `redactionValues()` tam değerleri (≥ 6 karakter, uzundan kısaya), sonra biçimler (`sk-…`, `gh*_`, `github_pat_`, `glpat-`, `npm_`, `AKIA…`, `xox?-`, private key blokları, JWT, `Authorization: Bearer …`, URL içi parola, `*_TOKEN=`/`*SECRET*=`/`*PASSWORD*=` atamaları). Sayım `redactions` alanına eklenir.
- Redakte metin 16 KiB'ı aşarsa tamamı `text/plain; charset=utf-8` blob olarak yazılır, satır içinde ~12 KiB baş + ~3 KiB son + blob digest'i içeren işaret kalır. Blob yazılamazsa metin 16 KiB'a kesilir ve `truncated: true`.
- Argümanların kanonik JSON'u 16 KiB'ı aşarsa redakte edilmiş kopyası `args_blob` olarak saklanır; `args_digest` ham argümanların digest'idir.
- Argümanlarda canlı bir credential değeri geçiyorsa çağrı policy'ye gitmeden `secret-egress` rail'i ile reddedilir.

## 10. Kabul ölçütü → test

| AC | Test dosyası | Testler |
| --- | --- | --- |
| AC-1 | `tests/harness-tools-paths.test.ts` | `AC-1: …` (15 test: `..`, mutlak, UNC, junction/dizin linki, forbidden'a link, dosya symlink'i, sarkan link, büyük/küçük harf, hard link, apply_patch, TOCTOU, resolver) |
| AC-2 | `tests/harness-tools-gateway.test.ts`, `tests/harness-policy-engine.test.ts` | `AC-2: explorer and reviewer cannot write …` |
| AC-3 | `tests/harness-policy-destructive.test.ts` | Tablo örnekleri her iki modda; bash/cmd/PowerShell/encoded/önekli biçimler; kapsam içi negatifler; git alias ve find -exec |
| AC-4 | gateway + engine testleri | `AC-4: autonomous external-write …`, `AC-4: ask mode asks; the headless broker …`, `AC-4: the headless broker only refuses …` |
| AC-5 | `tests/harness-tools-gateway.test.ts` | `AC-5: an approval binds to one action digest …`, `AC-5: allowed-once is not reused …` |
| AC-6 | gateway + engine testleri | `AC-6: require_full_sandbox …` (policy ve gateway), canlı probe ile snapshot farkı, `execution_started` seviyesi |
| AC-7 | `tests/harness-tools-gateway.test.ts` | `AC-7: output above 16 KiB …`, `AC-7: secrets in output …`, `AC-7: arguments carrying a live credential …` |
| AC-8 | `tests/harness-tools-exec.test.ts` | `AC-8: cancelling exec terminates the whole child tree …` |
| Güvenlik sertleştirmesi | `tests/harness-security-policy.test.ts` | `SEC-H1 …` (read-only roller allowlist dışı exec çalıştıramaz, `git status` çalıştırabilir; gateway'de spawn yok), `SEC-H3 …` (kısmi sandbox: doğrulama komutu ve `pnpm test` izinli, satır içi yorumlayıcı ve bilinmeyen program reddedilir, `ask` sorar, `full` değişmez; gateway `sandbox_insufficient`), `SEC-H2 …` (opak satır içi betik ve düz olmayan program adı), `SEC-L1 …` (her reddedilen yol biçimi, 8.3 kısa ad), `SEC-L3 …` (Synorch home, kendi worktree, `.git/hooks`/`.git/config`, `git config`/`core.hooksPath`) |

## 11. Bilinen sınırlar

- Windows v1'de OS dosya sistemi sandbox'ı yoktur. Bu yüzden `exec` kısmi sandbox'ta allowlist ile sınırlanır (§3): yalnız birebir doğrulama komutları ve incelenmiş build/test komutları çalışır. **Kalan risk:** allowlist'teki build/test komutları (`pnpm test`, `pnpm run <script>`, `node --test`, `cargo test`, `go test`, `pytest`, `git commit` hook'ları …) yine depo kodunu çalıştırır ve bu kod kapsam dışına yazabilir, ağa çıkabilir; doğrulama komutlarını planı yazan orchestrator (model) seçer. Exec'i gerçekten yalnız tam bir OS sandbox'ı (bubblewrap, sandbox-exec; Windows'ta sonraki sürümde AppContainer/job object) sınırlar. `require_full_sandbox` görevleri Windows'ta durur (ADR-06).
- Read-only listedeki görüntüleme/arama komutlarının argümanları workspace dışını adlandıramaz, ama read_scope/forbidden ile süzülmezler (yerleşik `read_file`/`search` süzer).
- `rm -rf` hedefi owned içindeki bir junction ise hedef leksik olarak kapsam içinde görünür; bazı araçlar (eski PowerShell sürümleri) junction'ın içine inebilir.
- Yeniden kontrol ile `rename` arasındaki çok kısa pencerede ana dizinin junction ile değiştirilmesi teorik olarak mümkündür (dosya tanıtıcısı tabanlı yazma sonraki sürüm).
- `search` kullanıcı regex'ini çalıştırır; satır başına 2000 karakter sınırı dışında ReDoS koruması yoktur.

## 12. Sözleşme değişiklik istekleri (Dalga 2a sonucu)

| # | İstek | Karar |
| --- | --- | --- |
| CCR-1 | Workspace dışı yollar `NormalizedAction`'da ifade edilemiyor; kaçış retleri `tool/policy_decided` olmadan kalıyor | **Çözüldü:** `NormalizedAction.escapes?` (`PathEscape {requested, access, reason}`), `PATH_ESCAPE_REASON_CODE`; `tool/policy_decided` v2. Gateway her kaçışı motora değerlendirtip kaydeder. |
| CCR-2 | `SandboxRunner.run` sonucu iptal ve spawn hatasını açıkça ifade etmeli | **Çözüldü:** `ProcessResult.termination` + `spawnError` (`timedOut` kaldırıldı); `RunProcessResult` yerel genişletmesi silindi. |
| — | İki yerel glob eşleştiricisi (`policy/path-scope.ts`, `tools/scope-match.ts`) | **Çözüldü:** saf eşleştirici `contracts/paths.ts`'e taşındı; iki kopya silindi. |
| — | Yapılandırılmış rapor araçları (I4 CCR-5) | **Çözüldü:** `task_report`, `review_report`, `plan_propose` kayıtta (§5). |
