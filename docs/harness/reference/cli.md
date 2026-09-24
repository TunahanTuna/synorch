# CLI başvurusu: runtime komutları, renderer'lar ve JSONL

> Durum: I5 Aşama A (paralel) teslimi 2026-09-22; Aşama B (runtime entegrasyonu, composition root, uçtan uca komutlar) 2026-09-23; Dalga 3 boşluk kapatma (kanonik `.ai/` → runtime, `ask_user`/`task_spawn`/`task_status`, exit 4/5 ayrımı, steer ve yüksek risk e2e) 2026-09-23. Sözleşme: [CLI ve JSONL](../contracts/cli-and-jsonl.md). Kararlar: [ADR-01](../decisions/ADR-01-package-boundary.md), [ADR-04](../decisions/ADR-04-terminal-renderer.md), [ADR-15](../decisions/ADR-15-headless.md). Kod: `src/cli.ts`, `src/harness/cli/`, `src/harness/tui/`.

Bu belge Aşama A'da kesinleşen davranışı (argüman ayrıştırma, yardım metinleri, exit code'lar, renderer ve renk seçimi, üç renderer, terminal yaşam döngüsü, §1–§9) ve Aşama B'de eklenen runtime bağlantısını (§10–§16) anlatır: `createRuntime()` composition root'u, yapılandırma katmanları ve her runtime komutunun gerçek implementasyonlarla uçtan uca davranışı.

## 1. Mevcut komutlarla sınır

- `syn inspect`, `syn init`, `syn sync`, `syn doctor` (ve `syn --help`, `syn --version`, bilinmeyen komut hatası) bayt bayt aynıdır. Kanıt: `tests/cli-legacy-snapshot.test.ts`, fixture `tests/fixtures/cli/legacy-snapshot.json` 6be6748'deki özgün CLI'dan, `src/cli.ts` değiştirilmeden **önce** alındı. Karşılaştırmada yalnız geçici hedef dizin (`<TARGET>`, adı `<TARGET_NAME>`) maskelenir ve yol ayırıcıları tek biçime indirilir; böylece aynı fixture her işletim sisteminde geçerlidir.
- `src/cli.ts` yalnız şu durumda `await import("./harness/cli/index.ts")` yapar: ilk argüman `agent`, `run`, `runs`, `show`, `login`, `logout`, `auth`, `memory` ise veya komut `doctor` ve `--` öncesinde `--runtime` varsa. Diğer her yol eski koddur; runtime modülleri (pi-tui dahil) yüklenmez.
- Üst düzey `syn --help` Aşama B'de **bilinçli olarak** değişti: yeni runtime komutlarını listeleyen bir "Runtime commands" bölümü eklendi. Legacy fixture'da yalnız bu yardım metnini taşıyan dört adım güncellendi (`top-level/help`, `help-short`, `no-arguments` stdout'u ve `unknown-command` stderr'i); diğer her çıktı ve exit code bayt bayt aynıdır. SEC-N1 ile aynı dört adımda bu bölüme yalnız `trust [--revoke]` satırı eklendi. Runtime komutları ayrıntıyı `syn <komut> --help` ile belgeler.

## 2. Komutlar

| Komut | Ayrıştırma kuralları |
| --- | --- |
| `syn agent [--resume <ses>] [--fork <ses>[@seq]]` | `--resume` ve `--fork` birlikte kullanılamaz; kimlikler `ses_<ULID>`, `seq` pozitif tamsayı; konumsal argüman yok. |
| `syn run "<hedef>" [--mode jsonl \| --json] [--stream-deltas] [--trust-workspace]` | Tam bir hedef (tırnaklı); `-` hedefi stdin'den okur (Aşama B). `--mode` yalnız `jsonl` alır; `--stream-deltas` JSONL ister; `--plain` JSONL ile birleşmez. `--trust-workspace` yalnız `run`'da vardır (`syn agent` reddeder). |
| `syn runs [--json]` | Konumsal argüman yok. |
| `syn show <run_…\|ses_…> [--json]` | Tam bir run veya session kimliği. |
| `syn doctor --runtime [--probe-model] [--json]` | `--runtime` olmadan runtime doctor çalışmaz (eski `doctor` devreye girer). |
| `syn login <provider> [--method oauth-subscription\|api-key\|cli-bridge] [--profile <ad>] [--device-code]` | Provider ve profil kebab-case; ayrıştırılmış argümanlar I2'nin `authCommand`'ına ham haliyle aktarılır. |
| `syn logout <provider> [--profile <ad>]` | Aynı doğrulama. |
| `syn auth status [--json]` | Tek alt komut `status`. |
| `syn memory status\|search\|show\|related\|review\|accept\|reject\|open\|reindex …` | Alt komut adı doğrulanır; geri kalan argümanlar I6'nın `memoryCommand`'ına aynen gider. |
| `syn trust [--revoke] [--target <path>]` | Konumsal argüman yok; bilinmeyen bayrak usage hatası. |
| `syn config [list [--json] \| get <anahtar> [--json] \| set <anahtar> <değer> \| unset <anahtar> \| edit \| path]` | Alt komut yoksa `list`; bilinmeyen alt komut en yakın öneriyle usage hatası (`ls`, `rm`, `open` takma adları). `--json` yalnız `list`/`get`. Bkz. §11.1. |

Ortak bayraklar: `-t, --target <path>`, `--plain`, `--color always|never|auto`, `-h, --help`. Yalnız `agent` ve `run`: `--policy autonomous|ask` (varsayılan `autonomous`) ve tekrarlanabilir `--profile <tier>=<route>` (tier `orchestrator|complex_worker|fast_worker`, aynı tier iki kez verilemez, kalıcı yazılmaz). `login`/`logout` için `--profile` credential profilidir.

Ayrıştırma katıdır: bilinmeyen seçenek, eksik değer veya fazla konumsal argüman kullanım hatasıdır. İnsan modunda stderr'e `Error: <ne oldu>` ve `Run \`syn <komut> --help\` for usage.` yazılır, exit 2. `syn run` JSONL istediğinde (`--json`, `--mode jsonl`, `--mode=jsonl`) kullanım hatası bile stdout'ta geçerli bir frame dizisi olarak raporlanır: `hello` + `error{code: usage_invalid, exit_code: 2}`.

## 3. Exit code'lar

| Kod | Anlam | Harness hata kodları |
| --- | --- | --- |
| 0 | başarı | — |
| 1 | iç hata | `internal`, `session_corrupt`, `store_write_failed` |
| 2 | kullanım | `usage_invalid`, `config_invalid` |
| 3 | onay | `approval_rejected`, `approval_unavailable` |
| 4 | provider/tool | `provider_failed`, `tool_failed` |
| 5 | doğrulama | `verification_failed`, `review_blocked`, `stale_packet` |
| 6 | policy | `policy_denied`, `sandbox_insufficient` |
| 7 | auth | `auth_required`, `auth_expired` |
| 8 | oturum kilitli | `session_locked` |
| 9 | bütçe | `budget_exceeded` |
| 130 | iptal | `cancelled` |

Başarısız bir run'ın kodu coordinator'da `failedRunExitCode` ile seçilir: tamamlanmayan görevlerin kayıtlı nedenlerinden bir doğrulama hatası (`verification_failed`, `review_blocked`, `stale_packet`) varsa 5; yoksa ilk kayıtlı neden (`provider_failed`/`tool_failed` → 4, `sandbox_insufficient` → 6, ...); nedeni olmayan görev (örn. bağımlılığı düştüğü için iptal) 5 sayılır. Neden, attempt'in kendi günlüğünden okunur (`classifyAttemptFailure`: iptal olmayan `model/response_failed` veya `ProviderFailure` → provider; turu kıran araç yürütmesi → tool). Plan üretilemezse: planlama turu provider'da düştüyse 4, orchestrator `ask_user` ile sorup cevap alamadıysa (`approval_unavailable`) 3, aksi halde 5. JSONL'de 4 ve 6 `error` frame'idir (görev tablosu olan 0/5/9 `result`).

`src/harness/cli/outcome.ts`: `failureInfo(error)` her hatayı hata standardına çevirir (`HarnessError` olduğu gibi, `AbortError` → `cancelled`/130, `ProviderFailure` → auth veya provider, bilinmeyen → `internal`, `retry_safe: false`). `approvalFailure(decision)` broker kararlarını çevirir: `unavailable`/`expired` → `approval_unavailable` (3), `rejected` → `approval_rejected` (3), `cancelled` → 130.

İnsan modunda hata stderr'e şu biçimde yazılır (terminal kaçış dizileri temizlenir):

```text
Error [session_locked]: session ses_… is held by pid 48122 on dev-laptop
  ids: session_id=ses_…
  workspace effect: none; retry safe: yes
  next: syn agent --fork ses_…
```

## 4. Renderer ve renk seçimi

`src/harness/cli/terminal.ts` sözleşmedeki `selectRendererKind` ve `selectColor` fonksiyonlarını kullanır:

```text
syn run --mode jsonl | --json                                   → jsonl
--plain | SYN_PLAIN (boş/0 değil) | TERM=dumb | stdin veya stdout TTY değil → plain
aksi halde                                                       → tui (pi-tui)
renk: --color > config > NO_COLOR (boş değil) > FORCE_COLOR > stream.hasColors()
```

- `CI` değişkeni tek başına modu değiştirmez. `syn agent` JSONL'e hiç girmez; TTY yoksa plain olur.
- Renk kararı insan metninin yazıldığı stream'e göre verilir: plain/tui'de stdout, JSONL'de stderr. Renk kapalıyken plain çıktı tek bir SGR baytı bile içermez; açıkken yalnız SGR (`ESC[…m`) kullanılır.
- pi-tui adapter'ı `createPiTuiRenderer()` içinde literal dinamik import ile yüklenir; plain ve JSONL yolları pi-tui'yi hiç yüklemez (test: modül çözümleme kancasıyla doğrulanır).

## 5. Renderer'lar

Üç renderer da `TerminalRenderer` arayüzünü uygular ve yalnız olay tüketicisidir. `render()` asla beklemez: olaylar sınırlı kuyruğa (`RenderQueue`, varsayılan 2048) girer; ardışık aynı istek/indeks `text_delta`/`thinking_delta`'lar birleştirilir; kuyruk dolunca **yalnız delta'lar** düşer, session olayları, durum ve bildirimler asla. Model ve tool çıktısı ekrana gitmeden önce `sanitizeTerminalText` ile temizlenir: OSC (52 clipboard, pencere başlığı), CSI (`2J` vb.), DCS/APC ve C0/C1 kontrol karakterleri silinir; `\r` ilerleme çubuğu gibi yorumlanır (satırın son hali kalır).

### JsonlRenderer (`jsonl-renderer.ts`)

- stdout'a yalnız frame yazar; her frame `jsonlFrameSchema` ile doğrulanır, geçersiz frame stdout'a gitmez (stderr'e tanı yazılır). Her satır `JSON.stringify(frame) + "\n"`, yalnız LF.
- `seq` 1'den başlar ve **yazma anında** verilir; düşürülen delta boşluk bırakmaz. İlk frame `hello`; `result(data)` veya `fail(error)` tek terminal frame'i yazar, sonraki olaylar ve ikinci sonuç yok sayılır. `stop()` terminal frame yazılmadıysa `signal` için `cancelled` (130), diğerleri için `internal` (1) yazar.
- `--stream-deltas` yoksa `delta` frame'i yazılmaz; `status` yazılmaz; `notice` stderr'e gider.
- `guardStdout` verildiğinde renderer çalışırken stdout'a başka bir yerden yapılan yazmalar stderr'e yönlendirilir (pi `takeOverStdout` kalıbı); `stop()` geri alır.
- Backpressure: `write()` false dönerse kuyruk duraklar ve `drain` beklenir; EPIPE sonrası yazma durur, süreç çökmez.
- Onay broker'ı her zaman headless'tır (`unavailable`, `decided_by: broker`); `AuthInteraction` etkileşimsizdir (secret istenemez → `auth_required`).

### PlainLineRenderer (`plain-line-renderer.ts`)

- Yalnız ekleme yapar; imleç hareketi, spinner, satır silme yok. Stream metni geldikçe yazılır; `done` mesajı düşen delta'ları uzlaştırır (gösterilen metin önek ise kalan kısım yazılır, değilse `[stream resynchronised; full message follows]` ve tam metin).
- Olay satırları stdout'a, uyarı/hata bildirimleri ve model hataları stderr'e yazılır; seviye metin önekiyle de belirtilir (`warning:`, `error:`), renk tek bilgi kanalı değildir. Tool çağrıları tek satırdır: `[tool] read_file proposed {…}`, `running: sandbox full`, `done in 7 ms: …`. Durum satırı yalnız değiştiğinde `[status] …` olarak yazılır.
- Etkileşimli yalnız stdin TTY iken (`--plain` açıkça seçilmiş) olur: onay `Allow? [y/N]` (kapsamlı istekte `[a]lways`), boş cevap ve süre aşımı ret (`expired`); secret raw modda echo'suz okunur; bildirim onayı `Continue? [y/N]`. Aksi halde headless broker ve etkileşimsiz auth.
- Girdi (`syn agent` plain modu): LF'e göre bölünür, sondaki CR atılır, `readline` kullanılmaz (U+2028 satırı bölmez). `/exit`, `/quit` ve EOF çıkıştır; `/…` komut, diğerleri mesajdır.

### PiTuiRenderer (`pi-tui-renderer.ts`)

- `@earendil-works/pi-tui@0.87.0`'ı import eden **tek** dosya. `TuiMainScreen` (ana ekran, terminal scrollback korunur) üzerinde başlık, transcript, durum satırı ve çok satırlı `Editor`.
- Stream Markdown olarak render edilir (her istek/indeks için bir `Markdown` bileşeni); `done` son metni sabitler. Tool kartları stream'deki `tool_call_start`'tan doğar ve gateway kaydıyla (`tool/call_proposed`, provider call id eşlemesi) aynı kart olarak `running` → `done/failed/denied/cancelled/interrupted` durumuna ilerler. Her satır `truncateToWidth` ile terminal genişliğine sığdırılır.
- Onay diyaloğu overlay'dir: `Allow once`, kapsam `once` değilse `Allow for this <scope>`, `Reject`. Esc reddeder (`rejected`, kullanıcı kararı); Ctrl+C diyaloğu iptal eder (`cancelled`, broker). Süre aşımı `expired`. Secret istemi maskelidir (`•`), bildirim onayı seçim listesidir. Tarayıcı açma yalnız http(s), kabuk kullanmadan ve SSH dışında denenir; URL her zaman gösterilir.
- Her yazma `ChunkedTerminal` ile en fazla 16 KiB UTF-8 parçalara bölünür (tercihen LF sonrası, surrogate çifti bölünmeden). pi-tui kendi başına 1 MiB'lık parçalarla yazar; bu ConPTY için fazla büyüktür.

## 6. Tuşlar ve iptal semantiği

`InterruptController` üç renderer'da ortaktır:

| Durum | Ctrl+C | Esc |
| --- | --- | --- |
| Etkin istek/tur var, iptal istenmedi | isteği iptal eder (`onInterrupt`, girdi kaynağı `interrupt` döner) | aynı |
| İptal zaten istendi veya boşta | güvenli çıkış önerir: "Press Ctrl+C again to exit safely." | hiçbir şey |
| Öneriden sonra 2 sn içinde | çıkar (`onExit`, girdi kaynağı `exit` döner) | hiçbir şey |

Yeni tur veya istek başlayınca iptal yeniden silahlanır. TUI'de ek olarak: boştayken editörde taslak varsa ilk Ctrl+C taslağı temizler; boş editörde Ctrl+D çıkış; Enter gönderir, Shift+Enter yeni satır. Raw modda Ctrl+C SIGINT üretmediği için TUI tuşu girdi olarak alır; plain ve JSONL modlarında aynı kurallar SIGINT'e bağlanır.

### 6.1 Girdi ve etkileşim (K1-U1, yalnız TUI; kod `src/harness/tui/input/**`)

| Girdi | Davranış |
| --- | --- |
| `/` (mesaj başında) | Komut paleti: ad + tek satır açıklama + argüman ipucu (`/plan <goal>`), yazdıkça süzülür; ↑/↓ seçer, Tab/Enter tamamlar. `<zorunlu>` argümanlı komutta Enter yalnız tamamlar (`/plan `), diğerlerinde gönderir. Satırlar oturumdan gelir (`controls.setCommands`); `/mouse`, `/select`, `/exit` renderer'ın kendisindedir. |
| `@` (kelime sınırında) | Workspace yollarında bulanık tamamlama: `git ls-files --cached --others --exclude-standard` (git yoksa sınırlı dizin taraması), bellekte önbellek, 30 sn'den eskiyse arka planda yenilenir. Boşluklu yol `@"a b.md"` olarak eklenir; dizin `@src/` ile gezinir. Gönderimde var olan her `@yol` bir `Attachment` (`file`/`directory`) olur. |
| Alt+V, Ctrl+V (uygulamaya ulaşırsa), boş bracketed paste | Pano görseli: pi-tui native yardımcısı, sonra Windows `powershell.exe Get-Clipboard -Format Image` (Forms yedeği), macOS `pngpaste`/`osascript`, Linux `wl-paste`/`xclip`. Geçici PNG `os.tmpdir()/synorch-images/` altına yazılır, editöre `[image N]` çipi girer. Yapıştırılan veya sürüklenen tek görsel yolu (`.png/.jpg/.gif/.webp`, tırnak ve `file://` temizlenir) da çip olur. Windows Terminal Ctrl+V'yi kendisi yakalar; görsel için Alt+V. |
| Shift+Tab (VT input yoksa Alt+M) | Plan modu aç/kapa: alt bilgide `plan mode`, editör çizgisi vurgulu. Politika daraltmasını oturum uygular (`controls.onPlanModeChange`). |
| Shift+Enter, Ctrl+J | Yeni satır. ↑/↓ oturum içi geçmiş. 10 satırı veya 1000 karakteri aşan yapıştırma `[paste #1 +120 lines]` işaretine iner, gönderimde açılır. |
| `/mouse [on\|off]`, `SYN_MOUSE=1` | SGR 1006 fare raporlaması. **Varsayılan kapalı**: açıkken terminal kendi seçimini ve scrollback'ini bırakır. Açıkken çerçeve ekranı doldurur, tekerlek transcript'i kaydırır (Shift+PgUp/PgDn da), tıklama tool satırını tek başına açar/kapar, Enter veya Ctrl+End en alta döner. Metin seçmek için çoğu terminalde Shift basılı sürükleyin ya da `/select`: fare raporlaması kapanır, tüm transcript çizilir, Esc/Enter geri döner. |
| `/model` | Oturum `controls.openModelPicker(entries)` ile seçici açar: tier, provider/model, auth; mevcut route işaretli ve seçili; Esc `undefined` döner. |

Oturum sınırı (U2): `TerminalRenderer.controls?: InteractiveInputControls` (plain/JSONL'de yok) ve `UserInputSource.next()` mesaj sonucundaki isteğe bağlı `attachments: Attachment[]`. Görsel baytları yalnız `image_input` yetenekli route'lara gider; diğerleri için oturum metin notu ekler. `Attachment`, `CommandPaletteEntry`, `ModelPickerEntry` şekilleri `contracts/renderer.ts` içinde örnekli belgelenmiştir.

## 7. Terminal yaşam döngüsü

- `installTerminalGuard` `exit`, `uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGHUP` (Windows'ta pencere kapatma) ve Windows'ta `SIGBREAK` için kanca kurar; geri yükleme en fazla bir kez çalışır, `stop()` kancaları kaldırır.
- TUI acil geri yüklemesi: `tui.stop()` (bracketed paste, Kitty/modifyOtherKeys kapatma, stdin `pause()`, raw mod eski haline) ve ardından senkron `EMERGENCY_RESTORE_SEQUENCE`: `?2026l`, `?2004l`, `<u`, `>4;0m`, fare raporlaması kapalı, SGR sıfırlama, autowrap açık, imleç görünür. Alt-screen kullanılmadığı için `?1049l` yazılmaz. Normal kapanışta geç gelen tuşlar `drainInput` ile tüketilir (SSH'de Ctrl+D sızıntısını önler).
- Windows konsol codepage'i: Node konsola UTF-16 (`WriteConsoleW`) yazdığı için bir child'ın `chcp 437` çalıştırması Synorch'un kendi kutu çizgilerini bozmaz (OMP'deki sorun byte yazan Bun'a özgüdür). Yine de kullanıcının konsolu değişmiş kalmasın diye `ConsoleCodepageGuard` başlangıç codepage'ini kaydeder ve kapanışta değişmişse geri yükler (`chcp.com`, yalnız win32). Tool child'larının stdio'yu pipe ile başlatması I3'ün kuralıdır.

## 8. Kabul ölçütü → test

| AC | Test |
| --- | --- |
| AC-1 legacy çıktılar değişmez; boundary yeşil | `tests/cli-legacy-snapshot.test.ts` › "legacy commands keep byte-identical stdout, stderr and exit codes (AC-1)"; `tests/harness-boundary.test.ts`; `tests/harness-cli-args.test.ts` › "routing matches cli.ts…" |
| AC-2 non-TTY/pipe/`TERM=dumb`/`--plain` → plain; JSONL stdout yalnız geçerli frame | `harness-cli-args` › "renderer selection … (AC-2)", "JSONL mode reports even usage errors … (AC-2)", "the real binary routes runtime commands … (AC-2)", "the plain and JSONL paths never load pi-tui"; `harness-tui-jsonl` › "stdout holds only schema-valid frames … (AC-2)", backpressure, geçersiz olay, stdout koruması; `harness-tui-plain` › "plain output is append-only … (AC-2)" |
| AC-3 headless onay → error frame, exit 3; iptal → 130; kilitli session → 8 | `harness-tui-jsonl` › "headless approval ends with an error frame and exit 3 (AC-3)", "user cancellation exits 130 and a locked session exits 8 (AC-3)" |
| AC-4 pi-tui sanal terminalde stream + resize + tool kartı | `harness-tui-pi-tui` › "pi-tui renderer streams markdown, resizes and draws a tool card in a virtual terminal (AC-4)", genişlik (40/80/200, CJK/emoji), ConPTY parçalama, onay diyaloğu, Ctrl+C/Esc, secret, terminal geri yükleme |
| AC-5 uçtan uca trivial belge düzeltmesi ve standart kod değişikliği | `harness-e2e-trivial` › "trivial doc fix: a single worker, targeted evidence, no redundant review or approval (AC-5)"; `harness-e2e-standard` › "standard code change: plan, packet, diff, test, independent review and report (AC-5)" |
| AC-6 `doctor --runtime --json` ayrı sonuçlar, ağ isteği yok | `harness-e2e-doctor` › "doctor --runtime --json reports each area separately and makes no network request (AC-6)"; `harness-cli-args` › "the real binary routes runtime commands…" |
| AC-3 gerçek runtime ile | `harness-e2e-headless` › "headless approval in ask mode ends with an error frame and exit 3…", "user cancellation during a model stream exits 130…", "a session held by another writer exits 8…" |

## 9. Manuel çapraz platform doğrulaması (açık)

[Çapraz platform listesindeki](../research/tui/cross-platform-checklist.md) P0 satırları otomatik testle kapanmaz; Aşama B'de gerçek oturumla işaretlenecek:

- Windows Terminal (PowerShell 7, Windows PowerShell 5.1, cmd) ve klasik conhost: raw mod, Shift+Enter, Shift+Tab (native VT input yardımcısının pnpm altında yüklenmesi), Türkçe klavye/AltGr, sağ tık yapıştırma, 16 KiB parçalamayla uzun transcript'te viewport, `chcp 437` sonrası codepage geri yükleme, pencere kapatma (SIGHUP) sonrası kabuk durumu.
- macOS Terminal.app/iTerm2, Linux GNOME Terminal/kitty, SSH (Windows→Linux, macOS→Linux): çıkışta `stty -a` temiz, ESC zaman aşımı, geç tuş sızıntısı yok.
- DEC 2026 desteklemeyen terminalde titreme; 200 token/s stream'de CPU ve p95 frame süresi (ölçülmedi).
- GitHub Actions üç OS'ta non-TTY JSONL fixture'ı ve pipe/yönlendirme (`| cat`, `> out.jsonl`, `| sleep 30` ile EPIPE).
- Ekran okuyucu (NVDA, VoiceOver) ile `--plain` akışı.

## 10. Composition root: `createRuntime()`

`src/harness/cli/runtime.ts` kardeş modülleri birleştiren **tek** yerdir (ADR-01; boundary testi `cli` dışındaki her modülün yalnız `contracts`'a bağlı kaldığını zorlar). Her komut çağrısı bir runtime kurar:

| Parça | Kaynak |
| --- | --- |
| Home | `SYNORCH_HOME` veya `~/.synorch` (`resolveHome`, auth modülüyle aynı kural); testler `RuntimeOverrides.home` verir |
| Yapılandırma | §11 katmanları → `ModelRouterConfig`, kullanıcı/workspace policy, `MemoryConfig`, renk, bütçe |
| Store | `createSessionStore(home)`, `createBlobStore(home)`; oturum deposu sarılır: her yeni/forklanmış oturuma `session/opened` yazılır, her eklenen olay renderer'a akar, açık yazıcılar ContextBuilder (okuma) ve compactor (`writerFor`) ile paylaşılır |
| Auth | `createCredentialStore(home)` tembel açılır (keychain yoklaması süreç başlatabilir); route'un `(provider_id, auth_method, profile)` üçlüsü `authProviderFor(...).resolve`'a bağlanır (`CredentialResolver`, başka kimliğe düşmez); çözülen credential'ların `redactionValues()` birleşimi gateway'e verilir. `scripted` test sağlayıcısı secret'sız bir credential alır |
| Router | `createModelRouter({ rules }, adapters)`; adapter'lar yapılandırmadan (`openai-chatgpt`, `openai-responses`, `anthropic-messages`, `claude-code`, `scripted`) veya testte enjekte edilir. `adapterFor` sarılır: her stream olayı renderer'a `stream` olarak gider ve `quota_exhausted` hatası `router.reportFailure` ile route'u bloklar. `claude-code` adapter'ı yalnız `claude-bridge-experimental` bildirimi onaylanmışsa `experimental: true` ile kurulur |
| Kanonik `.ai/` | `loadCanonicalStructure(workspaceRoot)` (`canonical.ts`, §10.1) → ContextBuilder'a `instructions` + rol kapsamlı `skills`, policy'ye rol tanımları, başlık/doctor'a model profili ipuçları |
| Tools/policy | `withRoleDefinitions(createPolicyEngine(), canonical.roles)` (`role-policy.ts`: manifest yalnız daraltır), `probeSandbox()` + `createSandboxRunner`, `createToolRegistry({ classifyCommand, control: { askUser, taskSpawn, taskStatus, memoryPropose } })`; `memory_propose` öneriyi `memoryProposalSchema` ile doğrulayıp kuyruğa yazar; `ask_user` oturumun `bindUserPrompt` bağlamasına gider (yoksa `approval_unavailable`); `task_spawn`/`task_status` `createDelegationSlot()` üzerinden etkin run'ın coordinator'ına gider |
| Onay | `brokerFor`: `ask` modunda ve renderer'ın broker'ı etkileşimliyse o; aksi halde `createHeadlessApprovalBroker({ mode })` |
| Hafıza | `createMemoryStore(<home>/memory/<project-id>)` (kullanıcı `memory.root` verdiyse `resolveMemoryRoot`), ContextBuilder'a proje/branch ile recall olarak |
| Orkestrasyon | `createContextBuilder` (+ `createCompactor`, `createBudgetGateSlot`), `createAgentDriver` (attempt başına gateway), `createModelPlanner`, `createWorkerFactory({ worktreesRoot: <home>/worktrees })`, `createCoordinator` |
| Recovery | `recover(sessionId)`: oturumu `recoverSession` ile kapatır, sonra `attempt/started.session_id` ile başlattığı ve temiz bitmemiş her attempt oturumunu da kurtarır; hiçbir araç yeniden çalışmaz. Ardından `pruneOrphanedAttempts` sahibi ölmüş worktree'leri kaldırır ve çökmüş scoped-dir attempt'lerinin sahip yollarındaki yarım yazmalarını kalıcı baseline'dan geri alır (SEC-M3) |

### 10.1 Kanonik `.ai/` yapısı runtime girdisi olarak

Hedef deponun Synorch yapısı (`syn init`/`syn sync` çıktısı) oturumun her model isteğine ve policy'sine girer; ayrıştırma üreticinin kendi şemalarıyla yapılır (`src/domain/canonical-contracts.ts` `agentManifestSchema`/`skillContractSchema`, `src/domain/generated-skill.ts`), kopya şema yoktur.

| Kaynak | Runtime'daki karşılığı |
| --- | --- |
| `.ai/constitution.md` | `constitution` bloğu, `project` güveni, harness bloğundan hemen sonra |
| `.ai/protocols/registry.yaml` + `core/*.md` | `mandatory: true` protokoller öncelik sırasıyla (`constitutional` → `core` → diğer, eşitlikte kayıt sırası), frontmatter'sız gövde; zorunlu olmayanlar her adıma yüklenmez |
| `.ai/agents/<rol>/AGENT.md` | Rol bloğu (gövde) + `RoleDefinition` (`model_tier`, `writes_product_files`, `control_plane_write_scope`, `allowed/forbidden_skills`, `reports`). Orchestrator bloğuna worker rollerinin özeti eklenir |
| `.ai/skills/*/SKILL.md`, `.ai/skills/project/*/SKILL.md` (`status: active`) | Katalog (ad + açıklama); tam gövde yalnız adı görev metninde geçince ve rolün `allowed_skills`'i izin veriyorsa yüklenir (`technology:*` baz olmayan skill'leri kapsar, `forbidden_skills` her zaman gizler) |
| `.ai/manifest.yaml` → `model_profiles` | Tier başına model **ipucu** (route değil): başlıkta ve `doctor --runtime`'da gösterilir, orchestrator route'u yoksa hata mesajı önerir. Depo metni ücretli bir route seçemez |

Güven kuralı: depo metni `project` güvenindedir; tarif eder ve daraltır, asla yetki vermez. `writes_product_files: false` bir worker'ın yazma kapsamını ve `workspace-write` etkisini kaldırır; orchestrator için `.ai/tasks/` altındaki daha dar bir `control_plane_write_scope` `.ai/tasks/**`'ın yerini alır; explorer/reviewer/orchestrator için `writes_product_files: true` veya `.ai/tasks/` dışı kapsam **yok sayılır** ve tanılamaya yazılır. Manifest ek bir `role` katmanı olarak policy'ye girer (`source: .ai/agents/<rol>/AGENT.md`), dolayısıyla yürürlükteki manifest bir policy kaynağıdır ve hiçbir araç onu yazamaz (`policy-self-modification`). `assertNotWider` daraltmanın hiçbir etkiyi veya yazma desenini genişletmediğini her hesaplamada doğrular.

Geri dönüş: depoda `.ai/` yoksa `src/templates/structure-templates.ts`'in (`syn init`'in yazacağı) içeriği bellekte kullanılır; `.ai/` varsa eksik veya geçersiz her parça (anayasa, kayıt, tek bir manifest) tek tek yerleşik karşılığıyla tamamlanır ve tanılamaya yazılır. **Init gerektirmeyen kullanım (K1.5-4):** yerleşik yapı birinci sınıf moddur; paketlenmiş `syn` hiçbir `syn init` olmadan her depoda anayasa, 8 çekirdek protokol, 5 rol ve 9 skill ile çalışır (şablonlar TypeScript olarak `dist/`e derlenir; npm `files` `dist` ve `skill-sources`'ı içerir). `syn init` yalnız özelleştirmek içindir. `doctor --runtime` `canonical` sonucu tanı yoksa her iki modda `ok`'tur ve yerleşik modda `canonical: built-in Synorch structure (…; customize with syn init)` bilgisini verir; yalnız tanı (eksik/geçersiz parça) `warn` yapar. `syn run`/legacy başlığı yerleşik mod için notice basmaz, yalnız deponun kendi yapısını duyurur. Boundary testi yalnız `cli` modülünün bu tek şablon dosyasını import etmesine izin verir.

## 11. Yapılandırma

YAML dosyaları, hepsi opsiyonel; üst düzey anahtarlar katıdır (bilinmeyen anahtar `config_invalid`, exit 2):

| Katman | Dosya | Güven | Ayarlayabildiği |
| --- | --- | --- | --- |
| kullanıcı | `<home>/config.yaml` | güvenilir | her anahtar; route kaynağı `user` |
| workspace | hedefin **üstündeki** en yakın `.synorch/config.yaml` (hiçbir synorch home'u değil) | repo içeriği, güvenilmez | yalnız `policy` (daraltma) ve `budget` (en küçüğü) |
| proje | `<hedef>/.synorch/config.yaml` (synorch home'u değilse) | repo içeriği, güvenilmez | yalnız `policy` (daraltma) ve `budget` (en küçüğü) |
| oturum | `--profile <tier>=<provider>/<model>[@<adapter>]` (kalıcı yazılmaz) | açık kullanıcı bayrağı | route; kaynak `session` |

**Synorch home asla repo katmanı değildir.** Workspace araması (repo ev dizininin altında olabilir, bu yüzden arama ev dizininde durmaz) iki tür `.synorch` dizinini atlar: gerçek yolu (realpath; Windows ve macOS'ta küçük harfe indirilmiş) çözülmüş synorch home'a eşit olanı ve bir home işareti (`SYNORCH_HOME_MARKERS`: `credentials.json`, `credentials.dpapi.json`, `trust.json`, `auth-state.json`) taşıyan herhangi birini. İkincisi `SYNORCH_HOME` başka bir yeri gösterirken ata dizinlerde kalan bir `~/.synorch/config.yaml`'ın repo katmanı sanılıp kullanıcı `routes`/`adapters` anahtarları için "ignored" uyarısı üretmesini önler. Aynı kural proje katmanına da uygulanır. Bir dizini atlamak yalnız daraltan bir katmanı düşürebilir, hiçbir yetki vermez. `loadRuntimeConfig(home, target, overrides, { ceiling })` / `RuntimeOverrides.configCeiling` aramanın çıkabileceği en üst dizini belirler; testler bunu sandbox köküne sabitler, böylece OS temp dizininin üstündeki dosyalar sonucu etkilemez.

**Güven katmanları (SEC-C1).** Repo katmanları (workspace, proje) kimlik bilgisini başka bir host'a yönlendiremez ve faturalandırmayı değiştiremez: `routes`, `adapters` (dolayısıyla `base_url`, profil, `script`), `memory` ve `ui` repo katmanında **yok sayılır**. Yok sayılan her anahtar bir `ConfigWarning` üretir: `syn doctor --runtime` `config` sonucunu `warn` yapıp mesajı gösterir, oturum başlığı uyarıyı notice olarak basar ve `session/opened.config_ignored` (v2) denetim kaydı olarak `{layer, path, key}` yazar. Yok sayılan anahtarlar şema doğrulamasından önce atılır; repo dosyasındaki bozuk bir `routes` değeri çalıştırmayı durduramaz. Bilinmeyen anahtar yine `config_invalid`'dir. İnsan-onaylı `provider-change` kararı repo yapılandırmasıyla atlanamaz, çünkü repo route seçemez.

**Endpoint sabitleme.** `base_url` yalnız kullanıcı katmanında yazılır ve adapter türünün resmi origin'inde olmalıdır (`OFFICIAL_ENDPOINTS`: `openai-chatgpt` → `https://chatgpt.com`, `openai-responses` → `https://api.openai.com`, `anthropic-messages` → `https://api.anthropic.com`). API key adapter'ı için başka bir origin, aynı girdide açık `allow_custom_endpoint: true` ister. `openai-chatgpt` abonelik OAuth token'ı taşıdığından resmi olmayan host'u hiçbir koşulda kabul etmez. Kimlik bilgisi taşıyan URL (`user:pass@`) reddedilir. `claude-code` girdisi `allow_non_subscription_auth: true` alabilir (bkz. [sağlayıcılar](./providers-and-auth.md)); diğer türlerde bu anahtar `config_invalid`'dir.

```yaml
routes:
  - { tier: orchestrator, provider: openai, model: gpt-5 }                 # adapter varsayılanı: openai-chatgpt
  - { tier: complex_worker, provider: anthropic, model: claude-x }          # anthropic-messages
  - { tier: complex_worker, role: reviewer, provider: openai, model: gpt-5, adapter: openai-responses }
adapters:                                                                   # isteğe bağlı; scripted için zorunlu
  - { id: scripted-planner, kind: scripted, script: ./planner.json }        # yalnız test/smoke, ağ yok
  - { id: corp-gw, kind: anthropic-messages, base_url: "https://gw.corp.example/v1", allow_custom_endpoint: true }
policy: { mode: ask, forbidden: ["secrets/**"] }                            # repo katmanları yalnız daraltır
memory: { root: ~/vaults/synorch }                                          # yalnız kullanıcı katmanı
ui: { color: false }                                                        # yalnız kullanıcı katmanı
budget: { max_wall_time_seconds: 1800, max_cost_usd: 5 }                    # katmanların en küçüğü
```

Öncelik router'da uygulanır (`session > user > provider-default`; `project`/`workspace` route kaynakları şemada kalır ama artık üretilmez); proje ve workspace policy blokları kesiştirilip engine'in workspace katmanına verilir. `.synorch/` rezerve yol olduğundan hiçbir worker bir yapılandırma katmanını değiştiremez. Varsayılan model kimliği uydurulmaz: orchestrator tier'ı için route yoksa `syn run`/`syn agent` oturum açmadan `config_invalid` (exit 2) ve `next: syn doctor --runtime` verir.

`scripted` betik dosyası JSON dizisidir; her öğe bir model isteğini yanıtlar: ham `ModelStreamEvent` dizisi, `{ "text" }`, `{ "tool_calls": [{ "name", "arguments" }] }` veya `{ "error": { "code", "message", "retry_after_ms"? } }`. Araç argümanlarında `$last_tool_call_id` ve `$tool_call_id[N]` istekteki araç sonuçlarının harness kimlikleriyle değiştirilir (kanıt göstermek için). Örnek: `tests/fixtures/cli/runtime/noop/`.

### 11.1 `syn config` ve `/config` (K1.5-3)

`src/harness/cli/config-command.ts`. YAML düzenlemeden kullanıcı katmanını (`<home>/config.yaml`) yönetir; **yalnız kullanıcı katmanı yazılır**, repo katmanları yalnız daraltır (SEC-C1, yukarıdaki kural). Her yazma, oturumun kullandığı şema ve adapter kontrolleriyle (`validateUserConfigText`) doğrulanır, sonra atomik olarak (geçici dosya + rename) yerine konur; `yaml` Document API'siyle düzenlendiği için yorumlar ve diğer anahtarlar korunur.

| Anahtar | Tür | Kapsam |
| --- | --- | --- |
| `routes.<tier>[.<rol>]` | `provider/model[@adapter]` (ör. `openai/gpt-6-sol`, `anthropic/opus-5.5@claude-code`); adapter yoksa sağlayıcı `openai`/`anthropic`/`scripted` olmalı | kullanıcı |
| `ui.permission_mode` | `ask\|auto\|full\|plan` | kullanıcı |
| `ui.color`, `ui.mouse` | boolean (`true/false/on/off/yes/no/1/0`) | kullanıcı |
| `ui.glyphs` | `auto\|rich\|safe\|ascii` (`SYN_GLYPHS` önceliklidir) | kullanıcı |
| `policy.mode`, `policy.require_full_sandbox` | `autonomous\|ask`, boolean | daraltılabilir (en katı) |
| `budget.max_wall_time_seconds`, `budget.max_cost_usd` | pozitif tamsayı / sayı | daraltılabilir (en küçük) |
| `memory.root` | yol | kullanıcı |
| `routing.prefer_different_provider` | boolean (varsayılan `true`): reviewer implementer'dan farklı sağlayıcıyı tercih eder; router'a `preferDifferentProvider` olarak gider | kullanıcı |

- `list [--json]`: her anahtarın etkin değeri ve kaynağı (`user`, `default`, repo daraltıyorsa `project (narrowed)`/`workspace (narrowed)`), yok sayılan repo anahtarlarının uyarıları. JSON: `{user_config, files, settings: [{key, value, source, scope}], warnings}`.
- `get <anahtar>`: yalnız değer (betikler için); ayarlı değilse exit 1.
- `set`/`unset`: tipli ayrıştırma; bilinmeyen anahtar/değer en yakın öneriyle (`Did you mean ui.mouse?`) exit 2 ve dosyaya dokunulmaz. `adapters` yalnız `edit` ile.
- `edit`: `$VISUAL`/`$EDITOR` (Windows'ta `notepad`, diğerlerinde `vi`) `<home>/config.yaml.edit` taslağını açar; taslak doğrulanırsa yerine konur, doğrulanmazsa yapılandırma değişmez, hata basılır ve bir sonraki `syn config edit` taslaktan devam eder.
- `path`: kullanıcı yapılandırmasının yolu.

`ui.mouse` etkileşimli görünümü fare yakalaması açık başlatır (`SYN_MOUSE` yalnız ayarsızken), `ui.glyphs` glif setini seçer.

**`/config` (oturum içi).** TUI'da ayar listesi mevcut picker primitive'iyle açılır (`openModelPicker`, `ModelPickerEntry.label` ve `PickerHeading` ile): satır başına anahtar, değer, kaynak; Enter düzenler — boolean anında tersine döner, enum ve route için seçenekler (route'larda yapılandırılmış route'lar + "Type a value…"), sayı/metin için soru; her listede "unset" vardır; Esc kapatır. `ui.permission_mode` ve `ui.mouse` hemen uygulanır, diğerleri yeni konuşmalarda. `/config <anahtar>` tek değeri, `/config <anahtar> <değer>` doğrudan yazar; plain renderer'da `/config` listeyi basar.

## 12. Komutların davranışı

| Komut | Davranış |
| --- | --- |
| `syn run "<hedef>"` | Tek coordinator run'ı: plan (`plan_propose`) → `autonomous`'ta orchestrator'ın denetlenen öz-onayı / `ask`'ta insan → DAG → worker attempt'leri (kendi oturumlarında) → doğrulama → `trivial` dışı bağımsız review → integrate → görev başına rapor. Run ve attempt oturumlarının tüm olayları ile model stream'i renderer'a akar. JSONL: `hello` `run/created` gelince yazılır (gerçek run/session kimliği); başarı ve görev tablosu olan bitişler (exit 0/5/9) `result`, onay/iptal/kilit/config/iç hata `error` frame'idir. İnsan modunda özet stdout'a, hata standardı stderr'e. `syn run -` hedefi stdin'den okur. SIGINT (JSONL/plain) etkin run'ı iptal eder → 130 |
| `syn agent` | Aynı akış, her kullanıcı mesajı bir run; run'lar tek oturumda birikir. TTY'de run sürerken yazılan mesaj `steer` olarak kuyruğa girer (bekleyen bir `ask_user` sorusu varsa önce onu yanıtlar), `/cancel` çalışır. Steer bir sonraki güvenli sınırda (yeni dispatch'ten önce; çalışan attempt değişmez) uygulanır: orchestrator bir kez danışılır (`task_status`, `task_spawn`), plan steer'i `assumptions`'a ekleyen yeni bir sürümle (yeni `plan_id`, `version` n+1) önerilir ve modun kuralıyla onaylanır; eski plan yalnız revizyon onaylanınca `superseded` olur, reddedilen revizyonda run eski planla sürer. `--resume <ses>` önce recovery yapar ve kurtarılanları bildirir; `--fork <ses>[@seq]` yeni oturum açar (`session/opened.parent`). Çıkışta `Session saved: <ses>` stderr'e yazılır |
| `syn runs [--json]` | Bu projenin oturumlarındaki run'lar (attempt oturumları gizli): zaman, kimlik, durum, görev sayısı, canlı kilit |
| `syn show <run\|ses> [--json]` | Plan, görevler, attempt'ler (rol, route, izolasyon, oturum, durum), onaylar (run + araç), kanıt (completion blob'larından kriter → kanıt, komutlar), review'lar, route kararları, usage (kaynak etiketiyle). Lease almaz |
| `syn doctor --runtime [--probe-model] [--json]` | Ayrı sonuçlar: `node`, `terminal`, `config`, `canonical` (kanonik `.ai/` kaynağı, protokoller, roller, skill'ler, profil ipuçları, tanılar; §10.1), `sandbox`, `trust` (çalışma alanı güveni, SEC-N1), `store` (home'a dayanıklı yazma denemesi + oturum sayısı + sahibi ölmüş attempt çalışma alanlarının budanması, SEC-M3), `auth` (`AuthStatus[]`, secret yok), `capabilities` (adapter keşfi + statik health, eksik tier). Ağ isteği yok (`network_requests: "none"`); `--probe-model` her route'a bir küçük istek gönderir. Exit: `fail` varsa 1, yoksa 0 (`partial` sandbox `warn`) |
| `syn login/logout/auth status` | I2 `authCommand`; `CommandIO.renderer` = stdin TTY ise etkileşimli plain renderer (`LineAuthInteraction`: gizli giriş, `claude-bridge-experimental` bildiriminin tek seferlik onayı), değilse headless (`syn login` exit 7). Ortak bayraklar komuta aktarılmadan ayıklanır |
| `syn memory …` | I6 `memoryCommand`; vault kökü `<home>/memory/<project-id>` (veya kullanıcı `memory.root`). `accept`/`reject` kararının `memory/proposal_decided` ve `memory/persisted` yükleri projenin `syn memory decisions` oturumuna eklenir |
| `syn trust [--revoke]` | `cli/trust.ts` `trustCommand`: `createWorkspaceTrustStore(home)` ile `<home>/trust.json`'a kanonik kök + depo kimliği kaydı yazar/siler (depoya hiçbir şey yazılmaz), `trust/granted` (`source: command`) / `trust/revoked` projenin `syn trust decisions` oturumuna eklenir. Home çalışma alanının içindeyse `config_invalid` (exit 2). Çıktı riski açıkça söyler |

**Çalışma alanı güveni (SEC-N1).** `createRuntime` açılışta `trust.status(workspaceRoot)` okur (`RuntimeOptions.trustWorkspace` = `syn run --trust-workspace` → yalnız bellekte `source: flag`) ve policy engine'e `workspaceTrusted` getter'ı, coordinator'a `workspaceTrust` verir. `syn run`/`syn agent`, renderer etkileşimliyse (TTY, JSONL değil), sandbox `full` değilse ve çalışma alanı güvenilmezse ilk run'dan önce bir kez `promptWorkspaceTrust` ile `workspace-trust` konusunu sorar. Pi-tui ve plain renderer bu konu için genel onay seçenekleri yerine `WORKSPACE_TRUST_CHOICES`'ı gösterir: "Not now" (ilk, önceden seçili; ret güvensiz devam eder, uyarı stderr'de), "Trust for this session only" (`allowed-once` → `runtime.trust.grantSession()`: yalnız bellekte `source: session`, `trust.json`'a yazılmaz, `trust/granted` yok) ve "Trust this workspace" (`allowed-for-scope` → `runtime.trust.grant("prompt")`: kalıcı ve denetlenir). Plain renderer'da `n`/`s`/`t`; Enter ve tanınmayan her cevap (genel `y` dahil) "Not now"dur. Soru ve `syn trust` çıktısı `WORKSPACE_TRUST_NOTICE`'ı gösterir: güvenilen çalışma alanında test/build betikleri ve oturumda yapay zekânın yazdığı kod kullanıcının izinleriyle çalışır ve Synorch kimlik bilgileri dahil çalışma alanı dışına erişebilir. **Program araması (S1):** exec PATH'te program ararken gerçek yolu (Windows'ta küçük harfe indirilmiş) çalışma alanı kökü, görevin çalışma kökü veya Synorch home'u içinde kalan PATH girdilerini atlar; bu kökler verilmişken başka yerde bulunamayan çıplak bir program adı başlatılmaz (Windows'ta platformun cwd'yi de deneyen kendi aramasına düşülmez). POSIX'te de aynı arama yapılır ve program mutlak yoluyla başlatılır. Coordinator güvene dayanan her run'da `policy/snapshot`'tan sonra `trust/used` yazar; headless (`request.headless`), `autonomous`/kısmi sandbox, güvensiz ve planda doğrulama komutu olan run işçi başlamadan `approval_unavailable` (exit 3; `next_command: syn trust (or syn run --trust-workspace for one run)`) ile biter. `doctor --runtime` `trust` sonucunu `sandbox`'tan sonra verir (`full` → `ok` "not needed", güvenilir → `ok`, aksi halde `warn`).

## 13. Oturum içi komutlar (`syn agent`)

**Konuşma (`syn agent`, ADR-21, K1-U2).** Tek kayıt `src/harness/cli/slash-commands.ts` (`CONVERSATION_COMMANDS`: ad, açıklama, argüman ipucu, `whileBusy`, handler); `/help` ve TUI paleti (`controls.setCommands`, `/mouse` ve `/exit` renderer'da kalır) buradan beslenir.

| Komut | Davranış |
| --- | --- |
| `/plan [hedef]` | Plan modu (Shift+Tab/Alt+M aynı): session policy'si `workspace-write`/`exec`/`external-write` `deny` (katman `task`, kaynak `plan-mode`); yazma/komut araçları modele gösterilmez. Hedef verilirse plan modunda tur açar. "go/evet/başla" veya `/go` modu kapatır. |
| `/go [workers]` | Planı burada doğrudan ya da `orchestrate` aracıyla worker'larla uygular. |
| `/workers <hedef>` | Ana ajandan `orchestrate` çağırmasını ister. |
| `/model [tier] [--save]` | TUI'da model seçici (`openModelPicker`); argümanla bu konuşmanın route'unu değiştirir; `--save` yalnız onayla `<home>/session-model.json`'a yazar. |
| `/review [odak]` | Commit'lenmemiş diff'i taze bağlamlı ayrı bir oturumda salt okuma reviewer'a verir (reviewer/complex_worker route'u); "advisory, not harness-verified" etiketli. |
| `/commit [mesaj]` | Değişiklik özeti + önerilen mesaj (model, yoksa sezgisel) + eylem kartı; yalnız insan onayıyla `git add -A && git commit`. |
| `/undo`, `/allow`, `/trust` | K0 davranışı. |
| `/usage`, `/cost` | Oturum/gün istek, girdi/çıktı/cache token, sağlayıcı/model/tier, kota % (header varsa), API key için `~$` tahmini; günlük toplam `<home>/usage/usage.json` (90 gün). `/usage` U3 `UsageView`'dir. |
| `/evidence`, `/why [araç]`, `/graph` | U3 `EvidenceView` / `WhyView` / plan grafiği (worker run'ları, son policy kararı ve onu değiştiren komutlar). |
| `/compact [odak]`, `/context`, `/diff`, `/tasks`, `/permissions`, `/memory`, `/log` | Elle compaction (summary-v1), okuma raporları. |
| `/config [anahtar [değer]]` | Ayar ekranı (§11.1); yalnız kullanıcı yapılandırmasını yazar. |
| `/clear`, `/resume [n\|id]` | Yeni konuşma / son konuşmalar listesi ve geçiş; resume ve `--continue` 3 satırlık "where we were / since then / next" kartı basar. |

Çalışırken yazılan mesaj: worker'lar sürüyorsa `Coordinator.steer`, tur sürüyorsa `driver.steer` (sonraki adım sınırında okunur; tur bitmişse `drainSteers` ile yeni tura taşınır). Esc turu keser; worker'lar sürerken ilk Esc uyarır, ikincisi durdurur. `@yol` ve renderer eklentileri (U1 `Attachment`) digest'li ve boyut sınırlı (dosya 64 KiB, toplam 192 KiB) mesaja eklenir; görüntüler metin kanalı nedeniyle henüz gönderilmez (net uyarı).

**`orchestrate` aracı** (yalnız `session`, `cli/orchestrate-tool.ts`): `{goal, reason, brief?}`; mevcut coordinator'ı turun içinde çalıştırır, plan bloğu ve canlı pano (`setBoard`, `OrchestrationView`) gösterir, ≤ 4 KiB sonuç bloğu döner. Plan modunda reddedilir.

**Legacy (`syn agent --legacy`).** `/plan` (son plan, digest, onay), `/tasks`, `/context`, `/permissions`, `/model`, `/diff`, `/evidence`, `/cancel`, `/memory`, `/help`, `/exit`; yalnız kayıtlı olayları okur.

## 14. Uçtan uca senaryolar (verification.md Seviye 3)

Hepsi gerçek store, policy, gateway, araçlar, izolasyon, context ve coordinator ile, yalnız model scripted adapter'la koşar (ağ yok).

| Senaryo | Test |
| --- | --- |
| Trivial belge düzeltmesi (tek worker, review/onay tekrarı yok) | `harness-e2e-trivial` › "trivial doc fix…" |
| Standart kod değişikliği (plan → packet → diff → test → review → rapor) | `harness-e2e-standard` › "standard code change…" |
| İki çakışan task (paralel yazım yok) | `harness-e2e-conflict` › "two conflicting tasks: an unordered overlap is rejected and the ordered pair never writes in parallel" |
| Crash: tool sonrası, kayıt öncesi (tekrar yok) | `harness-e2e-recovery` › "crash after tool/execution_started: resume records tool/interrupted and never re-runs the call" (gerçek `syn run` süreci öldürülür) |
| Provider timeout/rate limit (sessiz fallback yok) | `harness-e2e-provider` › "rate limit and exhausted quota: failed attempts on the same route, no silent fallback" |
| Headless onay bekleme → exit 3; iptal → 130; kilitli oturum → 8 | `harness-e2e-headless` (üç test) |
| JSONL stdout yalnız geçerli frame | her JSONL testi `parseFrames` ile `validateFrameSequence`, LF-only ve kaçış dizisi yokluğunu doğrular |
| Yüksek riskli değişiklik (zorunlu worktree, ayrı reviewer, kriter başına açık kanıt; `ask`'ta plan ve her etkili eylem insan onaylı; git yoksa daha zayıf izolasyon yerine ret, exit 6) | `harness-e2e-high-risk` (üç test) |
| Çalışırken kullanıcı düzeltmesi (güvenli sınırda steer, orchestrator danışması, `task_spawn`, yeniden sürümlenen plan) | `harness-e2e-steer` › "steering typed during a run is applied at a safe boundary through a re-versioned plan"; birim: `harness-orchestration-delegation` (ask modunda revizyon onayı ve reddi) |
| `ask_user` (etkileşimli cevap; headless → exit 3) | `harness-e2e-ask-user` |
| Kanonik `.ai/` → context ve policy | `harness-cli-canonical` |
| `syn agent`, oturum içi komutlar, resume/fork | `harness-e2e-agent` |
| Login/bildirim, auth status, hafıza kararı denetimi | `harness-e2e-auth-memory` |
| `doctor --runtime` | `harness-e2e-doctor` |

Kapsanmayanlar: "yüksek riskli değişiklik" ve "çalışırken kullanıcı düzeltmesi" Seviye 3 satırları uçtan uca test edilmedi (steer yalnız TTY'de etkin; worktree + review yolu standart senaryoda sınandı).

## 15. Aşama B'de diğer modüllerde yapılan entegrasyon düzeltmeleri

| Modül | Düzeltme | Neden |
| --- | --- | --- |
| orchestration (`coordinator.ts`, `testing.ts`) | `plan/proposed` sonrası ayrıca `plan/state_changed draft → proposed` yazılmıyor; `replayTransitions` planı `proposed` açıyor | I1 projection'ı `plan/proposed`'ı zaten `proposed` sayıyordu; her gerçek run günlüğü recovery'de `session_corrupt` oluyordu (`attempt/started` ile aynı kural) |
| orchestration (`coordinator.ts`) | Retry'dan önce route yeniden çözülür; bloklu route (`RouteBlockedFailure`) için `proposeProviderChange` → onay isteği → yalnız kullanıcı onayıyla `applyProviderChange` | Önceden çözülmüş route retry'da kullanılıyor, kota bitmiş route'a yeniden istek gidiyordu; router'ın `provider-change` akışını çağıran yoktu |
| orchestration (`isolation.ts`, `factories.ts`) | `worktreesRoot` seçeneği | Worktree'ler `SYNORCH_HOME` yok sayılarak `<os home>/.synorch/worktrees` altına açılıyordu |
| memory (`memory-command.ts`) | `root` ve `onDecision` seçenekleri | Vault kökü `SYNORCH_HOME`'u izlemiyordu; `decide` denetim yükleri olay olarak yazılamıyordu |

## 16. Bilinen sınırlar (Aşama B)

- TUI (`pi-tui`) ile `syn agent`/`syn run` gerçek TTY'de manuel denenmedi; otomatik testler plain ve JSONL yolunu kullanır. §9 manuel matris açık.
- `task_spawn` yalnız orchestrator bir güvenli sınırda (steer sonrası) danışılırken kabul edilir; run'ın başka anında orchestrator turu yoktur. Girdinin `packet` alanı bir **plan görevi** biçimindedir (tam `TaskContextPacket`'i harness derler); `tools.md`'deki "packet şeması" ifadesinin bu yorumu bir sözleşme netleştirme isteğidir.
- Steer yalnız TTY'deki `syn agent`'ta girilir; çalışan bir attempt'in sürücüsüne iletilmez (bir sonraki dispatch'e kadar bekler). JSONL/stdin RPC steer'i v1 kapsamı dışında.
- `ask_user` `syn run`'da yalnız etkileşimli (TTY) plain/TUI renderer'da bağlıdır; `syn agent`'ta cevap steer döngüsünden gelir.
- Kanonik model profilleri yalnız ipucudur; route'a dönüşmez (ücretli sağlayıcı seçimi depo metnine bırakılmaz).
- Gerçek hesaplarla (ChatGPT OAuth, Anthropic, `claude` köprüsü) uçtan uca çalışma ve `--probe-model` doğrulanmadı; Linux/macOS host'larda koşulmadı.

## 17. Zengin görünümler (K1-U3, `src/harness/tui/views/**`)

Görünüm modelleri `src/harness/contracts/views.ts`'tedir (şema değil, düz TypeScript tipleri). Veriyi oturum (U2) üretir; renderer yalnız çizer. Her görünüm saf bir `render*(view, ctx)` fonksiyonudur (`ctx`: glyph seti, renk teması, genişlik, saat), pi-tui `Component` biçimine yapısal olarak uyan bileşenlerle bağlanır (pi-tui yalnız `pi-tui-renderer.ts`'te import edilir, ADR-04) ve plain modda aynı metni verir.

| Görünüm | Model | Komut / tetik | Notlar |
| --- | --- | --- | --- |
| Canlı orkestrasyon panosu | `OrchestrationView` | oturum `setBoard(view)` çağırır | Görev başına satır: durum glyph'i (§7.3), rol, model, etkinlik, süre; review kararı. 6 görevden fazlası katlanır. `done: true` olunca özet transcript'e **bir kez** sabitlenir. Plain modda pano yok: `workers:` ve `task i/n key:` değişiklik satırları (§12). |
| Orkestrasyon grafiği | `OrchestrationView` | `/graph` → `showGraph(view)`; panodayken `g` (editör boşsa) veya Ctrl+G | Topolojik seviyeler, kutu çizgili kenarlar (ascii'de `+-\|`), seviye atlayan kenarlar ara slotlardan geçer. Çalışan yol vurgulanır: aktif görev çift çerçeve (`╔═╗`, ascii `#`), kenarlar accent renk. Sığmazsa seviyeler dikey sarılır. Döngü varsa uyarı satırı. |
| Kullanım istatistikleri | `UsageView` | `/usage` → `showView(view)` | Model başına tablo (req, in, out, cache, maliyet), sağlayıcı ve tier başına oturum/bugün çubukları, abonelik kota ölçerleri (%70 sarı, %90 kırmızı), API key için `$` (`~` tahmin). Dar ekranda sütunlar sağdan düşer. |
| Kanıt kartı (UX-04) | `EvidenceView` | `/evidence` → `showView(view)` | Kriter → kanıt (Synorch'un koştuğu komut + exit, reviewer kararı). Rozet: `independently reviewed` / `not independently reviewed`. Worker beyanı `claimed by worker, not run by Synorch` olarak ayrılır. |
| Aksiyon kartı (UX-03) | `ActionView` | `showView(view)` | What / Why / Effect (yerel mi uzak mı, geri alınabilir mi) / Paths / Scope; uyarı renkli çerçeve. |
| Why kartı (X6) | `WhyView` | `/why` → `showView(view)` | Karar, policy katmanı + kaynak, kural ve kod, değiştirme yolu (`/allow …`, `/trust`). |

Renderer kancaları (`ViewHost`): `PiTuiRenderer` ve `PlainLineRenderer` `showView`, `showGraph`, `setBoard` sunar. pi-tui'de pano transcript ile aktivite satırı arasındaki slottadır; pano varken spinner zamanlayıcısı çalışır. Glyph setleri `rich`/`safe`/`ascii` (`safe`: WGL4 + kutu çizgisi, çubuklarda yarım blok; `ascii`: 7-bit), 16 renk, `NO_COLOR` altında tüm token'lar kimliktir. Tüm satırlar genişliğe sığar (60 sütun testli). Testler: `tests/harness-tui-views-render.test.ts`, `tests/harness-tui-views-screen.test.ts` (`@xterm/headless`).

Bilinen sınırlar: `/graph`, `/usage`, `/evidence`, `/why` komutlarının CLI'ye bağlanması ve verinin olaylardan üretilmesi U2/entegrasyon işidir. `g` tuşu yalnız pano canlıyken ve editör boşken grafiğe geçer (yazmaya `g` ile başlamak için önce başka bir karakter girilmeli; Ctrl+G her zaman çalışır). Büyük planlarda (≳12 görev) geniş grafik uzun kenarlar üretebilir; dikey düzen her zaman okunur kalır.
