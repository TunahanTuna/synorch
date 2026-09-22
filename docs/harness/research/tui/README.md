# Terminal UI araştırması (ADR-04 girdisi)

> Statü: araştırma ve ADR-04 için öneri; runtime uygulanmadı, bağımlılık eklenmedi. İnceleme tarihi: 2026-09-22. Ürün sahibi kararı: terminal arayüzü **bütün işletim sistemlerinde** (Windows Terminal/PowerShell/cmd, macOS, Linux, SSH) çalışmalı ve Oh My Pi'nin kullandığı yaklaşımı referans almalı.

İlgili dosyalar: [pi/OMP agent kalıpları](./pi-agent-patterns.md), [çapraz platform test listesi](./cross-platform-checklist.md), [Oh My Pi incelemesi](../oh-my-pi.md), [CLI deneyimi](../../design/cli-experience.md), [açık kararlar](../../delivery/decisions.md).

## İncelenen kaynaklar ve sabitlenen commit'ler

| Kaynak | Commit / sürüm | Not |
| --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) (eski adı `badlogic/pi-mono`; GitHub 301 yönlendirmesi doğrulandı) | `27c072e98f613edb1da4bc6377d939b1c8e03fd1` (2026-09-22) | Upstream monorepo; `packages/tui`, `packages/agent`, `packages/ai`, `packages/coding-agent` |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `8cd6f8c619e89e935b6c6c5c91f6a4d20f6d7a75` (2026-09-22) | pi fork'u; Bun runtime |
| [vadimdemedes/ink](https://github.com/vadimdemedes/ink) | `02ae1e59e7c288e971616100c4c11bcca6b5761b` (2026-09-21) | React tabanlı alternatif |
| npm registry | 2026-09-22 sorgusu | Sürüm, lisans, `engines`, bağımlılıklar aşağıda |

Aşağıda **[doğrulandı]** kaynak kodu, `package.json` veya npm registry çıktısında görülen bilgiyi; **[çıkarım]** bizim yorumumuzu; **[doğrulanmadı]** ikincil kaynağa dayanan ve testle kapanması gereken bilgiyi gösterir.

## 1. OMP ve pi hangi TUI'yi kullanıyor?

**[doğrulandı]** İki ayrı ama akraba paket var:

| Paket | Sürüm | Lisans | Runtime | Bağımlılıklar |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-tui` (upstream, pi) | `0.87.0` | MIT | `node >=22.19.0` | `marked@18.0.11`, `get-east-asian-width@1.6.0` (tam sürüm sabit) |
| `@oh-my-pi/pi-tui` (OMP fork'u) | `18.2.9` | MIT | `bun >=1.3.14` | 8 iç OMP paketi: `pi-agent-core`, `pi-ai`, `pi-catalog`, `pi-natives` (Rust N-API), `pi-utils`, `pi-wire`, `omptype`, `snapcompact` |
| `@mariozechner/pi-tui` | `0.73.1` | MIT | `node >=20` | **deprecated**: "please use @earendil-works/pi-tui instead going forward" |

- OMP'nin `docs/porting-from-pi-mono.md` dosyası, upstream'den port ederken `@mariozechner/pi-tui` / `@earendil-works/*` scope'larının `@oh-my-pi/*` ile değiştirildiğini ve kodun Bun API'lerine taşındığını açıkça anlatıyor. Yani **OMP'nin TUI'si pi-tui'nin Bun'a özgü fork'udur**.
- OMP fork'u kaynakta `Bun.env`, `Bun.stringWidth` ve `bun:ffi` (`dlopen("kernel32.dll")`) kullanıyor (`packages/tui/src/utils.ts`, `packages/tui/src/terminal.ts`); ayrıca `@oh-my-pi/pi-natives` üzerinden Rust native modülüne (fuzzy find, diff, key parsing) bağlı. **Node 24 hedefli Synorch için doğrudan kullanılamaz.**
- Upstream `@earendil-works/pi-tui` ise Node'da çalışır, iki küçük saf JS bağımlılığı vardır ve Windows/macOS/Linux için opsiyonel prebuilt native yardımcı (`native/<platform>/prebuilds/*.node`) taşır. Bu yardımcı yüklenemezse `try/catch` ile atlanır (`src/native-platform.ts`).

**Sonuç [çıkarım]:** "OMP'nin kullandığını referans al" kararının Node 24 üzerindeki karşılığı `@earendil-works/pi-tui`'dir. OMP fork'u; ConPTY, codepage ve terminal yetenek tespiti gibi Windows dersleri için **okuma referansı** olarak kullanılır.

## 2. pi-tui mimarisi (upstream, `packages/tui/src`)

| Konu | Bulgu [doğrulandı] | Dosya |
| --- | --- | --- |
| Bileşen modeli | `Component { render(width): string[]; handleInput?(data); handleMouse?(e); invalidate() }`. Her satır `width`'i aşmamalı; aşarsa TUI hata verir. Retained bileşen ağacı, React/JSX yok. | `README.md`, `src/tui.ts` |
| Renderer'lar | `TuiMainScreen` (ana buffer, terminal scrollback korunur) ve `TuiAltScreen` (alternate buffer, uygulama sahipli scroll, mouse, arama). Ortak `TUI` arayüzü. | `src/tui-main-screen.ts`, `src/tui-alt-screen.ts` |
| Diferansiyel render | Önceki satırlar (`previousLines`) ile yenileri karşılaştırılır; ilk/son değişen satır bulunur ve yalnızca o aralık yeniden yazılır. Genişlik değişimi, (Termux hariç) yükseklik değişimi, görünür viewport üstünde değişiklik veya içerik küçülmesinde tam yeniden çizim (`\x1b[2J\x1b[H\x1b[3J`). | `src/tui-main-screen.ts` `doRender()` |
| Senkron çıktı | Her frame `\x1b[?2026h` … `\x1b[?2026l` (DEC mode 2026) ile sarılır. Desteklemeyen terminal bu diziyi yok sayar. | `src/tui-main-screen.ts` |
| Frame hızı | `requestRender()` `process.nextTick` ile birleştirilir; `MIN_RENDER_INTERVAL_MS = 16` ile ~60 fps üst sınır. Klavye girdisi throttle'ı atlar (`requestImmediateRender`), çünkü kod yorumuna göre Windows'ta `setTimeout(0)` bile 16 ms sürebiliyor. | `src/tui.ts` |
| Yazma | `BoundedTerminalWriter` çıktıyı surrogate çiftini bölmeden sınırlı parçalarla yazar. | `src/tui-main-screen.ts` |
| Satır sıfırlama | Her satır sonuna SGR reset ve OSC 8 reset eklenir; stil satırlar arasında taşmaz. | `README.md` |
| Girdi ayrıştırma | `StdinBuffer` parçalı gelen escape dizilerini birleştirir (OpenTUI'den MIT ile alınmış), bracketed paste'i tek olay olarak verir. ESC zaman aşımı yerelde 10 ms, SSH'de (`SSH_CONNECTION`/`SSH_TTY`) 100 ms; `PI_TUI_ESC_TIMEOUT` ile ayarlanır. | `src/stdin-buffer.ts`, `src/terminal.ts` |
| Klavye protokolleri | Başlangıçta Kitty keyboard protocol sorgusu + DA sentinel; yanıt yoksa xterm `modifyOtherKeys` (`\x1b[>4;2m`) fallback. `matchesKey(data, "ctrl+c")` gibi yardımcılar. | `src/terminal.ts`, `src/keys.ts` |
| Bracketed paste | `\x1b[?2004h` açılır; Editor büyük yapıştırmayı `[paste #1 +123 lines]` işaretine indirger. | `src/terminal.ts`, `src/components/editor.ts` |
| Resize | `process.stdout.on("resize")`; POSIX'te suspend/resume sonrası `SIGWINCH` kendine gönderilir (EACCES yutulur). | `src/terminal.ts` |
| Unicode genişliği | ASCII hızlı yol, `Intl.Segmenter` ile grapheme, `get-east-asian-width` ve `/\p{RGI_Emoji}/v`; önbellekli `visibleWidth()`. CJK ve regional indicator için regresyon testleri var. | `src/utils.ts`, `test/regression-*.test.ts` |
| Editor | Çok satırlı editor: autocomplete, dosya/slash komut tamamlama, kill ring, undo, geçmiş, IME için `CURSOR_MARKER` ile donanım imleci konumlandırma. | `src/components/editor.ts` (2470 satır) |
| Markdown | `marked` ile token'layıp ANSI satırlara render; LaTeX desteği ayrı dosyada. | `src/components/markdown.ts`, `src/latex.ts` |
| Görsel | Kitty ve iTerm2 grafik protokolü; tmux/screen altında kapalı. Windows Terminal için `images: null` (sixel yok). | `src/terminal-image.ts` |
| Overlay | Anchor/yüzde/mutlak konumlu modal katmanlar, focus yığını. | `src/tui.ts` |
| Windows | `setRawMode(true)` **sonrası** native yardımcıyla `ENABLE_VIRTUAL_TERMINAL_INPUT` (0x0200) açılır; aksi halde libuv `ReadConsoleInputW` modifier bilgisini düşürür ve Shift+Tab düz `\t` gelir. Windows'ta Shift+Enter, native modifier durumu okunarak `\x1b[13;2u`'ya normalize edilir. Ham `0x08` Windows Terminal'de Ctrl+Backspace kabul edilir. | `src/terminal.ts`, `src/keys.ts`, `native/win32/src/win32-platform.c` |
| Kapanış | `stop()`: bracketed paste ve Kitty/modifyOtherKeys kapatılır, stdin `pause()` edilir (SSH üzerinde Ctrl+D'nin üst kabuğu kapatma yarışını önlemek için), raw mode eski haline döner. `drainInput()` geç gelen key-release olaylarını tüketir. | `src/terminal.ts` |
| Test | `@xterm/headless` üzerinde `VirtualTerminal` ile render doğrulaması; `node --test`. | `test/virtual-terminal.ts` |
| Erişilebilirlik | Ekran okuyucu modu **yok** (kaynakta `screen reader`/`accessib` eşleşmesi bulunmadı). | — |

### OMP fork'undan alınacak Windows dersleri [doğrulandı, OMP `packages/tui/src/terminal.ts`]

- **ConPTY yazma parçalama:** Tek `WriteFile` ~32–64 KB'ı aşınca Windows Terminal viewport takibini kaybediyor; OMP yazmaları **UTF-8 byte** bazında 16 KiB'lık, tercihen `\n` sınırında parçalıyor (`chunkForConPTY`). Upstream pi-tui de sınırlı yazıcı kullanıyor; Synorch adapter'ı bu sınırı byte cinsinden doğrulamalı.
- **Console codepage koruması:** Araç olarak başlatılan child process'ler (ör. PHP CLI) console output codepage'ini 437/850'ye çevirebiliyor; sonuç kutu çizgilerinde mojibake. OMP her yazmadan önce `GetConsoleOutputCP` kontrol edip `65001`'e geri alıyor. Node'da FFI yok; bu ya küçük bir native yardımcı ya da child process'leri ayrı console/pipe ile başlatma kuralı gerektirir **[çıkarım]**.
- **Acil terminal geri yükleme:** Crash/sinyal yolunda `?2026l`, autowrap, cursor-key modu, alt-screen çıkışı ve Kitty pop dizileri tek fonksiyonda (`emergencyTerminalRestore`).
- WSL da ConPTY üzerinden geçtiği için aynı kısıtları taşır (`isConPTYHosted`).

## 3. Karşılaştırma: pi-tui vs Ink vs minimal ANSI

| Ölçüt | `@earendil-works/pi-tui@0.87.0` | `ink@7.1.1` | Minimal ANSI (kendi kodumuz) |
| --- | --- | --- | --- |
| Model | Retained bileşen, `render(width): string[]` | React 19 reconciler + Yoga flexbox | Satır/durum yazıcı |
| Runtime bağımlılığı | 2 paket (`marked`, `get-east-asian-width`) + opsiyonel prebuilt `.node` | 25 doğrudan bağımlılık (`react-reconciler`, `yoga-layout`, `ws`, `chalk` …) + `react >=19.3` peer | 0 (Node built-in; `util.styleText`, `Intl.Segmenter`) |
| Paket boyutu | 188 dosya, ~2.9 MB unpacked (native prebuild'ler dahil) | orta; React ve Yoga WASM ek | — |
| Lisans | MIT | MIT | — |
| Olgunluk | 0.x; yeni scope'ta 4.5 ayda 48 sürüm; 2026'da en az 5 "Breaking Changes" başlığı (0.33, 0.47, 0.61, 0.75, 0.85) | 2013'ten beri; 7.x; geniş ekosistem | Bizim bakım yükümüz |
| Windows | Açık kod yolları: VT input, Shift+Enter, Ctrl+Backspace, WT yetenek tespiti, sağ tık yapıştırma | `win32`'de fullscreen frame'ler arası tam temizleme (kaynak yorumu: Windows console viewport hatası, #969) | Her şeyi kendimiz öğrenip test ederiz |
| SSH | ESC zaman aşımını SSH'de 100 ms'ye çıkarır; çıkışta stdin drain | Özel işlem görülmedi (incelemede) | Kendimiz |
| CI / non-TTY | Kütüphane TTY varsayar; pi uygulaması non-TTY'de `print` moduna geçer (`resolveAppMode`) | `interactive` otomatik: CI veya `!isTTY` ise ANSI/imleç/sync kapalı, yalnız son frame | Doğal olarak uygun |
| Stream performansı | Satır diff + 16 ms throttle + sync output; bileşen içi satır önbelleği | Varsayılan tam yeniden çizim; `incrementalRendering` opsiyonel (varsayılan `false`), `maxFps` 30 | Append-only yazım çok hızlı; canlı bölge yönetimi elle |
| Flicker | CSI 2026 + diff | CSI 2026 (`write-synchronized.ts`) | Kendimiz eklemeli |
| Editor/girdi | Hazır çok satırlı editor, autocomplete, IME, Kitty protokolü | `useInput`, `usePaste`; çok satırlı editor ekosistemden | Sıfırdan (en pahalı kısım) |
| Markdown | Dahili | Ek paket gerekir | Ek paket veya düz metin |
| Ekran okuyucu | Yok | Temel ARIA alt kümesi (`isScreenReaderEnabled`, `INK_SCREEN_READER=true`) | Düz satır modu doğal olarak okunur |
| Test | `@xterm/headless` sanal terminal | `ink-testing-library` ekosistemi | Snapshot kolay |
| Synorch uyumu | ESM, TS tipli, Node 24 uyumlu; React yok | React/JSX build ayarı gerektirir | Tam uyum |

## 4. ADR-04 önerisi

**Öneri:** İnteraktif TTY modu için `@earendil-works/pi-tui` **tam sürüme sabitlenerek** (`"@earendil-works/pi-tui": "0.87.0"`, `^` yok) kullanılsın; ancak yalnızca Synorch'un kendi `TerminalRenderer` portu arkasındaki tek bir adapter modülünden import edilsin. TTY olmayan ortamlar için pi-tui hiç yüklenmesin; düz satır modu ve JSONL ayrı, bağımlılıksız renderer'lar olsun.

```text
AgentSession events (renderer-agnostic)
   ├── PiTuiRenderer      stdin+stdout TTY, --plain yok      → @earendil-works/pi-tui
   ├── PlainLineRenderer  !isTTY, TERM=dumb, --plain, a11y    → yalnız append, util.styleText
   └── JsonlRenderer      --mode jsonl / --json               → stdout yalnız JSONL, log stderr
```

**Gerekçe:**

1. **Ürün kararıyla uyum:** OMP'nin TUI soyu budur; Node'da çalışan resmi upstream biçimi `@earendil-works/pi-tui`'dir. `@oh-my-pi/pi-tui` Bun ve Rust native zinciri gerektirdiği için elenir [doğrulandı].
2. **Windows ve SSH olgunluğu:** VT input, modifier normalizasyonu, SSH ESC zaman aşımı ve stdin drain gibi gerçek kullanıcı hatalarından çıkmış kod yolları hazır. Minimal ANSI ile bunları yeniden keşfetmek aylar sürer [çıkarım].
3. **Streaming:** Satır diff, sync output ve 16 ms birleştirme; token akışında frame başına yalnız değişen kuyruk satırlarını yazar. Ink'in varsayılanı tam yeniden çizimdir [doğrulandı: README seçenekleri].
4. **Bağımlılık ayak izi:** 2 saf JS bağımlılığı; bugünkü `zod`, `yaml` sadeliğine Ink'in 25 bağımlılık + React'inden çok daha yakın.
5. **Lisans:** MIT; gerekirse vendor etmek serbest (telif satırı korunarak).

**Risk ve önlemler:**

| Risk | Önlem |
| --- | --- |
| 0.x ve sık breaking change | Tam sürüm pin; yükseltme ayrı PR ve [çapraz platform listesi](./cross-platform-checklist.md) ile. Adapter dışında import yasak (lint kuralı adayı). |
| Upstream yön değiştirir veya terk edilir | MIT; `packages/tui/src` belirli commit'ten `vendor/pi-tui`'ye alınabilir. Adapter sayesinde Ink'e geçiş de tek modülde kalır. |
| Ekran okuyucu desteği yok | `PlainLineRenderer` erişilebilirlik yolu: `--plain` bayrağı ve `SYN_PLAIN=1`; canlı bölge/imleç oyunu yok, yalnız append. |
| Native prebuild'ler (clipboard, VT input) | Yüklenemezse sessizce atlanıyor; Windows'ta etkisi Shift+Tab/Shift+Enter ayrımı. `syn doctor --runtime` bu durumu raporlamalı. |
| Console codepage'i child process değiştirir | Tool runner child'ları stdio pipe ile başlatır (console miras almaz); Windows testinde mojibake senaryosu. |
| `marked` sürümü sabit (`18.0.11`) | Model çıktısı güvenilmez girdi: terminal escape dizileri render öncesi temizlenmeli (bizim sorumluluğumuz). |

**Reddedilen alternatifler:**

- **Ink:** Olgun, ekran okuyucu desteği var. Ancak React/Yoga bağımlılığı, JSX build'i ve varsayılan tam yeniden çizim var; OMP referansı da değil. Adapter arkasında ikinci aday olarak saklı kalır.
- **Minimal ANSI (tamamen kendi kodumuz):** Plain ve JSONL renderer'lar için zaten seçiliyor. İnteraktif editor, Kitty/modifyOtherKeys, IME ve paste için maliyeti yüksek, test kapsamı zayıf olur.
- **Vendor etmek (ilk günden):** Güncelleme almayı zorlaştırır. Sadece upstream uyumsuzluğunda devreye girecek plan B.

**ADR'yi kapatacak deney (Delivery M0/M1):** Kısa bir spike ile pi-tui üzerine editor + streaming markdown + tool kartı. [Kontrol listesindeki](./cross-platform-checklist.md) P0 satırlar Windows Terminal (PowerShell 7 ve cmd), conhost, macOS Terminal/iTerm2, Linux (GNOME/kitty), SSH (Windows→Linux, macOS→Linux) ve GitHub Actions `windows-latest`/`ubuntu-latest` non-TTY'de geçmeli. Ölçüm: 10k satır transcript'te frame süresi p95 < 16 ms, 200 token/s stream'de CPU < %25 tek çekirdek (hedefler taslaktır).

## 5. Bağımlılık özeti (npm, 2026-09-22)

| Paket | Sürüm | Rol | Karar adayı |
| --- | --- | --- | --- |
| `@earendil-works/pi-tui` | `0.87.0` | İnteraktif TUI | Ekle (tam pin, adapter arkasında) |
| `marked` | `18.0.11` (pi-tui pin'i; registry en son `18.0.14`) | Geçişli | pi-tui ile gelir |
| `get-east-asian-width` | `1.6.0` (pin; en son `1.7.0`) | Geçişli | pi-tui ile gelir |
| `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` | `0.87.0` | Agent döngüsü / provider | **Eklenmez**; `pi-ai` Anthropic/OpenAI/Google/Bedrock SDK'larını çeker. Yalnız kalıplar alınır ([ayrıntı](./pi-agent-patterns.md)). |
| `@oh-my-pi/pi-tui` | `18.2.9` | OMP TUI | Eklenmez (Bun) |
| `ink` | `7.1.1` | Alternatif | Eklenmez; plan B |
| `@xterm/headless` | `5.5.0` (pi-tui devDependency) | Render testleri | devDependency adayı |

## 6. Bilinmeyenler

- Windows Terminal'in DEC 2026 desteği: ikincil kaynaklara göre Preview 1.24.2372.0'da geldi ve stable 1.23.20211.0'a backport edildi ([microsoft/terminal PR #18826](https://github.com/microsoft/terminal/pull/18826), [spec](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036)) **[doğrulanmadı]**. Desteklemeyen terminalde dizi yok sayılır; flicker testi gerekir.
- Klasik conhost penceresi (WT olmadan `cmd.exe`): pi-tui `isWindowsConsole` için truecolor varsayıyor; eski Windows 10 build'lerinde doğrulanmalı.
- pi-tui'nin Node 24 + pnpm altında prebuilt `.node` dosyalarını bulması (`getNativeModuleCandidates`) Windows'ta test edilmeli.
