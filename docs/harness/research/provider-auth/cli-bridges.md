# CLI/SDK köprüleri: aboneliği kullanıcının kendi resmi istemcisi üzerinden kullanmak

> Statü: araştırma; runtime uygulanmadı. İnceleme: 2026-09-22. Kaynaklar: Claude Code resmi dokümanı (`code.claude.com/docs`), OpenAI Codex resmi dokümanı (`developers.openai.com/codex`), `openai/codex` commit `d93909a939e40c3c1031f5a713bacad8c0d9afe6`.

Köprü modelinde Synorch token görmez; kullanıcı kendi makinesinde resmi istemciye (Claude Code / Codex) kendisi giriş yapar, Synorch bu istemciyi alt süreç olarak sürer. Bunun bedeli: **agent döngüsü backend'in içindedir**. Synorch bir "model" değil, bir "tur çalıştırıcı" (turn runner) çağırır. Synorch'un izin, audit ve araç sözleşmesini korumak için backend'in yerleşik araçları kapatılıp Synorch araçları MCP (Claude) veya `dynamicTools` (Codex) ile verilmelidir.

## 1. Claude Code köprüsü

### 1.1 Politika durumu

- Kullanıcının kendi Claude Code kurulumu, Anthropic'in "native application"ıdır; `claude -p` ve Agent SDK kullanımı Anthropic destek makalesinde abonelik limitlerinden düşen kullanım olarak anılıyor: "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." ([support 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), 2026-06-16) [Doküman]
- Öte yandan: "Developers building products or services … including those using the Agent SDK, should use API key authentication" ve "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." ([legal](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)) [Doküman]
- 2026-04 itibarıyla "third-party harness" trafiği abonelik yerine "extra usage"dan düşüyor ([The Register](https://www.theregister.com/software/2026/04/06/anthropic-closes-door-on-subscription-use-of-openclaw/5222854)). Claude Code'u alt süreç olarak süren bir harness'ın bu sınıfa girip girmediği resmi olarak belirtilmemiş. OpenClaw dokümanı: "Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned … unless Anthropic publishes a new policy" ([docs.openclaw.ai/concepts/oauth](https://docs.openclaw.ai/concepts/oauth)) [İkincil, doğrulanamadı].
- **Hüküm: belirsiz.** Synorch Claude.ai login sunmuyor ve token taşımıyor (lehte), ama bir "product" olarak kullanıcının plan limitlerini kullanıyor (aleyhte). Yazılı onay alınmadan varsayılan olmamalı; açık opt-in ve uyarı ile "deneysel" sunulabilir. Bkz. [recommendation.md](./recommendation.md).

### 1.2 Kimlik doğrulama davranışı

[Doküman] <https://code.claude.com/docs/en/authentication>, <https://code.claude.com/docs/en/headless>:

- Öncelik: bulut sağlayıcı env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profil/federasyon → `/login` abonelik OAuth'u. `-p` modunda `ANTHROPIC_API_KEY` varsa her zaman o kullanılır. **Köprü abonelik kullanacaksa alt sürecin env'inden `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` temizlenmelidir**; aksi halde sessizce API faturalanır.
- `--bare` modunda "Claude Code never reads OAuth credentials or the system keychain" — **abonelik köprüsünde `--bare` kullanılamaz**. Doküman: "`--bare` … will become the default for `-p` in a future release." Bu, köprünün gelecekte kırılma riskidir. **[Açık karar]**: bare varsayılan olduğunda aboneliği korumanın resmi yolu izlenmeli.
- Aktif kimlik kaynağı `system/init` mesajındaki `apiKeySource` alanından okunur (`"ANTHROPIC_API_KEY" | "apiKeyHelper" | "/login managed key" | "oauth" | "none" | …`). Synorch bunu UI'da "Claude aboneliği / API key" olarak göstermeli.
- Giriş süresi dolunca istekler `Login expired · Please run /login` ile düşer; `system/api_retry.error` kategorileri: `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, `overloaded`, … .

### 1.3 Seçenek A: `claude -p` stream-json

[Doküman] <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/headless>

Önerilen komut iskeleti:

```
claude -p \
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --tools "" \
  --mcp-config '<synorch MCP sunucusu JSON>' --strict-mcp-config \
  --allowedTools "mcp__synorch__*" \
  --permission-prompt-tool mcp__synorch__approve \
  --setting-sources "" \
  --system-prompt-file <synorch rol talimatı> \
  --model <alias|tam id> \
  --session-id <uuid> | --resume <id> \
  --max-turns <n>
```

- `--tools ""` tüm yerleşik araçları kapatır; `--disallowedTools` ise isim bazlı kaldırır. `--allowedTools` yalnız "izinsiz çalışanlar"ı belirler, kısıtlama için `--tools` kullanılmalı.
- `--mcp-config` + `--strict-mcp-config`: yalnız Synorch'un MCP sunucusu. `-p` ile ilk turdan önce bekleyen sunucular `MCP_TIMEOUT`'a kadar beklenir.
- İzin: `--permission-prompt-tool <mcp aracı>` izin isteklerini Synorch'a yönlendirir; `--permission-prompts none` insan yoksa reddeder. Synorch kendi araçlarında izni zaten kendi runtime'ında uyguluyorsa MCP aracı içinde karar verilir.
- `--setting-sources` ile kullanıcı/proje ayarlarının (boş değer `""` kabul edilip edilmediği doğrulanmadı; iskeletteki kullanım varsayımdır) (hook, CLAUDE.md, `.mcp.json`) sızması engellenmeli; doküman `--bare` olmadan `-p`'nin proje `.claude/settings.json` hook'larını ve `.mcp.json` sunucularını güven diyaloğu olmadan çalıştırdığını söylüyor. Kalan otomatik keşif (auto memory, skills) için `--safe-mode`/`--restricted` davranışı deneyle doğrulanmalı. **[Açık karar]**
- Girdi (stream-json): satır başına `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).
- Çıktı olayları: `system/init` (model, tools, mcp_servers, apiKeySource, capabilities), `stream_event` (ham Messages SSE: `text_delta`, `input_json_delta`…), `assistant`, `user` (tool_result), `system/api_retry`, `permission_denied`, son satır `result` (`subtype: success|error_max_turns|error_during_execution|error_max_budget_usd…`, `usage`, `modelUsage`, `total_cost_usd`, `permission_denials`, `session_id`).
- **İptal:** SIGINT turu düzgün bitirir; SIGTERM çıkış kodu 143, tur yarım kalır ve resume'da devam eder. Önce SIGINT (veya SDK `interrupt()`), zaman aşımında SIGTERM.
- **Oturum:** `--session-id <uuid>` / `--resume <id|jsonl yolu>` / `--fork-session`; `--no-session-persistence` diske yazmaz. Claude Code transkriptini kendisi tutar; Synorch kendi JSONL'sini ayrıca tutar (çift kayıt). Resume, sistem prompt'unu ilk istekte kaydeder (`--system-prompt-snapshot`).
- **Kullanım:** `result.usage` (input/output/cache token), `modelUsage`; abonelikte `total_cost_usd` gerçek fatura değil tahmindir [Çıkarım]. Abonelik kotası yüzdesi bu akışta yok.

### 1.4 Seçenek B: `@anthropic-ai/claude-agent-sdk` (TypeScript)

[Doküman] <https://code.claude.com/docs/en/agent-sdk/typescript>

- `query({ prompt, options })` bir `Query` (async iterator) döner; SDK altında Claude Code ikilisini alt süreç olarak başlatır. TypeScript SDK platforma göre native ikiliyi opsiyonel bağımlılık olarak paketler; `pathToClaudeCodeExecutable` ile kullanıcının kurulu `claude`'u gösterilebilir. **Öneri:** kullanıcının kendi kurulu Claude Code'u kullanılmalı (kullanıcının "kendi resmi istemcisi" argümanı için).
- Önemli seçenekler: `tools: []` (yerleşik araç yok), `mcpServers: { synorch: createSdkMcpServer({ name, tools: [tool(...)] }) }` (süreç içi MCP), `strictMcpConfig: true`, `allowedTools`, `canUseTool(toolName, input, { signal, … })` → `PermissionResult`, `permissionMode`, `systemPrompt` (string veya `{type:'preset', preset:'claude_code', append}`), `settingSources: []`, `resume`, `forkSession`, `persistSession`, `includePartialMessages`, `maxTurns`, `model`, `cwd`, `env` (burada `ANTHROPIC_API_KEY` silinmeli), `abortController`.
- Streaming input modunda `Query.interrupt()` turu keser (CLI `interrupt_receipt_v1` yetkinliği ile makbuz döner).
- Mesaj tipleri CLI stream-json ile aynı (`SDKSystemMessage` init + `apiKeySource`, `SDKAssistantMessage`, `SDKPartialAssistantMessage`, `SDKResultMessage`).
- Artı: tip güvenliği, süreç içi MCP, `canUseTool` geri çağrısı. Eksi: npm bağımlılığı ve sürüm eşleşmesi; lisans ayrıca kontrol edilmeli (Anthropic ticari şartları) **[Açık karar]**.

### 1.5 Bizim araçlarımızı vermek vs. backend'in araçlarını kullanmak

| Mod | Nasıl | Synorch sözleşmesine etkisi |
| --- | --- | --- |
| **Synorch araçları (önerilen)** | `--tools ""` / `tools: []` + Synorch MCP sunucusu | İzin, audit, sandbox, dosya sahipliği Synorch'ta kalır. Claude, araç adlarını `mcp__synorch__<ad>` olarak görür. |
| Claude Code araçları | Varsayılan araçlar + `canUseTool`/izin kuralları | Dosya/shell yan etkileri Claude Code'da olur; Synorch yalnız olay akışından gözlemler. Worker izolasyonu ve kanıt paketi zayıflar. |

### 1.6 Bilinen kısıtlar

- Model seçimi Claude Code'un kabul ettiği alias/ID'lerle sınırlı; plan izin vermeyen modeller (ör. bazı 1M bağlam varyantları) hata verir.
- Her tur bir alt süreç (veya uzun ömürlü streaming süreç) demek; başlangıç gecikmesi ve bellek maliyeti vardır.
- Claude Code kendi sistem prompt'unu ve bağlam yönetimini (compaction) uygular; `--system-prompt` ile değiştirmek mümkün ama compaction/araç arama davranışı Claude Code'undur.

## 2. Codex köprüsü

### 2.1 Politika durumu

OpenAI, App Server'ı ürün içi derin entegrasyon yüzeyi olarak tanıtıyor: "Choose the App Server when you want the full Codex harness exposed as a stable, UI-friendly event stream. You get both the full functionality of the agent loop and other supporting features like Sign in with ChatGPT, model discovery, and configuration management." ([OpenAI blog, 2026-02-04](https://openai.com/index/unlocking-the-codex-harness/)) [Doküman]. Codex Apache-2.0 lisanslı. Kurumsal kullanım için `clientInfo.name`'in "known clients list"e eklenmesi isteniyor; kayıt kanalı belirsiz ([openai/codex discussion #8338](https://github.com/openai/codex/discussions/8338)). **Hüküm: izinli (kamuya açık destek), kayıt süreci açık.**

### 2.2 `codex exec --json`

[Doküman] <https://developers.openai.com/codex/noninteractive>; [Kod] `codex-rs/exec/src/exec_events.rs`

- JSONL olaylar: `thread.started {thread_id}`, `turn.started`, `turn.completed {usage: {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}`, `turn.failed {error}`, `item.started|item.updated|item.completed {item}`, `error {message}`.
- Item tipleri: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`.
- Bayraklar: `--sandbox read-only|workspace-write|danger-full-access`, `--ephemeral`, `--output-schema`, `-o/--output-last-message`, `--skip-git-repo-check`, `-m <model>`; devam: `codex exec resume <id>` / `--last`.
- Kimlik: `~/.codex/auth.json` (kullanıcının `codex login`'i) veya `CODEX_API_KEY`.
- Kısıt: Synorch araçlarını vermenin yolu yalnız MCP (`-c mcp_servers…` config); tek seferlik süreç; ince izin geri çağrısı yok. Basit "worker" görevleri için uygundur, etkileşimli orkestrasyon için değil.

### 2.3 `codex app-server` (önerilen Codex köprüsü)

[Doküman] <https://developers.openai.com/codex/app-server>; [Kod] `codex-rs/app-server-protocol/src/protocol/common.rs`, `v2/thread.rs`, `v2/item.rs`

- Taşıma: `codex app-server` (varsayılan `--listen stdio://`), JSON-RPC 2.0 ( `"jsonrpc"` alanı telde yok), satır başına bir mesaj.
- Yaşam döngüsü: `initialize {clientInfo:{name:"synorch", title, version}, capabilities:{experimentalApi:true}}` → `initialized` bildirimi → `thread/start {model, cwd, approvalPolicy, sandbox, dynamicTools, serviceName}` → `turn/start {threadId, input:[…]}` → olaylar → `turn/interrupt {threadId, turnId}` (tur `status:"interrupted"` ile biter) → `thread/resume {threadId}`.
- **Bizim araçlarımız:** `thread/start.dynamicTools` (deneysel; `experimentalApi` gerekir). Çağrı olunca sunucu→istemci isteği `item/tool/call {threadId, turnId, callId, namespace?, tool, arguments}`; yanıt `{contentItems:[{type:"inputText", text}|…], success}`. Dinamik araçlar rollout'a yazılır ve resume'da geri yüklenir. Ad kuralları Responses API ile aynı; Codex'in ayrılmış namespace'leri kullanılmamalı.
- Yerleşik araçlar ve onay: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` sunucu istekleri; `approvalPolicy`/`sandbox` ile sınırlandırılır. Synorch araç sözleşmesini korumak için shell/dosya araçlarını kapatmanın resmi config yolu deneyle doğrulanmalı **[Açık karar]**; en azından `sandbox: "readOnly"` + tüm onaylara ret.
- Olaylar: `turn/started`, `turn/completed`, `item/started`, `item/completed` (otoriter), `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `thread/tokenUsage/updated`, `model/rerouted`.
- Hesap: `account/read`, `account/login/start {type:"chatgpt"|"chatgptDeviceCode"|"apiKey"|"chatgptAuthTokens"}`, `account/login/completed`, `account/rateLimits/read` (primary/secondary pencere yüzdesi + `resetsAt`), `account/usage/read`. Böylece Synorch girişi Codex'e bırakabilir ve kota göstergesini resmi API'den okuyabilir.
- Deneysel `chatgptAuthTokens` modu: host uygulama kendi aldığı ChatGPT token'ını app-server'a verir ve `account/chatgptAuthTokens/refresh` isteğine yanıt verir.
- Codex home izolasyonu: `CODEX_HOME` ile Synorch'a ait ayrı dizin; kullanıcının `~/.codex` oturumu bozulmaz (OpenClaw `homeScope` notu benzer).

### 2.4 `codex mcp-server`

Codex'i MCP sunucusu olarak açar; Synorch bir MCP istemcisi olarak "codex" aracını çağırır. Bu, Codex'i Synorch içinde tek bir alt ajan aracı gibi kullanmaya uygundur ama model katmanı yerine geçmez. Ayrıntılı protokol bu turda incelenmedi. **[Açık karar]**

## 3. Köprü adapter'ının Synorch runtime'ına eşlenmesi (öneri)

| Synorch kavramı | Claude köprüsü | Codex app-server köprüsü |
| --- | --- | --- |
| stream | `stream_event` + `assistant` | `item/*/delta` + `item/completed` |
| tool call | MCP `tools/call` (Synorch MCP sunucusu) | `item/tool/call` |
| approval | `canUseTool` / `--permission-prompt-tool` | `*/requestApproval` sunucu istekleri |
| cancel | `interrupt()` / SIGINT | `turn/interrupt` |
| usage | `result.usage`, `modelUsage` | `turn.completed.usage`, `thread/tokenUsage/updated` |
| kota | yok (yalnız hata) | `account/rateLimits/read` |
| session | `resume` / `session_id` | `thread/resume` / `thread.id` |
| auth durumu | `system/init.apiKeySource` | `account/read`, `account/updated.authMode` |

Tasarım etkisi: [orkestrasyon sözleşmeleri](../../design/orchestration-contracts.md) içindeki `ModelAdapter` (`discoverCapabilities`, `prepareRequest`, `stream`, `cancel`, `usage`, `health`) bu köprüler için yetersizdir; ayrı bir `AgentBackendAdapter` (tur bazlı) arayüzü gerekir. Bkz. [recommendation.md](./recommendation.md).
