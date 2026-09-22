# CLI başvurusu: runtime komutları, renderer'lar ve JSONL

> Durum: I5 Aşama A (paralel) teslimi, 2026-09-22. Sözleşme: [CLI ve JSONL](../contracts/cli-and-jsonl.md). Kararlar: [ADR-01](../decisions/ADR-01-package-boundary.md), [ADR-04](../decisions/ADR-04-terminal-renderer.md), [ADR-15](../decisions/ADR-15-headless.md). Kod: `src/cli.ts`, `src/harness/cli/`, `src/harness/tui/`.

Bu belge Aşama A'da **kesinleşen** davranışı anlatır: argüman ayrıştırma, yardım metinleri, exit code'lar, renderer ve renk seçimi, üç renderer'ın kendisi ve terminal yaşam döngüsü. Komutların runtime'a bağlanması (`createRuntime()`, oturum, provider, tool, hafıza) Aşama B'dedir; o zamana kadar ayrıştırılan her runtime komutu `internal` hatasıyla (exit 1) "not wired to the runtime yet (I5 stage B)" der.

## 1. Mevcut komutlarla sınır

- `syn inspect`, `syn init`, `syn sync`, `syn doctor` (ve `syn --help`, `syn --version`, bilinmeyen komut hatası) bayt bayt aynıdır. Kanıt: `tests/cli-legacy-snapshot.test.ts`, fixture `tests/fixtures/cli/legacy-snapshot.json` 6be6748'deki özgün CLI'dan, `src/cli.ts` değiştirilmeden **önce** alındı. Karşılaştırmada yalnız geçici hedef dizin (`<TARGET>`, adı `<TARGET_NAME>`) maskelenir ve yol ayırıcıları tek biçime indirilir; böylece aynı fixture her işletim sisteminde geçerlidir.
- `src/cli.ts` yalnız şu durumda `await import("./harness/cli/index.ts")` yapar: ilk argüman `agent`, `run`, `runs`, `show`, `login`, `logout`, `auth`, `memory` ise veya komut `doctor` ve `--` öncesinde `--runtime` varsa. Diğer her yol eski koddur; runtime modülleri (pi-tui dahil) yüklenmez.
- Üst düzey `syn --help` bilinçli olarak değişmedi (AC-1). Runtime komutları kendilerini `syn <komut> --help` ile belgeler.

## 2. Komutlar

| Komut | Ayrıştırma kuralları |
| --- | --- |
| `syn agent [--resume <ses>] [--fork <ses>[@seq]]` | `--resume` ve `--fork` birlikte kullanılamaz; kimlikler `ses_<ULID>`, `seq` pozitif tamsayı; konumsal argüman yok. |
| `syn run "<hedef>" [--mode jsonl \| --json] [--stream-deltas]` | Tam bir hedef (tırnaklı); `-` hedefi stdin'den okur (Aşama B). `--mode` yalnız `jsonl` alır; `--stream-deltas` JSONL ister; `--plain` JSONL ile birleşmez. |
| `syn runs [--json]` | Konumsal argüman yok. |
| `syn show <run_…\|ses_…> [--json]` | Tam bir run veya session kimliği. |
| `syn doctor --runtime [--probe-model] [--json]` | `--runtime` olmadan runtime doctor çalışmaz (eski `doctor` devreye girer). |
| `syn login <provider> [--method oauth-subscription\|api-key\|cli-bridge] [--profile <ad>] [--device-code]` | Provider ve profil kebab-case; ayrıştırılmış argümanlar I2'nin `authCommand`'ına ham haliyle aktarılır. |
| `syn logout <provider> [--profile <ad>]` | Aynı doğrulama. |
| `syn auth status [--json]` | Tek alt komut `status`. |
| `syn memory status\|search\|show\|related\|review\|accept\|reject\|open\|reindex …` | Alt komut adı doğrulanır; geri kalan argümanlar I6'nın `memoryCommand`'ına aynen gider. |

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
| AC-5, AC-6 | Aşama B (uçtan uca senaryolar, `doctor --runtime --json`) |

## 9. Manuel çapraz platform doğrulaması (açık)

[Çapraz platform listesindeki](../research/tui/cross-platform-checklist.md) P0 satırları otomatik testle kapanmaz; Aşama B'de gerçek oturumla işaretlenecek:

- Windows Terminal (PowerShell 7, Windows PowerShell 5.1, cmd) ve klasik conhost: raw mod, Shift+Enter, Shift+Tab (native VT input yardımcısının pnpm altında yüklenmesi), Türkçe klavye/AltGr, sağ tık yapıştırma, 16 KiB parçalamayla uzun transcript'te viewport, `chcp 437` sonrası codepage geri yükleme, pencere kapatma (SIGHUP) sonrası kabuk durumu.
- macOS Terminal.app/iTerm2, Linux GNOME Terminal/kitty, SSH (Windows→Linux, macOS→Linux): çıkışta `stty -a` temiz, ESC zaman aşımı, geç tuş sızıntısı yok.
- DEC 2026 desteklemeyen terminalde titreme; 200 token/s stream'de CPU ve p95 frame süresi (ölçülmedi).
- GitHub Actions üç OS'ta non-TTY JSONL fixture'ı ve pipe/yönlendirme (`| cat`, `> out.jsonl`, `| sleep 30` ile EPIPE).
- Ekran okuyucu (NVDA, VoiceOver) ile `--plain` akışı.
