# Terminal UX araştırması: Oh My Pi / pi, Claude Code, Hermes Agent

> Statü: araştırma + tasarım önerisi. İnceleme tarihi: 2026-09-23. Ürün sahibi, `syn agent` deneyimini zayıf buldu ve Oh My Pi, Claude Code ve Hermes Agent'ı UX referansı olarak istedi. Bu belge referansları inceliyor. Sonuçta çıkan tasarım [TUI deneyimi spesifikasyonu](../../design/tui-experience.md)'ndadır. Renderer seçimi (pi-tui) [ADR-04](../../decisions/ADR-04-terminal-renderer.md) ve [TUI araştırması](../tui/README.md) ile zaten verildi. Bu belge **neyin gösterileceğini** inceler, neyle çizileceğini değil.

Kanıt etiketleri [TUI araştırması](../tui/README.md) ile aynıdır: **[doğrulandı]** kaynak kodunda veya resmi belgede görüldü; **[gözlem]** ürünün yaygın bilinen davranışı veya üçüncü taraf anlatımı, resmi belgede yok, sürümle değişebilir; **[çıkarım]** bizim yorumumuz.

## İncelenen kaynaklar

| Kaynak | Sürüm | Kapsam |
| --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) (eski `badlogic/pi-mono`) | `7fd564cbb78f35f3de14d5382fea692b87ec4026` (2026-09-23) | `packages/coding-agent/src/modes/interactive/**`, `src/core/tools/renderers/**`, `docs/{keybindings,settings,themes,sessions,usage}.md`, `packages/tui/src/components/loader.ts` |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `f89a6db15e9de4db1f08f6eb4ec8d1a901ca07f7` (2026-09-23) | `packages/tui/src/{chat,chrome,status-line,tools,render,prompt,theme}/**`, `packages/coding-agent/src/modes/interactive-mode.ts`, `docs/{keybindings,theme}.md`, `docs/tools/task.md` |
| Claude Code resmi belgeleri | code.claude.com/docs, 2026-09-23 | [interactive-mode](https://code.claude.com/docs/en/interactive-mode), [settings-reference](https://code.claude.com/docs/en/settings-reference), [statusline](https://code.claude.com/docs/en/statusline), [terminal-config](https://code.claude.com/docs/en/terminal-config), [permission-modes](https://code.claude.com/docs/en/permission-modes), [permissions](https://code.claude.com/docs/en/permissions), [sub-agents](https://code.claude.com/docs/en/sub-agents), [accessibility](https://code.claude.com/docs/en/accessibility), [errors](https://code.claude.com/docs/en/errors), [costs](https://code.claude.com/docs/en/costs), [checkpointing](https://code.claude.com/docs/en/checkpointing), [output-styles](https://code.claude.com/docs/en/output-styles), [commands](https://code.claude.com/docs/en/commands) |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `16fe260aab45a524df94c8f635352fd9e6e66fe5` (2026-09-23) | `cli.py`, `hermes_cli/{banner,skin_engine,cli_status_bar_mixin,cli_stream_mixin,cli_modal_mixin,cli_subagent_monitor,cli_tui_mixin,commands,commands_completion,config_defaults,colors,stdio}.py`, `agent/display.py`, `tools/{delegate_tool_progress,todo_tool,clarify_tool,approval_prompt}.py`, `gateway/display_config.py` |

Not: Önceki [TUI araştırması](../tui/README.md) pi'yi `27c072e…` (2026-09-22) ile sabitlemişti. Bu belgedeki UX bulguları yeni commit'ten okundu. İki commit arasında UX'e ilişkin kırılma görülmedi.

## 0. Başlangıç noktası: bugünkü çıktı

`syn run` ile alınan gerçek transcript'ten bir kesit (ürün sahibi, `C:\temp\syn-smoke`):

```text
Synorch C:\temp\syn-smoke master
policy autonomous · sandbox partial
orchestrator: openai/gpt-6-astra (user)
notice: canonical .ai: C:\temp\syn-smoke\.ai (constitution loaded, 8 core protocol(s)...
Session ses_01M35SSARSF9W8SSB1KRRRA2WJ opened in C:\temp\syn-smoke (policy autonomous)
Run created -> running: run started
┌ read_file · done 10 ms
│ {"path":".ai/manifest.yaml"}
└ schema_version: 1
Plan v1 proposed: 3 task(s), risk standard
Approval allowed-for-scope by orchestrator (autonomous self-approval, audited)
Task task_01M35SV… draft -> ready: plan approved and dependencies completed
Attempt att_01M35SV1… started (explorer, gpt-5.6-luna, shared-read-only)
warning: Task task_01M35SV… running -> failed: attempt partial: ...
```

Satır satır kaynak eşlemesi ve kök nedenler (olay başına bir satır, ULID, JSON argüman, atıfsız worker stream'i, durum üreticisinin olmaması, sohbet yolunun olmaması) [spesifikasyon §1](../../design/tui-experience.md#1-bugünkü-durum-ve-sorunlar)'dedir. On üç satırın hiçbiri kullanıcının sorusuna cevap vermiyor. Beşi yalnızca kimlik veya audit bilgisi taşıyor.

## 1. Oh My Pi ve pi

### 1.1 Felsefe

- **pi minimalisttir [doğrulandı].** pi.dev'in "What we didn't build" listesi: MCP yok, subagent yok (tmux veya extension ile), izin popup'ı yok (konteyner önerilir), plan modu yok, yerleşik to-do yok (TODO.md önerilir), arka plan bash'i yok. Başlangıç başlığı `pi v<sürüm>` ve tek bir ipucu satırıdır: `Esc interrupt · Ctrl+C/Ctrl+D clear/exit · / commands · ! bash · Ctrl+O more`. `Ctrl+O` tam kısayol listesini ve yüklü kaynakları açar. `quietStartup: true` başlığı tamamen gizler (`interactive-mode.ts` ~956–1011).
- **OMP bilinçli olarak zengindir [doğrulandı].** Subagent, todo HUD, plan modu, ses ve animasyonlu bir karşılama kutusu vardır. Karşılama kutusunda son oturumlar, LSP sunucuları, rastgele ipucu ve changelog bulunur (`packages/tui/src/prompt/welcome.ts`).
- **[çıkarım]** Synorch'un ihtiyacı ikisinin arasında duruyor: Konuşma görünümü pi kadar sade olmalı, çok worker'lı işin sunumu ise OMP'nin subagent ve todo desenlerinden alınmalı.

### 1.2 Bileşen ağacı [doğrulandı]

pi (`interactive-mode.ts` ~588–615, ~935–943), sırasıyla:

1. `documentContainer` (`header`, `loadedResources`, `chat`)
2. `pendingMessagesContainer` (kuyruktaki mesajlar)
3. `statusContainer` (loader, ya da boştayken 2 boş satırlık `IdleStatus`)
4. Widget'lar
5. `editorContainer`
6. `footerContainer`

OMP'de `composer.setRuntimeChildren` şu sırayı kurar: transcript → bekleyen mesajlar → **sticky `TodoHud`** → **`subagentContainer`** → hata bandı → loader → ek çipleri → editör. Durum satırı composer'a verilir. Composer biçimleri (`pi`, `claude`, `band`, `box`, `rail`, `rule`, `borderless`) seçilebilir. `pi` biçimi "editörün üstünde ve altında tam genişlik çizgi, yan kenar yok" olarak tanımlanır.

**Synorch'a etkisi:** Bölge sırası (transcript → kuyruk → canlı pano → loader → editör → alt bilgi) doğrudan alındı ([spesifikasyon §5](../../design/tui-experience.md#5-ekran-bölgeleri)).

### 1.3 Mesajlar ve düşünme [doğrulandı]

- Kullanıcı mesajı `userMessageBg` arka planlı bir kutudur ve OSC 133 prompt-zone işareti taşır (`user-message.ts`).
- Asistan mesajı kutusuz, `outputPad: 1` girintili Markdown'dır (`assistant-message.ts`).
- Düşünme **varsayılan olarak görünür** (`hideThinkingBlock: false`, `docs/settings.md`): gri, italik Markdown. `Ctrl+T` hepsini katlar, tek bloğa tıklamak yalnız onu katlar. Gizliyken tek satır `Thinking...` kalır.
- Kesilen cevapta hata rengiyle `Response was truncated before completion.` yazar.

### 1.4 Tool gösterimi [doğrulandı]

pi `tool-execution.ts`: Her çağrı dolgulu bir `Box`'tır ve arka planı duruma göre değişir (`toolPendingBg` → `toolSuccessBg`/`toolErrorBg`). `toolOutputExpanded` varsayılan olarak `false`'tur. `Ctrl+O` genel olarak açar, `--verbose` zorlar. Özel renderer'ı olmayan tool 10 satırlık önizlemeye düşer.

| Tool | Katlı görünüm | Kaynak |
| --- | --- | --- |
| read | Yalnız başlık (`read <yol>` + satır aralığı), içerik yok | `renderers/read.ts:120-131` |
| bash | `$ <komut>` başlığı, **son 5 görsel satır**, `... (N earlier lines, Ctrl+O to expand)`, süre. 100 ms throttle. | `renderers/bash.ts` |
| edit | `edit <yol>`. Diff önizlemesi argüman tamamlanınca, tool çalışmadan hesaplanır. | `renderers/edit.ts` |
| write | İlk 10 satır, sonra `... (N more lines, T total, Ctrl+O to expand)` | `renderers/write.ts:117` |
| grep / find / ls | 15 / 20 / 20 satır | `renderers/*.ts` |

Diff (`components/diff.ts`): `+123 içerik` / `-123 içerik` / boşluk önekli bağlam satırı. Satır içi kelime değişiklikleri `inverse` ile vurgulanır.

OMP önizleme sınırları (`packages/tui/src/render/render-utils.ts:98`): `COLLAPSED_LINES 3`, `EXPANDED_LINES 12`, `OUTPUT_COLLAPSED 3`, `OUTPUT_EXPANDED 10`, `DIFF_COLLAPSED_LINES 40`. `chat/read-tool-group.ts` arka arkaya gelen okumaları tek bloğa toplar. `Ctrl+Shift+O` tool etkinliğini tamamen gizler.

**Synorch'a etkisi:** Okuma içeriksiz tek satır; bash'te son satırlar; edit'te diff önizlemesi; aynı tür okumaların gruplanması; `Ctrl+O` genel aç/kapa.

### 1.5 Loader, kesme, kuyruk [doğrulandı]

- pi loader'ı `Working (Esc to interrupt)` yazar. Braille kareler `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` `accent` renginde, metin `muted` renginde (`packages/tui/src/components/loader.ts`).
- Diğer göstergeler (`status-indicator.ts`): `Retrying (n/m) in Ns... (Esc to cancel)`, `Compacting context... (Esc to cancel)`, `Summarizing branch...`.
- Çalışırken `Enter` bir **steering** mesajını kuyruğa alır. Mesaj mevcut tool çağrıları bitince teslim edilir. `Alt+Enter` (Windows'ta `Ctrl+Q`) bir **follow-up** kuyruğa alır ve bu, iş tamamen bitince teslim edilir.
- Kuyruk dim `Steering: …` / `Follow-up: …` satırlarıyla ve `↳ Alt+Up to edit all queued messages` ipucuyla gösterilir.
- `Esc` turu keser ve kuyruktaki mesajları editöre geri koyar.

### 1.6 Alt bilgi / durum satırı [doğrulandı]

pi `footer.ts` iki dim satır basar:

1. `~/yol (dal) • <oturum adı>`
2. `↑<in> ↓<out> R<cacheRead> W<cacheWrite> CH<hit>% $<cost> <ctx>%/<pencere>`, sağda `(provider) <model> • <thinking seviyesi>`.

Sıfır değerli alanlar atlanır. Sayılar `1.2k`/`45k`/`1.2M` biçimindedir. **Bağlam yüzdesi %70'in üstünde `warning`, %90'ın üstünde `error` rengini alır.** Compaction'dan hemen sonra `?` gösterilir.

OMP'nin durum satırı segment tabanlıdır (`status-line/presets.ts`): model, mod, yol, git durumu, PR, ctx%, maliyet. Ayırıcı stilleri arasında `ascii` da vardır. Tur çalışırken marka ikonu braille spinner'a döner.

**Synorch'a etkisi:** ctx% eşikleri, tek satırlık dim alt bilgi, sıfır alanların atlanması.

### 1.7 Editör ve tuşlar [doğrulandı]

pi (`docs/keybindings.md`):

- Editör: `Shift+Enter` veya `Ctrl+J` ile çok satır; `@` bulanık dosya arama; `/` komut menüsü; `!cmd` bash çalıştırıp çıktıyı ekler.
- Uygulama tuşları: `Esc` keser; `Ctrl+C` temizler, ikinci basış çıkar; `Ctrl+D` boşken çıkar; `Ctrl+L` model seçici; `Shift+Tab` thinking seviyesi; `Ctrl+T` thinking aç/kapa; `Ctrl+O` tool'ları açar.
- Boş editörde çift `Esc` `/tree` açar.
- Windows'ta Alt tabanlı alternatifler vardır (`Alt+P`, `Alt+V`, `Ctrl+Q`).

OMP (`docs/keybindings.md`): `Alt+M` model seçici, `Alt+Shift+P` plan modu, `Alt+A` Agent Hub, `Ctrl+R` geçmiş arama.

### 1.8 Oturum ağacı ve resume [doğrulandı]

- pi oturumları ağaç olarak saklar (`docs/sessions.md`). `/tree` aynı dosya içinde dal gezer: `├─ └─ │` bağlayıcıları, `› ` imleci ve filtreler (yalnız kullanıcı mesajı, tool'suz, etiketli). Bir kullanıcı mesajı seçilince metni editöre döner ve gönderilince yeni dal açılır.
- `/fork` yeni oturum açar. `/resume` bir seçici açar (yol, sıralama, yeniden adlandırma, silme).
- Synorch'ta fork `syn agent --fork` ile zaten var. Dal ağacı UI'ı ilk sürümün kapsamı dışında ([spesifikasyon §9](../../design/tui-experience.md#9-tuş-atamaları-ve-komutlar)).

### 1.9 OMP subagent ve todo sunumu [doğrulandı]

Çok worker'lı sunum için en doğrudan referans budur.

- **Subagent satırları** (`packages/tui/src/tools/task.ts`, `agent-tree.ts`): Subagent başına bir satır vardır. Satırda durum ikonu (çalışırken braille spinner), ajan kimliği, rol ve durum rozetleri, model rozeti, dim istatistikler (`N tool · N req · ctx% · $`) ve süre bulunur.
  - Çalışan satırın altında `↳ <mevcut tool> <son niyet>` ve son çıktının kuyruğu (son 8 satır, 150 ms birleştirme) görünür.
  - Katlı görünüm 4 ajan gösterir (`COLLAPSED_AGENT_LIMIT`).
  - **Native scrollback'e geçen satırlar statik griye donar** ve bir daha boyanmaz.
- **Todo HUD** (`interactive-mode.ts` ~3297–3412): Loader'ın üstünde sabit durur.
  - Aşamalar `├─`/`│` omurgalı bir ağaçtır. Aktif aşama kalın `accent` renginde ve `· done/total` etiketlidir.
  - En çok 4 sonraki aşama gösterilir, sonra `… n more stages`. En çok 5 açık görev görünür.
  - Tamamlanan görev üstü çizili `success`, engellenen görev `(neden)` ile `warning` rengindedir.
  - Çalışan bir subagent'ın açıklaması bekleyen bir todo ile eşleşince o todo `accent` rengiyle yanar.

**Synorch'a etkisi:** Run panosu bu iki deseni birleştirir. Plan checklist'i todo HUD'dan, satır başına rol, model, etkinlik ve süre subagent satırından gelir. Katlama sınırı ve "scrollback'e geçince dondur" kuralı da alındı. Kimlik rozetleri alınmadı.

### 1.10 Tema ve glyph [doğrulandı]

- pi tema token'ları (`theme/dark.json`, `theme-schema.json`):
  - Çekirdek: `accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text, thinkingText`
  - Mesaj ve tool: `userMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg, toolTitle, toolOutput`
  - Markdown `md*`, diff `toolDiffAdded/Removed/Context`, sözdizimi `syntax*`, thinking seviyesi `thinking*`
- Renkler truecolor'dır, 256 renge yaklaşık düşürülür. Truecolor algısında Windows Terminal için `WT_SESSION` kullanılır.
- **pi'nin `theme.ts` ve terminal dosyalarında NO_COLOR işlemesi bulunamadı.** OMP'de de belgelenmemiş.
- OMP'de sembol ön ayarları `unicode` (varsayılan), `nerd` ve `ascii` vardır, ayrıca `spinnerFrames` ayarlanabilir. `TERM=dumb/linux` 256 renk kabul edilir.

**Synorch'a etkisi:** Üç kademeli glyph seti OMP'nin yaklaşımını doğruluyor. NO_COLOR, Synorch'un `selectColor`/`Styler` katmanında kalmalı. pi-tui bileşenlerine tema fonksiyonlarını Synorch verdiği için bu mümkün.

## 2. Claude Code

Claude Code'un CLI kaynak kodu açık değil ([önceki inceleme](../claude-code.md)). Aşağıdakiler resmi belgelere [doğrulandı] veya yaygın gözleme [gözlem] dayanıyor.

### 2.1 Transcript: özet varsayılan, `Ctrl+O` ayrıntı

- [doğrulandı] "The transcript collapses each tool call to a short summary, such as the command Claude ran and a line count of its output, and you press `Ctrl+O` to switch the whole transcript to the expanded view." `verbose: true` tam girdi ve çıktıyı satır içinde gösterir ([settings-reference#verbose](https://code.claude.com/docs/en/settings-reference#verbose)).
- [doğrulandı] MCP çağrıları `Called slack 3 times` gibi tek satıra katlanır ([interactive-mode](https://code.claude.com/docs/en/interactive-mode)).
- [doğrulandı] `viewMode: default | verbose | focus`. `focus` yalnız son prompt'u, diffstat'lı tek satırlık tool özetini ve son cevabı gösterir (`/focus`) ([settings-reference#viewmode](https://code.claude.com/docs/en/settings-reference#viewmode)).
- [doğrulandı] Tur sonunda `Cooked for 1m 6s · done 6:05 PM` (`showTurnDuration`).
- [gözlem] Asistan metni ve her tool çağrısı `⏺` ile başlar. Bu işaret başarıda yeşil, hatada kırmızıdır. Tool çağrısı `Read(src/x.ts)`, `Bash(npm test)`, `Update(src/x.ts)` biçiminde tek satırdır. Altında `  ⎿  ` özet satırı vardır: `Read 42 lines`, `Found 3 files`, `Updated src/x.ts with 2 additions and 1 removal`. Uzun çıktı `… +N lines (ctrl+o to expand)` ile kesilir. Üçüncü taraf bir yazı bunu "a whole turn reads like a receipt" diye özetliyor ([kaynak](https://shipwithailab.substack.com/p/claude-code-for-everything-your-terminal)).

### 2.2 Görev listesi ve plan modu

- [doğrulandı] Görev listesi, bekleyen, süren ve tamamlanan göstergeli bir checklist'tir. `Ctrl+T` onu durum alanında açıp kapar. En çok 5 görev görünür, ve liste resume ile compaction'dan sonra korunur ([interactive-mode#task-list](https://code.claude.com/docs/en/interactive-mode#task-list)).
- [gözlem] `☐` bekliyor, `☒` bitti (üstü çizili ve dim), süren öğe kalın.
- [doğrulandı] Plan moduna `Shift+Tab` veya `/plan` ile girilir. Onay diyaloğunun seçenekleri şunlardır: "Yes, and use auto mode" / "Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning". `Ctrl+G` planı editörde açar ([permission-modes](https://code.claude.com/docs/en/permission-modes)).

### 2.3 Spinner

- [doğrulandı] Spinner "Accomplishing", "Architecting", "Baking" gibi döner fiiller gösterir (`spinnerVerbs` ile değiştirilir). Altında tek satırlık ipucu vardır (`spinnerTipsEnabled`). `prefersReducedMotion` animasyonu azaltır ([settings-reference#spinnerverbs](https://code.claude.com/docs/en/settings-reference#spinnerverbs), [terminal-config](https://code.claude.com/docs/en/terminal-config)).
- [doğrulandı] "esc to interrupt" bir alt bilgi ipucudur. Özel status line ayarlanınca gizlenir ([statusline](https://code.claude.com/docs/en/statusline)).
- [gözlem] Biçim: `✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)`.

### 2.4 Subagent gösterimi

- [doğrulandı] Delegasyon, subagent adı ve kısa görevle bir tool satırıdır: `code-improver(Suggest code improvements)`. Editörün altında bir subagent paneli durur ve iç içe subagent'lar `(+N)` sayaçlı ağaç olarak görünür. Başarıyla biten satır kalkar ve alt bilgide 30 s boyunca `/tasks to see subagents` görünür. Başarısız satır 30 s kalır. Subagent'lar 8 renkten biriyle ayrılır ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
- [gözlem] Çalışan subagent'ın altında son 2–3 tool çağrısı ve `+N more tool uses` görünür. Bitince satır `Done (N tool uses · 12.3k tokens · 45s)` özetine iner.

### 2.5 Diff ve izin istemi

- [doğrulandı] Diff tema token'ları: `diffAdded`/`diffRemoved` satır arka planı, `diffAddedWord`/`diffRemovedWord` kelime vurgusu ([terminal-config](https://code.claude.com/docs/en/terminal-config)).
- [doğrulandı] "Yes, and don't ask again" tool'a göre değişir. Bash'te depo ve komut önekine göre kalıcıdır. Dosya düzenlemede oturum sonuna kadar geçerlidir. Esc = No. Tab bir yorum alanı açar ([permissions](https://code.claude.com/docs/en/permissions)).
- [gözlem] Kutu biçimi şöyledir: başlık ("Bash command"), komut ve açıklaması, "Do you want to proceed?", `❯ 1. Yes`, `2. Yes, and don't ask again for <önek> commands in <dizin>`, `3. No, and tell Claude what to do differently (esc)`.
- [doğrulandı] `Shift+Tab` (VT input yoksa Windows'ta `Alt+M`) izin modlarını döndürür. Alt bilgide `⏸ plan mode on` veya `⏵⏵ accept edits on` gibi göstergeler çıkar ([permission-modes](https://code.claude.com/docs/en/permission-modes)).

### 2.6 Status line ve alt bilgi

- [doğrulandı] Status line bir komuttur. Stdin'den oturum JSON'unu alır ve çıktısını gösterir. Alanlar arasında model, cwd, maliyet, süre, eklenen ve silinen satırlar, `context_window.used_percentage`, rate limit ve worktree vardır. Güncellemeler 300 ms ile debounce edilir. Workspace güvenilmeden boş kalır ([statusline](https://code.claude.com/docs/en/statusline)).
- [doğrulandı] Boş girdide `?` kısayol panelini açar.

### 2.7 Transcript, komutlar, tuşlar

[interactive-mode](https://code.claude.com/docs/en/interactive-mode) [doğrulandı]:

- `Ctrl+O`: transcript görüntüleyici (zaman damgası, model, açılan satırlar).
- `Ctrl+C`: keser; boştayken ilk basış girdiyi temizler, ikincisi çıkar.
- `Esc`: keser ve o ana kadarki işi korur.
- `Esc Esc`: taslağı temizler, ya da taslak boşsa rewind menüsünü açar.
- Diğer tuşlar: `Ctrl+B` arka plan, `Ctrl+T` görev listesi, `Ctrl+L` yeniden çiz, `Ctrl+R` geçmiş arama.
- Yeni satır: `Ctrl+J` her yerde çalışır. `Shift+Enter` Windows Terminal, iTerm2, Kitty ve WezTerm'de doğrudan çalışır ([terminal-config](https://code.claude.com/docs/en/terminal-config)).
- Önekler: `/` komut, `!` bash modu, `@` dosya. 800 karakteri veya 3 satırı aşan yapıştırma `[Pasted text #1 +120 lines]` çipine döner.
- `/context` renkli bir ızgara gösterir. `/compact [talimat]`. `/cost` = `/usage` ([costs](https://code.claude.com/docs/en/costs)).
- 3 dakikadan uzun aradan sonra dönülünce tek satırlık oturum özeti gösterilir.

### 2.8 Windows, tema, erişilebilirlik

- [doğrulandı] Temalar: `dark`, `light`, `*-daltonized`, `*-ansi` ([settings-reference#theme](https://code.claude.com/docs/en/settings-reference#theme)). Arayüz renklerini değiştirmek için `NO_COLOR`/`FORCE_COLOR` Claude Code'u başlatmadan önce kabukta ayarlanmalı. Settings `env`'i yalnız alt süreçlere ulaşır.
- [doğrulandı] Windows'ta `^H` Ctrl+Backspace sayılır. VT input yoksa `Alt+M` kullanılır. Titreme için `CLAUDE_CODE_NO_FLICKER=1` var. `Ctrl+L` bozulan ekranı yeniden çizer ([terminal-config](https://code.claude.com/docs/en/terminal-config)).
- [doğrulandı] **Ekran okuyucu modu** (`--ax-screen-reader`, `CLAUDE_AX_SCREEN_READER=1`) ([accessibility](https://code.claude.com/docs/en/accessibility)):
  - Çıktı düz metindir: kutu çizgisi ve yalnız renge dayalı ipucu yoktur, spinner statiktir, tablolar "Başlık: değer" olarak okunur.
  - Satırlar etiket taşır: `you:`, `claude:`, `tool:`, `tool error:`, `error:`, `warning:`, `Permission Required:`.
  - Menüler numaralı listeye döner. Mod değişimi duyurulur. İş bitince zil çalar.
- [gözlem] `⏺ ⎿ ✻ ☐ ☒` glyph'leri klasik conhost'ta veya bu sembolleri içermeyen fontlarda kutu (tofu) veya yanlış genişlikte görünebilir.

### 2.9 Hata ve yeniden deneme

- [doğrulandı] Geçici hatalar üstel geri çekilmeyle 10 kereye kadar yeniden denenir. Spinner `Retrying in Ns · attempt x/y` ile birlikte hatanın nedenini gösterir. 20 s veri gelmezse `Waiting for API response · will retry in … · check your network` görünür. Nihai hatalar `API Error: 401 …` biçimindedir. Akış ortasında `Server error mid-response. The response above may be incomplete.` yazar ([errors](https://code.claude.com/docs/en/errors)).

## 3. Hermes Agent

Hermes'in iki ön yüzü var: varsayılan prompt_toolkit + Rich REPL (`cli.py`, `hermes_cli/cli_*_mixin.py`) ve `--tui` ile açılan Ink/React TUI (`ui-tui/src/`). Görüntü varsayılanları `hermes_cli/config_defaults.py` `display` bloğundadır (~796–930). Aşağıdakilerin tümü [doğrulandı] (kaynak kodu, `16fe260`).

### 3.1 Başlık ve skin'ler

- `hermes_cli/banner.py::build_welcome_banner` sürüm başlıklı bir Rich `Panel` çizer. Sol sütunda maskot, model, bağlam penceresi, cwd ve `Session: <id>` vardır. Sağ sütunda en çok 8 toolset, MCP sunucuları, kategori bazında skill'ler ve `N tools · M skills · K MCP servers · /help for commands` bulunur. Terminal ≥ 95 sütunsa büyük logo da basılır.
- Skin motoru (`skin_engine.py`) renkleri, spinner yüzlerini ve fiillerini, marka metinlerini, tool önekini (`┊`) ve tool başına emojiyi değiştirir. 9 yerleşik skin vardır, `mono` dahil.
- **[çıkarım]** Başlık bilgi yoğun ama başlangıçta 15–25 satır tutuyor. Synorch hedefi (≤ 2 satır) bunun tersi.

### 3.2 Tool etkinliği

- Tamamlanan tool başına tek satır basılır (`agent/display.py::get_cute_tool_message`): `┊ {emoji} {fiil:9} {ayrıntı}  {süre}s`. Örnekler: `┊ 💻 $  ls  0.3s`, `┊ 📖 read`, `┊ 🔧 patch`, `┊ 🔀 delegate 3x: goalA | goalB`. Hata eki `[exit 1]` veya en çok 48 karakterlik kırpılmış hatadır.
- `display.tool_progress: off | new | all | verbose` (CLI varsayılanı `all`). `new` arka arkaya tekrarlanan aynı tool'u atlar. `off` yalnız spinner bırakır. `/verbose` modlar arasında döner. `/focus` modu `off`'a sabitler ve gizlenen satır sayısını söyler.
- 30 s'yi aşan bir tool'dan sonra bir kez `/verbose` ipucu gösterilir.
- Yazma ve patch'ten sonra satır içi diff varsayılan olarak açıktır (`display.inline_diffs`).
- **Tur sonu özeti varsayılan olarak açık:** `⋯ 12.4s · edited 2 files +18 -3 · read 4 files · ran 3 commands`.

### 3.3 Spinner, düşünme, akış

- `KawaiiSpinner` (`agent/display.py:802`) braille ve ay gibi kare setleri ile kaomoji yüzleri kullanır, ve bunlar skin ile değiştirilir. TTY olmayan çıktıda animasyon yerine bir kez `[tool] …`, sonra `[done] … (Xs)` basar.
- Çalışan tool için canlı satır `{emoji} {etiket}  ( 5.2s · ↓1.2k tok)` biçimindedir. Zamanlayıcı sabit genişliktedir.
- `display.show_reasoning` (varsayılan açık) akıl yürütmeyi canlı bir kutuda gösterir. Cevaptan sonraki özet 10 satıra katlanır.
- CLI'da token akışı varsayılan olarak kapalıdır ve satır tamponludur.

### 3.4 Alt ajanlar (`delegate_task`)

- `tools/delegate_tool_progress.py::_ChildProgressRelay`, ebeveynin delegasyon spinner'ının üstüne her çocuk olayı için bir ağaç satırı basar: `[set 2 · 3/9] ├─ 🔀 goal`, `├─ 💻 terminal "ls -la"`. Başarısız çocukta `⚠️ Subagent failed/timed out after 3 min: <neden>` görünür.
- Klasik CLI editörün üstünde canlı bir dok gösterir (`cli_subagent_monitor.py`): `Subagents · N live · Ctrl+T expand · F7 collapse`, ardından her çocuk için `● goal · 12s · last: terminal`.
  - `Ctrl+T` veya `F6` tam yükseklikte bir izleyici açar. İzleyicide canlı transcript kuyruğu, `s` ile steer ve onaylı durdurma vardır.
- Arka plan delegasyonu `↩ Background task running — I'll resume when it finishes. Keep chatting.` basar.

**Synorch'a etkisi:** "Konuşmaya devam et, iş arkada sürsün" ifadesi ve ayrıntıda steer'li bir izleyici fikri. Olay başına ağaç satırı, 9 çocukta scrollback'i hızla doldurduğu için alınmadı. Onun yerine yerinde güncellenen bir pano seçildi.

### 3.5 Todo, onay, soru

- CLI'da todo tool'u yalnız `📋 plan x/y` satırı üretir. İşaretler `[x] [>] [ ] [~]` (`tools/todo_tool.py:22`). Ink TUI'de katlanabilir `todoPanel.tsx` vardır.
- Tehlikeli komut onayı prompt_toolkit modalıdır (`cli_modal_mixin.py::_approval_choices`). Seçenekler `once / session / always / deny`, uzun komutta `view` de eklenir. Metin yedeği `[o]nce | [s]ession | [a]lways | [d]eny` ve `Choice [o/s/a/D]`'dir (varsayılan deny). Süre aşımı 300 s. Karar scrollback'e tek satır olarak düşer (`✓ Allowed once`, `✗ Denied`).
- Clarify tool'u (`tools/clarify_tool.py`) en çok 4 seçenek sunar ve UI her zaman "Other (type your answer)" satırı ekler. İlk seçenek "önerilen" etiketi taşıyabilir.

### 3.6 Komutlar, tuşlar, kesme

- `hermes_cli/commands.py::COMMAND_REGISTRY` yaklaşık 150 komut tanımlar. Her tanımda kategori, alias, argüman ipucu ve `busy_policy` (`dispatch | reject | interrupt_then_dispatch`) bulunur. Aynı kayıt CLI yardımını, gateway'i ve autocomplete'i besler.
- Ajan çalışırken gönderilen mesaj `display.busy_input_mode`'a göre işlenir: `interrupt` (varsayılan), `queue` veya `steer`.
- `Ctrl+C` öncelik sırasıyla çalışır: seçiciyi kapat → ajanı kes (`⚡ Interrupting agent... (press Ctrl+C again to force exit)`) → 2 s içinde ikinci basışta çık.

### 3.7 Durum çubuğu

`cli_status_bar_mixin.py::_status_bar_segments` üç genişlik kademesiyle çalışır (<52, <76, geniş). Segmentler: model; bağlam `used/total` ve `[████░░░░░░] 42%` çubuğu (%50 altı yeşil, %80 üstü kötü, %95 kritik; `~` tahmin demektir); cache isabeti; gecikme; hız; compaction sayısı; arka plan işleri; alt ajan sayısı; git dalı; süre. Maliyet varsayılan olarak kapalıdır (`display.show_cost: false`).

### 3.8 Windows, renk, gateway

- `hermes_cli/stdio.py::configure_windows_stdio` console codepage'ini UTF-8'e çevirir ve stream'leri `errors=replace` ile yeniden yapılandırır. **Otomatik glyph fallback'i yok**: emoji ve kutu çizgisi her zaman kullanılır. ASCII seçeneği yalnız TUI meşgul göstergesinde (`display.tui_status_indicator`) ve `mono` skin'inde var.
- `hermes_cli/colors.py::should_use_color` `NO_COLOR`'u, `TERM=dumb`'ı ve TTY olmayan çıktıyı dikkate alır.
- Gateway (Telegram, Slack…) aynı fiil ve emoji yardımcılarını platform kademeleriyle kullanır. Telegram ve Slack'te `tool_progress` varsayılanı `off`'tur. **[çıkarım]** Hermes, mesaj platformlarında tool gürültüsünü varsayılan olarak kapatıyor. "Sessiz varsayılan" ilkesinin başka bir kanıtı.

## 4. Karşılaştırma

| Konu | pi | Oh My Pi | Claude Code | Hermes | **Synorch önerisi** |
| --- | --- | --- | --- | --- | --- |
| Başlangıç başlığı | 2 satır + gizlenebilir | Animasyonlu kutu | Kutulu karşılama | 15–25 satır panel | **1 satır, uyarı varsa 2** |
| Tool, varsayılan | Kutu + 5–20 satır önizleme | Kart, 3 satır | `⏺ Tool(arg)` + `⎿ özet` | `┊ emoji fiil ayrıntı süre` | **`● Fiil arg` + `⎿ özet`, en çok 2 satır** |
| Okuma içeriği | Gizli | 3 satır, gruplu | Gizli (`Read N lines`) | Gizli | **Gizli, gruplu** |
| Düzenleme | Diff önizlemesi | Diff (40 satır) | Satır içi diff | Satır içi diff | **Diff, en çok 8 satır** |
| Ayrıntı tuşu | `Ctrl+O` | `Ctrl+O`, gizle `Ctrl+Shift+O` | `Ctrl+O` | `/verbose` döngüsü | **`Ctrl+O`, `--verbose`, `--debug`, `/log`** |
| Düşünme | Görünür, `Ctrl+T` | Yalnız düzyazı | Gizli | Görünür kutu | **Gizli, L1'de 5 satır** |
| Spinner metni | `Working (Esc to interrupt)` | `Working…` | Döner fiil + süre + token | Kaomoji + fiil + süre + token | **Faz fiili + süre + token + esc** |
| Alt ajan / worker | Yok (felsefe) | Satır başına ajan + etkinlik + kuyruk | Panel + ağaç + `+N more tool uses` | Olay başına ağaç satırı + dok | **Yerinde güncellenen pano: görev, rol, model, etkinlik, süre** |
| Todo / plan | Yok | Sticky HUD | `Ctrl+T` checklist | `📋 plan x/y` | **Pano = plan checklist'i** |
| Plan modu | Yok | Var | `Shift+Tab`, onay seçenekleri | Yok | **`Shift+Tab` / `/plan`, salt okuma** |
| Kuyruk / steer | Enter steer, Alt+Enter follow-up | Aynı | Kuyruk | `interrupt/queue/steer` ayarı | **Enter kuyruğa alır, sınırda uygular** |
| İzin istemi | Yok (felsefe) | Onay modu | Kutu, 3 seçenek, Esc = No | once/session/always/deny | **Kutu, güvenli varsayılan, "tell Synorch…"** |
| Alt bilgi | 2 satır, ctx %70/%90 | Powerline segmentler | Özel komut | 3 kademeli çubuk | **1 satır, ctx %70/%90, dar ekranda alan düşer** |
| Glyph fallback | Yok | `unicode/nerd/ascii` | Yok (gözlem: tofu riski) | Yok | **`rich/safe/ascii`, otomatik algı** |
| NO_COLOR | Bulunamadı | Belgelenmemiş | Kabukta ayarlanır | Var | **Var (mevcut `selectColor`)** |
| Ekran okuyucu | Yok | Yok | `--ax-screen-reader`, etiketli satırlar | Yok | **Plain mod + etiketler + `--accessible`** |
| Tur sonu özeti | Yok | Var (telemetri) | `Cooked for …` | `⋯ 12.4s · edited 2 files …` | **≥ 10 s turda tek dim satır** |

## 5. İlkeler

Referanslardan çıkan ve [spesifikasyon](../../design/tui-experience.md)'a giren ilkeler:

1. **Varsayılan görünüm bir makbuzdur, günlük değil.** Dört referansın hepsi tool başına bir satır ve bir özet gösteriyor. Ayrıntıyı tek bir tuşa bağlıyorlar (`Ctrl+O` üç üründe ortak). Synorch'ta iç durum geçişleri hiçbir zaman satır üretmez ([sessiz varsayılan kuralı](../../design/tui-experience.md#21-varsayılan-olarak-sessiz-kuralı-normatif)).
2. **Kimlik ve durum adları insan görünümünde yer almaz.** Hiçbir referans varsayılan transcript'te ID göstermiyor. Hermes başlıkta session ID'yi gösteriyor ama iş akışında göstermiyor. Synorch'ta görevler plan anahtarıyla adlandırılır ve ID yalnız L2'de bulunur.
3. **İlerleme bir yerde güncellenir.** OMP'nin todo HUD'u ve subagent satırları, Claude Code'un görev listesi ve subagent paneli, Hermes'in dokunun hepsi aynı şeyi yapıyor: transcript'e eklemiyor, canlı bir bölgeyi güncelliyor. Hermes'in olay başına ağaç satırı karşı örnektir. Synorch'ta run panosu bittiğinde bir kez sabitlenir. OMP'deki gibi scrollback'e geçen satır bir daha boyanmaz.
4. **Konuşma önce, orkestrasyon içeride.** Claude Code subagent'ı bir tool satırı olarak, OMP task'ı bir tool bloğu olarak gösteriyor. İkisinde de ana konuşma kesintisiz sürüyor. Synorch'ta worker run'ı konuşmanın içinde bir bloktur ve konuşma sonrasında aynı ekranda devam eder.
5. **Spinner bilgi taşımalı.** Claude Code ve Hermes'in döner fiilleri ve kaomoji yüzleri dekoratif. pi'nin sabit `Working` metni ise bilgisiz. Synorch fazı söyleyen fiiller kullanır (`Planning`, `Working`, `Checking`, `Reviewing`) ve süre, token ile `esc` ipucunu ekler.
6. **Kesme ve yönlendirme ucuz olmalı.** Üç üründe `Esc` keser. pi ve Hermes çalışırken yazılan mesajı kuyruğa veya steer'e alıyor. Synorch'ta `Enter` kuyruğa alır ve kuyruk görünür kalır.
7. **İzin istemi insan dilinde olmalı ve güvenli seçenekte başlamalı.** Claude Code: "Yes / Yes, don't ask again for … / No, and tell Claude what to do differently (esc)". Hermes: varsayılan deny. Synorch'ta `subject_kind` gibi iç adlar görünmez, `esc` hiçbir yetkiyi genişletmez.
8. **Bağlam uzun oturumun bir kaynağıdır ve görünür olmalı.** pi (ctx %70/%90 renkleri), Claude Code (`/context` ızgarası, `used_percentage`) ve Hermes (renkli çubuk) bağlam doluluğunu sürekli gösteriyor. Synorch'ta ctx% alt bilgide hiçbir zaman düşmeyen alandır. `/compact` ve otomatik compaction tek satırla bildirilir.
9. **Glyph'ler kademeli olmalı.** Yalnız OMP sembol ön ayarı sunuyor. Claude Code ve Hermes'te conhost'ta tofu riski var. Synorch `rich/safe/ascii` setlerini ortama göre otomatik seçer ve `⏺` yerine WGL4'teki `●`'u kullanır.
10. **Erişilebilirlik ayrı bir moddur ama aynı bilgiyi taşır.** Claude Code'un ekran okuyucu modu (etiketli düz satırlar, numaralı menüler, zil) en iyi örnek. Synorch'un plain modu da aynı etiketleri (`you:`, `synorch:`, `tool:`) ve aynı bilgi alanlarını kullanır.
11. **Doğrulama iddiası kanıttan ayrılmalı.** Referansların hiçbiri worker beyanı ile harness'in doğruladığı sonucu ayırmıyor. Bu Synorch'a özgüdür: raporda "run by Synorch" ibaresi ADR-18 kanıtını işaretler.

## 6. Benimsenmeyenler

| Referans davranışı | Neden alınmadı |
| --- | --- |
| Emoji tool önekleri (Hermes) | Genişlik belirsiz, conhost'ta tofu riski, ekran okuyucuda gürültü |
| Döner veya dekoratif spinner fiilleri ve kaomoji (Claude Code, Hermes) | Bilgi taşımıyor. Faz fiili tercih edildi. |
| Arka plan renkli kullanıcı ve tool kutuları (pi) | Açık temalarda okunabilirlik ve conhost uyumu |
| Büyük karşılama paneli (Hermes, OMP, Claude Code) | Başlık bütçesi 1–2 satır. Bilgi `/doctor` ve `?`'te. |
| `Shift+Tab` ile izin modu genişletme (Claude Code) | Synorch'ta policy genişletme bir onay akışıdır ([ADR-08](../../decisions/ADR-08-approval-policy.md)). `Shift+Tab` yalnız plan moduna (daraltma) ayrıldı. |
| Oturum ağacı ve rewind UI'ı (pi `/tree`, Claude Code `Esc Esc`) | İlk sürüm kapsamı dışında. Fork CLI bayrağıyla var. |
| Özel status line komutu (Claude Code) | İlk sürümde sabit alt bilgi. Extension ile ileride eklenebilir. |
