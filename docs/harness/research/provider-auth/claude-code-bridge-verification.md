# Claude Code köprüsü: gerçek CLI ile doğrulama

> Tarih: 2026-09-25. CLI: `claude --version` → **2.1.282 (Claude Code)**, Windows 11, abonelik girişi. Kapsam: `src/harness/providers/claude-code/**`, native mod. Canlı çağrılar kısa `claude -p` (haiku/sonnet) koşularıydı; kimlik bilgisi dosyası okunmadı.
> Dal: `claude-bridge-verify`.

Doğrulama yöntemi: (a) doğrudan `claude -p --output-format stream-json --verbose` koşuları ve `system/init` mesajının `mcp_servers` / `tools` / `plugins` alanları; (b) gerçek `createClaudeCodeAdapter({ mode: "native" })` ile, gerçek çalışma zamanı kayıt defterinden (`createRuntime` → `registry.visibleTo("session", …)`) alınan araç tanımlarını röle üzerinden sunan geçici bir betik (araç gövdeleri kayıt eden sahte yanıtlar; gerçek orkestrasyon başlatılmadı).

## 1. `--strict-mcp-config` altında Claude plugin MCP sunucuları — **düzeltildi**

- Kanıt: `--setting-sources user --strict-mcp-config --mcp-config {boş}` ile `init.plugins` açık `exa` plugin'ini listeliyor ama `init.mcp_servers` = `[]`. Aynı komut `--strict-mcp-config` olmadan: `plugin:exa:exa` (source `plugin`, connected) ve tüm kullanıcı/claude.ai sunucuları geliyor. Yani strict modda Claude kendi plugin'lerinin MCP sunucularını **yüklemiyor**.
- Eski davranış: `McpManager.claudeServers()` `claude-plugin` kaynaklı sunucuları "Claude zaten yükler" diye atlıyordu; başka bir harici sunucu varken röle de tüm `mcp__*` araçlarını gizlediği için plugin MCP araçları Claude rotasında tamamen kayboluyordu.
- Ek kanıt: `--mcp-config` içinde sunucuyu Claude'un kendi adıyla (`"plugin:exa:exa"`) vermek kabul ediliyor (`source: dynamic`, connected) ve araç adları Claude'un normal adlarıyla aynı çıkıyor (`mcp__plugin_exa_exa__web_search_exa`, …): izin kuralları ve alışkanlıklar korunuyor, çift kayıt yok (strict modda plugin yüklemesi zaten yok).
- Düzeltme: `McpServerDefinition.claudeName` (`plugin:<plugin>:<sunucu>`) katalogda Claude plugin'leri için dolduruluyor; `claudeServers()` artık `claude-plugin` sunucularını bu adla ekliyor; `externalAllowed()` sunucu adını Claude'un araç adı biçimine çeviriyor (`[^A-Za-z0-9_-]` → `_`, ör. `mcp__plugin_exa_exa`). Test: `tests/harness-mcp.test.ts` (claude-plugin sunucusu `plugin:exa:exa` anahtarıyla geçiyor).

## 2. Oturum araçları röle üzerinden — **doğrulandı**

- Gerçek kayıt defterinde oturum rolünde `orchestrate`, `run_status`, `run_steer`, `run_cancel`, `ask_user`, `load_skill` görünür (autonomous politika).
- Canlı koşu: `backend_init.tools` içinde `mcp__synorch__ask_user`, `…load_skill`, `…orchestrate`, `…run_cancel`, `…run_status`, `…run_steer` var. Claude altısını da sırayla çağırdı; çağrılar köprünün `tools.call`'ına şemaya uygun argümanlarla ulaştı (ör. `run_steer {message:"hi"}`, `ask_user {questions:[…]}`, `orchestrate {goal, reason}`), sonuç metinleri Claude'a döndü.
- Not: Claude Code MCP araçlarını ertelenmiş (ToolSearch) olarak sunuyor; model önce şemaları çekip sonra çağırdı, sorun çıkmadı. Bridge araçları `--allowedTools mcp__synorch__*` sayesinde izin istemi üretmedi (onay broker'ına hiç çağrı gelmedi).
- Kayıt boşluğu bulunmadı; düzeltme gerekmedi.

## 3. `--resume` ve çok turlu süreklilik — **doğrulandı + boşluk düzeltildi**

- Canlı: 1. tur `--session-id <uuid>` ("PAPAYA-42 kodunu hatırla"), 2. tur aynı sürücü akışı gibi `resumeBackendSessionId` ile yeni süreç → `--resume <uuid>`; yanıt `PAPAYA-42`, iki turda da `backend_init.backend_session_id` aynı.
- Boşluk: Synorch oturumu → Claude oturum kimliği eşlemesi (`AgentDriver.#backendSessions`, anahtar `adapter:model`) yalnız bellekte. `syn agent --resume/--continue` sonrası, model değişiminde veya başka sağlayıcıdan Claude'a geçişte yeni bir Claude oturumu açılıyor ve adaptör yalnız son kullanıcı mesajını gönderiyordu → önceki konuşma kayboluyordu.
- Düzeltme: taze bir Claude oturumunda (`--session-id`, resume değil) istek mesajlarındaki önceki turlar bir kez `<conversation_so_far>` metin bloğu olarak ilk kullanıcı mesajının başına ekleniyor (`priorTranscript`, 60k karakter sınırı, araç çağrısı/sonucu kısaltılmış). Sonraki adımlar yine `--resume` ile yalnız yeni mesajı yolluyor. Canlı: geçmişte "MANGO-7" olan, `resumeBackendSessionId` olmadan açılan oturum `MANGO-7` yanıtını verdi. Test: `tests/harness-claude-native.test.ts`.

## 4. Görseller — **doğrulandı** (sınırlama notlu)

- Depoda izlenen raster görsel yok (yalnız SVG; Claude görsel bloğu SVG almaz). Mevcut bir PNG kullanıldı: `node_modules/.pnpm/zod-to-json-schema…/.github/CR_logotype-full-color.png` (11 KB, oluşturulmadı).
- Adaptör yolu: kullanıcı mesajındaki `image` parçası stream-json `{"type":"image","source":{"type":"base64",…}}` bloğu olarak gidiyor. Soru "hiçbir araç kullanmadan görseldeki yazı ne?" → yanıt `CodeRabbit` (doğru). Görsel Claude'a ulaşıyor; düzeltme gerekmedi.
- Sınırlama: Synorch'un kendi araç sonucu görselleri (ör. `view_image`) röle üzerinden yalnız metin olarak döner; native modda Claude görsel dosyaları kendi `Read` aracıyla okuyabildiği için bu kabul edilebilir.

## 5. Efor (`--effort`) — **doğrulandı**

- `claude --help`: `--effort <level>` (low, medium, high, xhigh, max). `buildClaudeArgs` `ultra`'yı `max` olarak yollar.
- Canlı: geçersiz değer (`--effort bogus`) stderr'e "Unknown --effort value … ignoring it" uyarısı basıyor; `--effort xhigh --model sonnet` koşusunda stderr boş, sonuç `success` → geçerli değerler sessizce kabul ediliyor. Adaptör üzerinden `reasoningEffort: "low"` ile yapılan turlar hatasız tamamlandı.
- Not: `system/init` etkin efor değerini raporlamıyor (`per_turn_effort_active` ayrı bir özellik); kabul kanıtı uyarının yokluğu.

## Diğer gözlemler

- `--permission-mode` seçenekleri 2.1.282'de `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`; köprünün kullandığı `manual/auto/bypassPermissions/plan` geçerli.
- Native modda Synorch'un dosya/komut araçları (`read_file`, `exec`, …) röle listesinde Claude'un yerleşik araçlarıyla birlikte duruyor (yalnız web araçları gizleniyor); bu bir tasarım tercihi, değiştirilmedi.
