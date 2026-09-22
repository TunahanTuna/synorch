# Çapraz platform TUI test kontrol listesi

> Statü: araştırma; ADR-04 deneyi ve her `@earendil-works/pi-tui` yükseltmesi için önerilen manuel ve otomatik test listesi. Uygulanmadı. İnceleme tarihi: 2026-09-22. Hedef runtime: Node `>=24`.

Bağlam: [TUI araştırması](./README.md), [pi agent kalıpları](./pi-agent-patterns.md), [doğrulama planı](../../delivery/verification.md).

## A. Platform gerçekleri (Node 24)

| Konu | Bilgi | Kaynak / statü |
| --- | --- | --- |
| Raw mode | `setRawMode(true)` girdiyi karakter karakter verir; echo ve özel işleme kapanır; **Ctrl+C artık SIGINT üretmez**. Windows'ta console input buffer'a yazma izni gerekir. `'io'` modu Windows'ta yok. | [Node tty](https://nodejs.org/api/tty.html) [doğrulandı] |
| Windows sinyalleri | SIGINT raw mode'da üretilmez. SIGBREAK = Ctrl+Break. SIGHUP = console penceresi kapanınca, temizlik için ~10 s. SIGWINCH libuv'nin resize algısıyla üretilir; emülatörlerde emüle edilir ve gecikebilir; readable handle için raw mode'a bağlıdır. | [libuv signal](https://docs.libuv.org/en/v1.x/signal.html) [doğrulandı] |
| VT input | libuv `ReadConsoleInputW` modifier bilgisini düşürür. `ENABLE_VIRTUAL_TERMINAL_INPUT` (0x0200) `setRawMode(true)`'dan **sonra** açılmalı, çünkü raw mode bayrakları sıfırlar. | pi-tui `src/terminal.ts` yorumu [doğrulandı, upstream iddiası] |
| ConPTY yazma boyutu | Tek yazma ~32–64 KB'ı aşınca Windows Terminal viewport'u kayıyor. OMP 16 KiB UTF-8 byte parçalıyor. | OMP `packages/tui/src/terminal.ts` [doğrulandı, upstream iddiası] |
| Codepage | Child process console codepage'ini 437/850'ye çevirirse kutu karakterleri bozulur. | OMP aynı dosya [doğrulandı, upstream iddiası] |
| Renk | `getColorDepth()`/`hasColors()` `FORCE_COLOR=0..3`, `NO_COLOR`, `NODE_DISABLE_COLORS`'u dikkate alır. `util.styleText()` varsayılan olarak stream TTY değilse veya `NO_COLOR` varsa kaçış dizisi üretmez (Node v24.11.1'de yerelde denendi). | Node tty belgesi; yerel deneme [doğrulandı] |
| NO_COLOR | "present and not an empty string (regardless of its value)" → renk yok. Kullanıcı config'i ve CLI bayrağı `NO_COLOR`'u ezebilir. | [no-color.org](https://no-color.org/) [doğrulandı] |
| Unicode | `Intl.Segmenter` (grapheme) ve `/\p{RGI_Emoji}/v` Node 24'te mevcut (yerelde denendi). East Asian Width için `get-east-asian-width`. | [doğrulandı] |
| Senkron çıktı | DEC 2026; bilinmeyen terminal yok sayar. Windows Terminal desteği ikincil kaynaklara göre 1.23.20211.0 / 1.24 Preview'da. | [spec](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036) [doğrulanmadı] |

## B. Mod seçimi (uygulanacak kural önerisi)

```text
--mode jsonl | --json         → JsonlRenderer    (stdout yalnız JSONL, her şey diğer stderr)
--plain | SYN_PLAIN=1 | TERM=dumb | !stdin.isTTY | !stdout.isTTY
                               → PlainLineRenderer (yalnız append, imleç hareketi yok)
aksi halde                     → PiTuiRenderer
renk: --color=always|never > config > NO_COLOR > FORCE_COLOR > stream.hasColors()
```

CI tespiti (`CI` env) tek başına modu değiştirmez; CI'da TTY yoksa zaten düz moda düşülür. Sözde TTY'li CI koşucuları için `--plain` önerilir.

## C. Test matrisi

Öncelik: **P0** = ADR-04 kabul koşulu, **P1** = ilk sürüm öncesi, **P2** = iyileştirme.

| Ortam | Kabuk / host | Öncelik |
| --- | --- | --- |
| Windows 11, Windows Terminal (stable) | PowerShell 7, Windows PowerShell 5.1, cmd.exe | P0 |
| Windows 11, klasik conhost (WT varsayılan değilken `conhost.exe`) | cmd.exe | P0 |
| Windows, VS Code entegre terminali | PowerShell | P1 |
| Windows, Git Bash (mintty) | bash | P1 (mintty ConPTY değil; raw mode davranışı farklı olabilir) |
| WSL2 Ubuntu, Windows Terminal içinde | bash | P1 |
| macOS, Terminal.app ve iTerm2 | zsh | P0 |
| macOS, Ghostty veya kitty | zsh | P2 |
| Linux, GNOME Terminal (VTE) ve kitty | bash | P0 |
| tmux ve GNU screen içinde (Linux) | bash | P1 |
| SSH: Windows Terminal → Linux, macOS → Linux | OpenSSH | P0 |
| SSH: Linux → Windows OpenSSH Server | PowerShell | P2 |
| GitHub Actions `ubuntu-latest`, `windows-latest`, `macos-latest` | non-TTY | P0 |
| Pipe/yönlendirme: `syn run ... | cat`, `> out.txt`, `2>err.txt` | tüm OS | P0 |

## D. Kontrol listesi

### D1. Başlatma ve kapanış (P0)

- [ ] Başlangıçta raw mode açılıyor. Çıkışta (normal, Ctrl+C ×2, `/exit`, hata) eski raw durumu, imleç görünürlüğü, bracketed paste (`?2004l`), Kitty (`\x1b[<u`), modifyOtherKeys (`\x1b[>4;0m`) ve alt-screen geri alınıyor. Kabuk bozulmuyor (`stty -a` / PowerShell'de yazı echo'su).
- [ ] Yakalanmamış exception ve `SIGTERM`/`SIGHUP` (Windows'ta pencere kapatma) yolunda acil geri yükleme çalışıyor; session log flush ediliyor.
- [ ] SSH üzerinden çıkışta geç gelen tuş/Ctrl+D üst kabuğa sızmıyor (stdin drain + `pause()`).
- [ ] Windows'ta çıkış sonrası console codepage ve VT modları başlangıçtaki gibi.

### D2. Klavye ve girdi (P0)

- [ ] Ctrl+C: stream sırasında isteği iptal eder (`stopReason: aborted`), boşta ikinci basışta güvenli kapanış sorar. Raw mode'da `\x03` olarak alındığı doğrulanır.
- [ ] Esc: tek basış iptal. Alt+tuş ile karışmıyor. SSH'de ESC zaman aşımı (100 ms) sonrası doğru ayrışıyor.
- [ ] Enter gönderir, Shift+Enter yeni satır ekler; Windows Terminal, conhost, Terminal.app ve SSH'de ayrı ayrı. Çalışmayan ortamda `Ctrl+J` alternatifi belgeleniyor.
- [ ] Shift+Tab, Tab'dan ayırt ediliyor (Windows'ta native VT input yardımcısı yüklenemezse `syn doctor --runtime` uyarıyor).
- [ ] Ctrl+Backspace / Alt+Backspace kelime siliyor; düz Backspace tek karakter (Windows Terminal ham `0x08` davranışı).
- [ ] Ok tuşları, Home/End, PageUp/PageDown, Ctrl+←/→ kelime atlama.
- [ ] Türkçe klavye: `ğüşıöç İ` girişi, AltGr kombinasyonları (`@`, `{`, `[` TR-Q düzeninde) Windows'ta karakter olarak geliyor, kısayol sanılmıyor.
- [ ] IME (Japonca/Çince) aday penceresi imleç konumunda (P2).

### D3. Yapıştırma (P0)

- [ ] Bracketed paste: 1 satır, 500 satır ve 1 MB metin tek olay olarak geliyor; satır sonları gönderme tetiklemiyor; büyük yapıştırma `[paste #n +N lines]` işaretine indirgeniyor.
- [ ] Windows Terminal Ctrl+V ve sağ tık yapıştırma, conhost sağ tık, SSH içinden yapıştırma.
- [ ] CRLF içeren yapıştırma LF'e normalize ediliyor.
- [ ] Yapıştırılan metindeki escape dizileri (`\x1b[2J` vb.) çalıştırılmıyor, görünür/temizlenmiş gösteriliyor.

### D4. Render, stream ve resize (P0)

- [ ] 200 token/s stream, 10 dk: titreme yok (Windows Terminal, conhost, iTerm2, GNOME); CPU ve bellek kaydediliyor.
- [ ] 10k satırlık transcript'e dönüş (`--resume`): Windows Terminal'de viewport son satırda (ConPTY parçalama). İlk ~30 satırda takılma yok.
- [ ] Pencere daraltma/genişletme stream sırasında: satır taşması hatası yok; tam yeniden çizim sonrası içerik doğru; Windows'ta resize algılanıyor (gecikme notu).
- [ ] 40 sütun ve 300 sütun terminalde düzen bozulmuyor; `render(width)` hiçbir satırda `width`'i aşmıyor (otomatik test).
- [ ] Markdown: kod bloğu, tablo, uzun URL, iç içe liste; ANSI stil satır sonunda sıfırlanıyor.
- [ ] Model çıktısındaki ham kaçış dizileri (OSC 52 clipboard, `\x1b]0;` başlık, `\x1b[2J`) terminale geçmiyor.
- [ ] Tool çıktısında `\r` ilerleme çubukları ve UTF-8 olmayan byte'lar render'ı bozmuyor.
- [ ] DEC 2026 desteklemeyen terminalde (conhost, eski VTE) görsel artık yok.

### D5. Unicode genişliği (P0/P1)

- [ ] Türkçe karakterler, CJK (`漢字`), emoji (`👍`, ZWJ `👩‍💻`, bayrak `🇹🇷`), birleşik aksan (`é` = e + U+0301) hizalaması; kutu kenarları kaymıyor.
- [ ] Sekme karakteri genişliği tutarlı.
- [ ] Windows'ta bir child process (`chcp 437` çalıştıran komut) sonrası kutu çizgileri mojibake olmuyor.

### D6. Renk ve yetenek (P0)

- [ ] `NO_COLOR=1` → hiç SGR renk dizisi yok (stdout bayt taraması). `NO_COLOR=` (boş) → renk açık.
- [ ] `FORCE_COLOR=0` → renk yok; `FORCE_COLOR=3` pipe'ta bile truecolor (yalnız açıkça istenince).
- [ ] `--color=never` `FORCE_COLOR`'u, `--color=always` `NO_COLOR`'u eziyor.
- [ ] `TERM=dumb` → düz mod.
- [ ] OSC 8 hyperlink yalnız tespit edilen terminallerde; aksi halde `metin (url)`.
- [ ] Açık ve koyu terminal temasında okunabilirlik (OSC 11 arka plan sorgusu yanıtsız kalırsa varsayılan).

### D7. Non-TTY, CI ve makine modu (P0)

- [ ] `syn run "…" | cat`: kaçış dizisi yok, spinner yok, satırlar sıralı; exit code doğru.
- [ ] `syn run --json "…" > out.jsonl`: her satır geçerli JSON, `schema_version/run_id/seq/type` var; stdout'ta tek bir insan metni baytı yok; loglar stderr'de.
- [ ] JSONL okuyucu testleri `readline` değil LF-split kullanıyor; U+2028 içeren model metni tek kayıt kalıyor.
- [ ] Yavaş tüketici (`| sleep 30`): süreç çökmeden bekliyor veya `EPIPE`'ta temiz çıkıyor.
- [ ] stdin pipe (`echo "görev" | syn run -`) ve stdin kapalıyken onay gereken eylem: varsayılan **ret** ve açıklayıcı exit code.
- [ ] GitHub Actions üç OS'ta aynı JSONL fixture'ını üretiyor (zaman damgası/ID normalize edilerek).

### D8. Erişilebilirlik (P1)

- [ ] `--plain` modunda NVDA (Windows) ve VoiceOver (macOS) ile akış okunabiliyor; spinner yerine seyrek durum satırları.
- [ ] Renk tek bilgi kanalı değil (hata/uyarı metin önekiyle de belirtiliyor).
- [ ] Onay istemleri düz modda tek satırlık, net `[y/N]` sorusu.

## E. Otomasyon önerisi

- `@xterm/headless` tabanlı sanal terminal (pi-tui testleriyle aynı yaklaşım, `test/virtual-terminal.ts`) ile render snapshot'ları: genişlik 40/80/200, CJK/emoji fixture'ları, resize dizisi.
- Girdi fixture'ları: Kitty, modifyOtherKeys, legacy ve Windows VT dizileri için `matchesKey` tablo testleri.
- Makine modu için byte düzeyinde "stdout'ta `\x1b` yok" ve "her satır JSON" kontrolleri; CI matrisinde üç OS.
- Manuel P0 satırları her pi-tui yükseltmesinde PR şablonunda işaretlenir; sonuçlar `delivery/verification.md` kanıt tablosuna bağlanır.
