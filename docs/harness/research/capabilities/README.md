# Yetenek boşluğu araştırması: internet ve araç seti (K4.0)

> Statü: araştırma + öneri; runtime uygulanmadı. İnceleme ve web erişim tarihi: 2026-09-24. Tetik: ürün sahibi harness'la konuşurken internete çıkamadığını ve yeteneklerin eksik olduğunu fark etti — "yetenekli bir aracımız olsun" ([backlog K4](../../delivery/backlog.md)). Öneri ve öncelikli plan: [recommendation.md](./recommendation.md).

Bilgi statüsü etiketleri [sağlayıcı araştırmasıyla](../provider-auth/README.md#bilgi-statüsü-etiketleri) aynıdır: **[Kod]** kaynak kodunda görüldü, **[Doküman]** resmi belge, **[Referans]** üçüncü taraf açık kaynak uygulamada görüldü, **[Çıkarım]** bizim yorumumuz. Synorch tespitleri `harness` dalının yerel çalışma ağacından (2026-09-24, `9e27d32`) yapıldı.

## 1. Kısa hüküm

- **Synorch'un bugün internete çıkan hiçbir aracı yok.** Oturum ajanına görünen araçlar: `read_file`, `search`, `list_dir`, `git_status`, `git_diff`, `apply_patch`, `write_file`, `exec`, `ask_user`, `load_skill`, `memory_propose`, `orchestrate` ([Kod] `src/harness/tools/registry.ts`, `builtin/*.ts`, `cli/orchestrate-tool.ts`). Kullanıcı politikasının ağ varsayılanı `deny`'dir (`policy/engine.ts` `user.network ?? { mode: "deny" }`); `exec` ile `curl` teorik bir kaçış yoludur ama ürün yüzeyi değildir.
- **Claude köprüsünde de internet kapalı:** köprü `claude -p`'yi `--tools ""` ile başlatır, Claude Code'un yerleşik `WebSearch`/`WebFetch` araçları bilerek devre dışıdır ([Kod] `providers/claude-code/adapter.ts` `buildClaudeArgs`).
- **Karşılaştırılan dört ürünün üçü internet araçlarını hazır getirir** (Claude Code, Codex CLI, OMP, Hermes); yalnız pi bilinçli olarak getirmez ve bunu extension/CLI aracına bırakır.
- **Altyapının yarısı hazır:** politika zaten `network_hosts`, `allowlist` modu ve izin modlarında kaldırılabilir `network-denied` / `host-not-allowlisted` kodlarını taşıyor ([Kod] `contracts/policy.ts` `PERMISSION_LIFTABLE_CODES`, `policy/engine.ts` `evaluateNetwork`). Yani `auto`'da "yeni alan adı → soru kartı", `full`'da "serbest" davranışı yeni bir politika katmanı gerektirmez; eksik olan araçların kendisi, "bu alan adına her zaman izin ver" kalıcı kuralı ve SSRF/enjeksiyon rayları.
- **İnternet dışındaki büyük boşluklar:** arka plan süreçleri + çıktı izleme, todo/plan aracı, ajanın kendi başına görsel/PDF okuması, glob, LSP/diagnostics, MCP istemcisi, tarayıcı otomasyonu.

## 2. Ürün ürün bulgular

### 2.1 Claude Code

- **Araç seti [Doküman] ([tools reference](https://code.claude.com/docs/en/tools-reference)):** `Bash`/`PowerShell`, `Read` (görsel PNG/JPG, PDF sayfalı, notebook), `Write`, `Edit` (tam dize değişimi, önce okuma şartı), `Glob`, `Grep` (ripgrep, `.gitignore`'a uyar), `WebSearch`, `WebFetch`, `Agent` (alt ajan), `TaskCreate/TaskList/TaskUpdate` (TodoWrite'ın yerini aldı), `Monitor` (arka planda komut çalıştırıp çıktıyı akıtır; varsayılan 5 dk, en çok 30 dk), `Bash` `run_in_background`, `TaskStop`, `NotebookEdit`, `LSP` (dil sunucusu eklentisi gerekir; tanım, referans, tip hatası), `AskUserQuestion`, `EnterPlanMode/ExitPlanMode`, `EnterWorktree`, `Skill`, `ToolSearch` (ertelenmiş araç şemaları), MCP kaynak araçları, `CronCreate` vb.
- **WebSearch / WebFetch:** ikisi de izin ister. `WebSearch` tek parça izinlenir (alan adı belirticisi yok); `WebFetch(domain:example.com)`, `*.example.com` alt alan adı joker kuralı; alan adı kuralları sandbox ağ allowlist'ine de yansır ([permissions](https://code.claude.com/docs/en/permissions)). `WebFetch` görselleri yeniden boyutlar, büyük PDF'leri sayfalar; Bedrock/Vertex/Foundry'de yoktur.
- **Kendi uyarıları:** "WebFetch alone doesn't prevent network access. If Bash is allowed, Claude can still use `curl`…" — ağ kısıtı için `curl`/`wget` deny kuralı + sandbox ağ allowlist'i önerilir ([permissions](https://code.claude.com/docs/en/permissions)). Bu bizim `exec` durumumuzla birebir aynı.
- **Genişleme:** MCP istemcisi, hook'lar, skill'ler, eklentiler (LSP dahil).

### 2.2 Anthropic sunucu araçları (API)

- **Web search** [Doküman] ([web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)): `web_search_20250305` (temel), `web_search_20260209` (dinamik filtreleme: Claude sonucu kod ile süzer), `web_search_20260318` (`response_inclusion`). Parametreler: `max_uses`, `allowed_domains` **veya** `blocked_domains`, `user_location`. Sonuçlar `encrypted_content` taşır ve sonraki turda **değiştirilmeden geri gönderilmelidir**; alıntılar her zaman açık. `pause_turn` durdurma nedeni işlenmelidir. **Fiyat: 1.000 arama başına 10 $ + sonuç token'ları.** Bedrock'ta yok.
- **Web fetch** [Doküman] ([web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)): `web_fetch_20250910` … `web_fetch_20260318`; `max_uses`, alan adı filtreleri, `max_content_tokens`, `citations`, `use_cache`. **Ek ücret yok**, yalnız token. JavaScript ile oluşan sayfaları desteklemez. Güvenlik tasarımı Synorch için doğrudan örnek: model **yalnız bağlamda daha önce geçmiş URL'leri** çekebilir (kullanıcı mesajı, istemci araç sonucu, önceki arama/fetch sonucu); modelin kendi ürettiği URL `url_not_in_prior_context` hatası alır; kimlik bilgisi içeriyor gibi görünen URL reddedilir; özel adresler ve `robots.txt` Anthropic tarafında engellenir; URL en çok 250 karakter.
- **Köprüdeki durum [Çıkarım]:** Claude aboneliği yalnız Claude Code köprüsüyle kullanılabildiği için (ADR-05) sunucu araçlarına doğrudan erişemeyiz; köprüde tek yol Claude Code'un kendi `WebSearch`/`WebFetch` araçlarını açmaktır (`--tools "WebSearch,WebFetch"`), izin sorusu zaten `--permission-prompt-tool` ile Synorch gateway'ine geldiği için alan adı politikası uygulanabilir. Abonelik kotasından düşer; canlı doğrulanmadı.

### 2.3 OpenAI Codex CLI ve Responses barındırılan araçları

- **Model araçları [Kod] ([spec_tests.rs](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/core/src/tools/spec_tests.rs)):** varsayılan küme `shell_command` (veya unified exec açıkken `exec_command` + `write_stdin`), `update_plan`, `request_user_input`, `apply_patch`, `web_search`, `image_generation`, `view_image`, `spawn_agent`/`send_input`/`resume_agent`/`wait_agent`/`close_agent`; MCP araçları `mcp__<server>__<tool>` adıyla eklenir, çok araçta `tool_search` devreye girer.
- **Arka plan süreçleri [Kod] ([local_tool.rs](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/tools/src/local_tool.rs)):** `exec_command` PTY'de komutu başlatır, `yield_time_ms` sonra çıktıyı ya da **oturum kimliğini** döndürür; `write_stdin(session_id, chars)` boş karakterle yoklama yapar. Yoklama penceresi `background_terminal_max_timeout` (varsayılan 300.000 ms) ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Web arama modları [Doküman] ([web search](https://www.codex-docs.com/en/docs/web-search), [config sample](https://learn.chatgpt.com/docs/config-file/config-sample)):** `web_search = "disabled" | "cached" | "indexed" | "live"`; **varsayılan `cached`** (OpenAI'nin tuttuğu indeks, canlı sayfa çekmez — "lowers, but doesn't remove, prompt injection risk"), `--search` veya tam erişim sandbox'ında `live`. Barındırılan araçtır: **sandbox ağ proxy'sinden ve alan adı allowlist'inden geçmez**, komut ağı kapalıyken de açık kalabilir; `tools.web_search.allowed_domains`, `context_size`, `location` yapılandırılır. Çağrı başına onay yoktur.
- **İstek biçimi [Kod] ([web_search.rs testleri](https://github.com/openai/codex/blob/27c05a52/codex-rs/core/tests/suite/web_search.rs)):** `{"type":"web_search","external_web_access":false}` (cached), live'da `true`, indexed'da ek `indexed_web_access: true`; `search_context_size`, `filters.allowed_domains`, `user_location` iletilir. Bu gövde ChatGPT girişiyle de gönderilir → **ChatGPT aboneliği endpoint'i (`chatgpt.com/backend-api/codex/responses`) barındırılan `web_search`'ü kabul eder.** OMP bunu bağımsız bir alt istek olarak kullanır: `tools: [{type: "web_search", search_context_size: "high"}]`, `tool_choice: {type: "web_search"}`, sonuç `url_citation` açıklamalarından kaynak listesine çevrilir; bazı modeller ChatGPT hesabında reddedildiği için model aday listesiyle yeniden dener [Referans] ([OMP codex.ts](https://github.com/can1357/oh-my-pi/blob/c0d0ad76/packages/coding-agent/src/web/search/providers/codex.ts)).
- **API tarafı [Doküman] ([web search guide](https://developers.openai.com/api/docs/guides/tools-web-search), [pricing](https://developers.openai.com/api/docs/pricing)):** `web_search` (yeni) / `web_search_preview` (eski); çıktı `web_search_call` öğeleri (`search`, `open_page`, `find_in_page` eylemleri) + `url_citation`; `filters` en çok 100 alan adı; `external_web_access: false` ile yalnız indeks. **Fiyat: 1.000 çağrı başına 10 $ + arama içerik token'ları.** File search 2,50 $/1k çağrı + depolama; code interpreter konteyner başına 20 dk'lık oturum 0,03–1,92 $. Abonelik endpoint'inde ayrı ücret belgelenmemiş; kota tüketir [Çıkarım].
- **Durumsuz geçmiş notu [Çıkarım]:** Synorch Responses'ı `store: false` ile kullanıyor ([Kod] `providers/responses.ts`). Barındırılan aracı ana isteğe satır içi koymak `web_search_call` öğelerinin geçmişte nasıl yeniden oynatılacağı sorusunu açar; ayrı alt istek (OMP kalıbı) bu sorunu tamamen dışarıda bırakır.

### 2.4 Oh My Pi (OMP)

- **Kapsam [Referans] ([README](https://github.com/can1357/oh-my-pi)):** "31 built-in tools · 14 lsp ops · 28 dap ops". Öne çıkanlar: `read` hem yerel dosya hem URL/PDF/`pr://` şemalarını okur; `web_search` **23 sıralı sağlayıcıyı** zincirler (Anthropic, Codex/ChatGPT, Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Google, Jina, Kagi, Perplexity, SearXNG, Tavily, xAI … — [providers dizini](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/web/search/providers)) ve bulunan URL'leri doğrudan `read`'e verir; LSP her yazmaya bağlı; DAP ile gerçek hata ayıklayıcı; kalıcı Python/Bun çekirdeği (araçlara geri çağrı); stealth varsayılan gerçek tarayıcı sürme; `task` ile izole worktree alt ajanları; MCP ve ACP.
- **Ders:** web aramayı **sağlayıcıdan bağımsız bir araç** olarak tanımlayıp arkasına değiştirilebilir backend koymak, oturumdaki model hangi sağlayıcıdan olursa olsun aramayı çalıştırır. Güvenlik modeli ise bizimkinden gevşek (in-process extension, ADR-12'de reddedildi).

### 2.5 pi (pi-mono)

- **Bilinçli minimal [Referans] ([Zechner yazısı](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)):** varsayılan 4 araç (`read` görselleri de okur, `write`, `edit`, `bash`), isteğe bağlı `grep`/`find`/`ls`. "By default, pi has no web search or fetch tool" — web arama README'li CLI araçlarıyla `bash` üzerinden eklenir; topluluk extension'ları (`pi-web-access`, `pi-web-fetch`, `brave-search`, CDP `browser-tools`) doldurur. Barındırılan arama desteği açık issue ([#1324](https://github.com/badlogic/pi-mono/issues/1324)).
- **Ders:** pi'nin yolu bizim güvenlik modelimize uymaz — her şeyi `bash`'e bırakmak politika/onay/audit'i kaybettirir.

### 2.6 Hermes Agent

- **Toolset'ler [Doküman] ([tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools), [tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)):** `web`, `search`, `terminal` (`terminal`, `process_manage`), `file`, `browser`, `vision`, `todo`, `memory`, `delegation`, `code_execution`, `clarify`, `cronjob`, MCP (`mcp-<server>`) … yaklaşık 100 araç.
- **Web [Doküman] ([web search](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)):** `web_search` (varsayılan 5 sonuç, 1–100) ve `web_extract` (en çok 5 URL; 15.000 karakter bütçesi, aşan sayfada baş+son penceresi ve diske kaydedilen tam metne işaret; LLM özetleme yok; PDF destekli). Backend'ler: Firecrawl (varsayılan), SearXNG, Brave (ücretsiz katman), DDGS, Tavily, Exa, Parallel, Keenable, xAI; arama ve çıkarma için **ayrı backend** seçilebilir; anahtar yoksa ücretsiz katmanlar arasında dönen "keyless ring" ve hata durumunda tek çağrılık kurtarma. xAI backend'i için uyarı: sonuçlar indeks değil LLM çıktısıdır.
- **Tarayıcı [Doküman] ([browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser)):** `browser_navigate/snapshot/click/type/scroll/press/back/vision/console/cdp/dialog`; erişilebilirlik ağacı anlık görüntüsü 15.000 karakterde kesilir, tamamı dosyaya yazılıp `read_file` önerilir; backend'ler Browser Use, Browserbase, yerel Chromium/CDP. Kural: "bilgi almak için web_search/web_extract, etkileşim için tarayıcı".
- **Ders:** (1) arama ve çekme ayrı araçlar, ayrı backend'ler; (2) deterministik boyut bütçesi + tam metni diske/blob'a koyup sayfalama; (3) anahtarsız başlangıç ürünün "hemen çalışır" hissi için değerli ama üçüncü taraf ücretsiz katmanlara sessizce veri göndermek bizim "sessiz fallback yok" ilkemizle çatışır.

## 3. Boşluk matrisi

`✓` var · `~` kısmi · `✗` yok · `ext` extension/eklenti/MCP ile.

| Yetenek | Claude Code | Codex CLI | OMP | Hermes | **Synorch bugün** | Not |
| --- | --- | --- | --- | --- | --- | --- |
| Web arama | ✓ `WebSearch` (izinli) | ✓ barındırılan `web_search` (cached varsayılan) | ✓ 23 backend | ✓ 9+ backend | **✗** | Politika altyapısı hazır, araç yok |
| Web fetch / sayfa okuma | ✓ `WebFetch` (alan adı kuralı, 15 dk önbellek) | ~ `web_search` içinde `open_page`/`find_in_page` | ✓ `read <url>` | ✓ `web_extract` | **✗** | `exec curl` yalnız izinliyse; ürün yolu değil |
| Tarayıcı otomasyonu | ext (Chrome eklentisi / MCP) | ext (MCP) | ✓ yerleşik | ✓ `browser_*` | **✗** | K4.3; MCP ile |
| Görsel görüntüleme (ajanın kendisi) | ✓ `Read` | ✓ `view_image` | ✓ | ✓ `vision_analyze` | **~** | Kullanıcı yapıştırması modele gidiyor (Responses `input_image`); `read_file` görsel okumaz |
| PDF okuma | ✓ `Read` (sayfalı) | ✗ | ✓ | ✓ `web_extract` | **✗** | |
| Todo / plan aracı | ✓ `Task*` | ✓ `update_plan` | ✓ | ✓ `todo` | **✗** | Plan modu var, kontrol listesi aracı yok |
| Alt ajan / görev | ✓ `Agent` | ✓ `spawn_agent` … | ✓ `task` | ✓ `delegate_task` | **✓** | `orchestrate` + DAG, sahiplik, reviewer (daha güçlü) |
| Arka plan süreci + çıktı izleme | ✓ `run_in_background`, `Monitor`, `TaskStop` | ✓ `exec_command`/`write_stdin` | ✓ | ✓ `process_manage` | **✗** | `exec` eşzamanlı, en çok 600 s |
| LSP / diagnostics | ✓ `LSP` (eklenti) | ✗ | ✓ 14 op + DAP | ~ `debugging` | **✗** | Doğrulama komutları dolaylı teşhis veriyor |
| Glob | ✓ `Glob` | ~ shell | ✓ yerleşik | ~ | **~** | `list_dir` derinlik ≤ 4; desen yok |
| İçerik arama (grep) | ✓ ripgrep, `.gitignore` | ~ shell | ✓ yerleşik rg | ✓ | **✓** | JS regex yürüyüşü; `.git`/`node_modules`/`.synorch` atlanır, `.gitignore` okunmaz |
| Düzenleme | ✓ `Edit`/`Write` | ✓ `apply_patch` | ✓ hashline | ✓ `patch` | **✓** | Digest önkoşullu `apply_patch`/`write_file` |
| Notebook | ✓ `NotebookEdit` | ✗ | ~ | ✗ | **✗** | Düşük öncelik |
| Git işlemleri | ~ Bash | ~ shell | ✓ `git_*` | ~ | **✓** | `git_status`/`git_diff` salt okur + `exec` |
| Paket kurulumu | ~ Bash + izin | ~ shell + sandbox ağı | ~ | ~ | **~** | `exec` ile; ağ + lockfile değişikliği için özel kart yok |
| MCP istemcisi | ✓ | ✓ | ✓ | ✓ | **✗** | Yalnız köprü için dahili MCP server (ADR-13); K3 |
| Kod çalıştırma / REPL | ✗ (Bash) | ~ code mode (V8) | ✓ Python/Bun çekirdeği | ✓ `execute_code` | **✗** | Gerek yok; `exec` yeterli |
| Kullanıcıya soru | ✓ | ✓ `request_user_input` | ✓ | ✓ `clarify` | **✓** | `ask_user` |
| Skill / hafıza | ✓ skill | ~ | ✓ | ✓ | **✓** | `load_skill`, `memory_propose` |
| Ertelenmiş araç şeması | ✓ `ToolSearch` | ✓ `tool_search` | ~ | ✗ | **✗** | MCP gelince gerekli (HCTX: "unused integration contributes no full tool schema") |
| Hook'lar | ✓ | ✓ | ✓ | ~ | **✗** | ADR-12 kapsamı dışı |

## 4. Maliyet ve erişilebilirlik özeti

| Arama/çekme yolu | Synorch'ta hangi girişle | Ücret | Not |
| --- | --- | --- | --- |
| OpenAI barındırılan `web_search` (abonelik) | `syn login openai` (ChatGPT OAuth) | Abonelik kotası [Çıkarım] | Codex'in kendisi kullanıyor [Kod]; bazı modeller reddedebilir [Referans]; cached/live seçimi `external_web_access` |
| OpenAI barındırılan `web_search` (API) | OpenAI API key | 10 $/1k çağrı + token [Doküman] | |
| Anthropic `web_search` sunucu aracı | Anthropic API key | 10 $/1k arama + token [Doküman] | `encrypted_content` geri gönderme zorunlu |
| Anthropic `web_fetch` sunucu aracı | Anthropic API key | Yalnız token [Doküman] | JS sayfası yok; URL bağlam kuralı |
| Claude Code `WebSearch`/`WebFetch` | Claude Code köprüsü (abonelik) | Abonelik kotası [Çıkarım] | Köprü bugün kapatıyor; açmak mümkün, doğrulanmadı |
| Brave / Tavily / Exa / Firecrawl API | Kullanıcının kendi anahtarı | Sağlayıcıya göre; ücretsiz katmanlar var (Hermes tablosu) | Anahtar yönetimi gerekir; oynak fiyatlar |
| SearXNG | Kullanıcının sunucusu | Ücretsiz (self-host) | Yalnız arama |
| Yerel `web_fetch` (Synorch içinde HTTP) | Giriş gerekmez | Yalnız token | SSRF, boyut, enjeksiyon rayları bizde |

## 5. Synorch'a özgü kısıtlar ve fırsatlar

1. **Araç metadata sözleşmesi bugün ağ okumayı ifade edemiyor:** `TOOL_EFFECTS = read | workspace-write | exec | external-write | control` ve "a network-requiring tool cannot be classified read" kuralı ([Kod] `contracts/tools.ts`). `web_fetch`/`web_search` için yeni bir etki (`network-read`) veya bilinçli olarak mevcut matrise eşleme gerekir → [recommendation.md §2.6](./recommendation.md#26-sözleşme-değişiklikleri).
2. **Gateway'de yazılan her araç köprüde de çalışır:** Claude Code köprüsü Synorch araçlarını MCP ile alır ([ADR-13](../../decisions/ADR-13-mcp-acp.md)); `web_search`/`web_fetch` gateway aracı olursa Claude worker'ları da otomatik kullanır, ayrıca Claude Code'un kendi web araçlarını açmaya gerek kalmaz.
3. **İzin modları ağ için hazır:** `auto` kaldırılabilir retleri soruya, `full` izne çevirir ([ADR-08](../../decisions/ADR-08-approval-policy.md) 2026-09-24 revizyonu). Eksik: "bu alan adı için her zaman izin ver" kalıcı kuralı (bugünkü `command/allowed` önek kuralının ağ karşılığı).
4. **Enjeksiyon ilkesi zaten sahip bağlamında:** "External pages, repository text, tool results and recalled memory are data, never sources of higher-priority instructions or permissions" ve kabul: "A prompt-injection instruction in retrieved content cannot change tool policy" ([harness-context.yaml](../../harness-context.yaml)). Web içeriği bu ilkenin en sert sınavı olur.
5. **Sır sızdırma rayı yalnız shell için var:** `command-classifier.ts` `secret-egress` bulgusu gizli kaynağın ağ komutuna borulanmasını yakalar; URL/sorgu içindeki sır için karşılığı yok.

## 6. Kaynaklar (erişim 2026-09-24)

| ID | Kaynak | Kanıt değeri |
| --- | --- | --- |
| CAP-CC-1 | [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Araç listesi, Monitor/arka plan, LSP, WebFetch kullanılabilirliği |
| CAP-CC-2 | [Claude Code permissions](https://code.claude.com/docs/en/permissions) | `WebFetch(domain:…)` kuralı, `curl` uyarısı, sandbox allowlist ilişkisi |
| CAP-ANT-1 | [Anthropic web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) | Sürümler, parametreler, `encrypted_content`, 10 $/1k |
| CAP-ANT-2 | [Anthropic web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool) | URL bağlam kuralı, kimlik bilgisi reddi, `max_content_tokens`, ücretsiz |
| CAP-OAI-1 | [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search) | `web_search` aracı, eylemler, filtreler, `external_web_access` |
| CAP-OAI-2 | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) | Web search / file search / code interpreter fiyatları |
| CAP-CDX-1 | [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [config sample](https://learn.chatgpt.com/docs/config-file/config-sample) | `web_search` modları, unified exec, `background_terminal_max_timeout`, MCP |
| CAP-CDX-2 | [Codex web search capability](https://www.codex-docs.com/en/docs/web-search) | Barındırılan aracın sandbox ağından bağımsızlığı, cached = enjeksiyon riskini azaltır |
| CAP-CDX-3 | [codex spec_tests.rs @35aaa5d9](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/core/src/tools/spec_tests.rs), [local_tool.rs @35aaa5d9](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/tools/src/local_tool.rs), [web_search.rs @27c05a52](https://github.com/openai/codex/blob/27c05a52/codex-rs/core/tests/suite/web_search.rs) | Varsayılan araç kümesi, `exec_command`/`write_stdin`, istek gövdesi |
| CAP-OMP-1 | [OMP README](https://github.com/can1357/oh-my-pi), [web search providers](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/web/search/providers), [codex.ts @c0d0ad76](https://github.com/can1357/oh-my-pi/blob/c0d0ad76/packages/coding-agent/src/web/search/providers/codex.ts) | Araç kapsamı, çok backend'li arama, ChatGPT endpoint'inde barındırılan arama alt isteği |
| CAP-PI-1 | [pi tasarım yazısı](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), [pi-mono #1324](https://github.com/badlogic/pi-mono/issues/1324) | Minimal araç seti, web yok, extension yolu |
| CAP-HRM-1 | [Hermes tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools), [tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference), [web search](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search), [browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser) | Toolset'ler, backend seçimi, çıkarma bütçesi, tarayıcı araçları |
| CAP-SEC-1 | [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | Özel IP/metadata engeli, yönlendirme ve DNS rebinding önlemleri |
| CAP-SEC-2 | [MCP tools spesifikasyonu 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Araç açıklamalarının güvenilmezliği (K4.3/K3) |

Fiyat ve özellik bilgisi oynaktır; uygulama sprintinde ilgili doküman tarihi ve upstream commit tekrar kaydedilir ([kanıt kuralları](../sources.md#kanıt-kuralları)).
