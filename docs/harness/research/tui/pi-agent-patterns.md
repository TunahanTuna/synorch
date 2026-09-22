# pi ve OMP agent döngüsü: benimsenecek kalıplar

> Statü: araştırma; kalıp önerisi, uygulanmadı. İnceleme tarihi: 2026-09-22. Kaynaklar: [earendil-works/pi](https://github.com/earendil-works/pi) @ `27c072e98f613edb1da4bc6377d939b1c8e03fd1`, [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) @ `8cd6f8c619e89e935b6c6c5c91f6a4d20f6d7a75`. Dosya yolları aksi belirtilmedikçe pi deposuna görelidir.

Bu belge [runtime mimarisi](../../design/runtime-architecture.md), [oturum ve bağlam](../../design/session-and-context.md) ve [CLI deneyimi](../../design/cli-experience.md) tasarımlarına somut referans sağlar. Kod kopyalama izni değildir. Lisans MIT'tir, ama karar [kanıt kuralları](../sources.md) gereği ayrıca verilir.

**Paket kararı [çıkarım]:** `@earendil-works/pi-agent-core@0.87.0` ve `@earendil-works/pi-ai@0.87.0` bağımlılık olarak alınmaz. `pi-ai` dört büyük provider SDK'sını ve `typebox`'ı çeker. Synorch'un `zod` tabanlı şemaları, kendi policy/approval katmanı ve task ledger'ı var. Aşağıdaki kalıplar kendi `AgentDriver`/`ModelAdapter` arayüzlerimize uyarlanır.

## 1. Mesaj modeli

**[doğrulandı]** `packages/ai/src/types.ts`:

- LLM mesajları: `user`, `assistant`, `toolResult` (ve prompt/tool bildirimi taşıyan `system`).
- `AssistantMessage.content`: `(TextContent | ThinkingContent | ToolCall)[]`; ayrıca `api`, `provider`, `model`, `usage`, `stopReason`, `errorMessage`.
- `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.
- `ToolCall { type: "toolCall"; id; name; arguments: JsonObject }`.

**[doğrulandı]** `packages/agent/src/types.ts` (`AgentMessage`, satır ~370): `Message | CustomAgentMessages[keyof CustomAgentMessages]`. Uygulamaya özel mesajlar declaration merging ile eklenir. Model çağrısından önce `transformContext()` (opsiyonel budama/enjeksiyon) ve `convertToLlm()` (UI'ya özel mesajları süzme) çalışır.

**Synorch için:** Kalıcı event log'daki mesaj tipleri ile modele giden `Message[]` ayrı tutulmalı. `convertToLlm` karşılığı `ContextBuilder`'dır. Onay kartları, plan sürümleri ve worker durum mesajları UI'da görünür ama modele gitmez; bu, tasarımdaki "görüntülenen transkript ≠ model geçmişi" ilkesiyle birebir örtüşür.

## 2. Stream olay sözleşmesi

**[doğrulandı]** `AssistantMessageEvent` (`packages/ai/src/types.ts` ~652):

```text
start → (text_start → text_delta* → text_end
        | thinking_start → thinking_delta* → thinking_end
        | toolcall_start → toolcall_delta* → toolcall_end{toolCall})*
      → done{reason: stop|length|toolUse|deferred, message}
      | error{reason: error|aborted, error: AssistantMessage}
```

- Her olay kümülatif `partial: AssistantMessage` taşır. JSON/RPC çıktısında bu snapshot çıkarılır; yalnız delta ile sabit boyutlu alanlar kalır (`packages/coding-agent/src/modes/json-event.ts`, `toJsonEvent`).
- `packages/ai/README.md`: stream döndükten sonraki hatalar **throw etmez**; iptal dahil `error` olayı ve `stopReason` ile kodlanır. Kurulum hatası `start` olmadan tek `error` üretebilir.

**Benimse:** `ModelAdapter.stream()` asla throw etmeyen, `done | error` ile biten bir async iterator döndürsün. İptal `stopReason: "aborted"` ile, kısmi içerik korunarak kapansın. Bu tasarımdaki "iptal başarılı cevaba dönüştürülmez" kuralını tip düzeyinde garanti eder. Makine modunda kümülatif snapshot yazılmamalı.

## 3. Agent olayları ve tool çağrısı yaşam döngüsü

**[doğrulandı]** `AgentEvent` (`packages/agent/src/types.ts` ~485; OMP'de `packages/agent/src/types.ts` ~1131):

```text
agent_start
 turn_start
  message_start/end (user)
  message_start (assistant) → message_update* (yalnız assistant) → message_end
  tool_execution_start{toolCallId, toolName, args}
   tool_execution_update{partialResult}
  tool_execution_end{toolCallId, result, isError}
  message_start/end (toolResult)
 turn_end{message, toolResults}
 ...sonraki turn
agent_end{messages}
```

- OMP buna `tool_stream_update` ve `agent_end.telemetry` ekler. pi coding-agent ise `agent_settled` ile retry/compaction/queue sonrası "artık kendiliğinden devam etmeyecek" sinyalini verir (`packages/coding-agent/docs/rpc.md`).
- Çalıştırma sırası (`packages/agent/src/agent-loop.ts`): `prepareToolCall` (tool arama → argüman doğrulama → `beforeToolCall` hook'u; engelleyebilir) → `executePreparedToolCall` → `finalizeExecutedToolCall` (`afterToolCall` sonucu değiştirebilir) → `tool_execution_end` → toolResult mesajı.
- `parallel` modda preflight sıralı, yürütme eşzamanlı. `tool_execution_end` tamamlanma sırasıyla, toolResult mesajları ise **assistant kaynak sırasıyla** yayılır. Tool'da `executionMode: "sequential"` varsa bütün batch sıralı çalışır.
- Bilinmeyen tool, geçersiz argüman, engellenen çağrı ve iptal **hata sonuçlu toolResult** olur (`createErrorToolResult`); döngü çökmez. Tool hataları `throw` ile bildirilir, içerik metni olarak değil (agent README "Error Handling").
- `length` ile kesilen mesajdaki tamamlanmamış tool çağrıları sentetik hata sonucu alır (`failToolCallsFromTruncatedMessage`).
- `prepareRequest` her provider isteğinden hemen önce kanonik bağlamı kurar. `finishTurn` `turn_end`'den önce `continue | end` kararı verir.

**Benimse:**

| pi mekanizması | Synorch karşılığı |
| --- | --- |
| `beforeToolCall` | `ToolGateway` içindeki validate → `PolicyEngine` → `ApprovalBroker` zinciri. Hook değil, zorunlu kapı. |
| `afterToolCall` | Audit kaydı ve digest; sonucu değiştirme yetkisi dar tutulur. |
| Kaynak sırasıyla toolResult | Event log sırası deterministik olsun; replay aynı model girdisini üretsin. |
| Hatalı çağrıyı toolResult'a çevirme | Aynı; ayrıca `attempt` olayı olarak kaydet (tasarımdaki kural). |
| `prepareRequest` | `ContextBuilder`'ın her step başında log'dan yeniden kurulması. |
| `finishTurn` | Completion gate / review state kontrolü. |

## 4. İptal (abort)

**[doğrulandı]** `Agent.abort()` aktif run'ın `AbortController`'ını iptal eder (`packages/agent/src/agent.ts` ~338). Sinyal model stream'ine, `transformContext`'e, hook'lara ve `tool.execute(toolCallId, params, signal, onUpdate)`'e geçer. Döngü her tool sonrası `signal.aborted` kontrol eder ve kalan çağrıları `"Operation aborted"` hata sonucuyla kapatır. TUI, `message_end` gelince `stopReason === "aborted"` ise bekleyen tool kartlarını hata olarak işaretler (`packages/coding-agent/src/modes/interactive/interactive-mode.ts` ~3436).

**Tuş eşlemesi [doğrulandı]** (`packages/coding-agent/docs/keybindings.md`): `app.interrupt = escape` (iptal), `app.clear = ctrl+c` (ilk basış editörü temizler, ikincisi çıkar). Raw mode'da Ctrl+C SIGINT üretmez, `\x03` olarak gelir (Node `tty` belgesi).

**Synorch için:** [CLI deneyimi](../../design/cli-experience.md) "Ctrl+C önce etkin isteği iptal eder, ikinci kullanımda güvenli kapanış" diyor. pi'den farklı olarak Ctrl+C'yi iptale bağlamak Windows/cmd kullanıcı beklentisine daha yakın. Esc de iptal olarak eklenebilir. Bu karar ADR ile sabitlenmeli. Yan etkili tool çalışırken iptal: `signal` child process'e iletilir. Sonuç `interrupted` olarak kaydedilir ve otomatik tekrar edilmez.

## 5. Steering ve follow-up kuyrukları

**[doğrulandı]** `agent.steer(msg)` çalışan tool'lar bitince bir sonraki turn'e enjekte edilir. `agent.followUp(msg)` ajan normalde duracakken yeni turn başlatır. Mod `"one-at-a-time" | "all"` (agent README "Steering and Follow-up").

**Benimse:** Tasarımdaki "kullanıcı mesajı çalışma sürerken kuyruğa girip bir sonraki güvenli sınırda steer edebilir" kuralının hazır sözleşmesi. Güvenli sınır = tool batch'inin tamamlanması.

## 6. Oturum dosyası (JSONL ağaç)

**[doğrulandı]** `packages/coding-agent/docs/session-format.md`, `packages/coding-agent/src/core/session-manager.ts` (`CURRENT_SESSION_VERSION = 3`):

- Konum: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`.
- İlk satır `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}`; ağacın parçası değil.
- Diğer her satır `{type, id (8 hex), parentId | null, timestamp (ISO)}` taşır. Tipler: `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
- Branch yeni dosya açmaz. Aktif yaprak (`leafId`) üzerinden köke yürünerek yol kurulur (`buildSessionPath`, `buildContextEntries`, `buildSessionProjection`).
- Prompt ve tool seti ayrı state değildir. `system` mesajları `sections` yamalarıyla ve `toolsAdded`/`toolsRemoved` ile replay edilir.
- `context_edit` hedef mesajı ham geçmişte değiştirmeden gelecekteki model bağlamından çıkarır veya değiştirir; branch'e görelidir.
- Eski sürümler yüklemede otomatik migrate edilir (v1 doğrusal → v2 ağaç → v3).
- OMP de aynı modeli kullanır ([OMP session.md](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)).

**Benimse:** header + `id/parentId` + append-only + sürüm alanı + yüklemede migrate. Synorch farkları [çıkarım]:

- Tek yazıcı: pi `proper-lockfile` bağımlılığı taşıyor. Synorch'ta lock/lease sonucu kullanıcıya açık bildirilmeli ([runtime mimarisi](../../design/runtime-architecture.md)).
- `seq` alanı ve `schema_version` makine modu frame'leriyle hizalı olsun.
- Görev/worker/onay olayları `custom` değil, birinci sınıf tipler olsun (`task_state`, `approval_decision`, `evidence`).
- Büyük tool çıktıları satır içine değil, digest'li blob referansıyla yazılsın.

## 7. Compaction

**[doğrulandı]** `packages/coding-agent/docs/compaction.md`:

- Tetik: `contextTokens > contextWindow - reserveTokens` (varsayılan `reserveTokens` 16384) veya `/compact [talimat]`. Tool sonuçları eklendikten sonra, bir sonraki assistant cevabından önce kontrol edilir. Context overflow hatası veya erken `length` bir kez compact-and-retry tetikleyebilir.
- Kesim: sondan geriye `keepRecentTokens` (varsayılan 20k) birikene kadar yürünür. Öncesi LLM ile yapılandırılmış biçimde özetlenir (önceki özet iteratif bağlam olarak verilir).
- Kayıt: `{"type":"compaction","summary","firstKeptEntryId","tokensBefore","systemMessage?","details?{readFiles,modifiedFiles}"}`. Model artık `system + summary + firstKeptEntryId'den sonrası`nı görür, ham geçmiş silinmez.
- `branch_summary`: `/tree` ile dal değiştirirken terk edilen dalın özeti.

**Benimse:** Tek yöntem, kalıcı `firstKeptEntryId`, özetin kaynağı/kullanımı ve dosya listesi. Bu, [OMP incelemesindeki](../oh-my-pi.md) "ilk sürümde tek, test edilebilir compaction" önerisiyle tutarlı.

## 8. TUI'nin agent olaylarına abone olması

**[doğrulandı]** `packages/coding-agent/src/modes/interactive/interactive-mode.ts`:

- `subscribeToAgent()` (~3278) → `session.subscribe(async (event) => handleEvent(event))`. `Agent.subscribe` dinleyicileri kayıt sırasıyla **await edilir**.
- `message_start` (assistant) → streaming bileşeni oluştur. `message_update` → `updateContent(partial)`, ilk kez görülen `toolCall` için `ToolExecutionComponent` ekle, `ui.requestRender()`.
- `tool_execution_start/update/end` → `pendingTools: Map<toolCallId, component>` üzerinden kartı güncelle.
- `message_end` → aborted/error ise bekleyen kartları hata yap. `agent_end` → durum göstergesini temizle.
- Her olay yalnız bileşen state'ini değiştirir ve `requestRender()` çağırır. Render birleştirme ve throttle TUI'dedir (16 ms). Olay sayısı frame sayısını belirlemez.

**Benimse:**

1. Renderer yalnız olay tüketicisidir. `PiTuiRenderer`, `PlainLineRenderer` ve `JsonlRenderer` aynı olay akışına abone olur ([TUI önerisi](./README.md#4-adr-04-önerisi)).
2. Olay dinleyicileri await edildiği için yavaş renderer ajanı yavaşlatabilir. Synorch'ta UI aboneliği **await edilmeyen**, sınırlı kuyruklu bir kanal olmalı; kalıcı event store ise await edilen tek yazıcıdır [çıkarım].
3. `toolCallId → bileşen` eşlemesi, stream sırasında argümanı henüz tamamlanmamış çağrıyı gösterip execution başlayınca aynı kartı sürdürür.

## 9. Makine modları ve non-TTY

**[doğrulandı]**

- `resolveAppMode()` (`packages/coding-agent/src/main.ts` ~111): `--mode rpc` → rpc, `--mode json` → json, `--print` **veya stdin/stdout TTY değilse** → print, aksi halde interactive.
- JSON modu (`packages/coding-agent/docs/json.md`): katı JSONL, yalnız LF ile ayır. **Node `readline` uygun değil** çünkü U+2028/U+2029'u da satır sonu sayıyor. Stdout yalnız JSONL, loglar stderr'e. Okuyucu durursa pipe dolup süreç tıkanabilir.
- `takeOverStdout()` (`packages/coding-agent/src/core/output-guard.ts`): makine modunda `process.stdout.write`'ı stderr'e yönlendirip ham stdout'u protokole ayırır. `ENOBUFS/EAGAIN`'de yeniden dener.
- JSON ve RPC ayrı modlardır. RPC çift yönlüdür ve header satırı yazmaz.

**Benimse:** [CLI deneyimi](../../design/cli-experience.md)'ndeki "JSONL ile RPC aynı sözleşmeye sıkıştırılmamalı" kararı pi'de de böyle. Ek olarak stdout koruması, LF-only framing (Synorch okuyucuları ve testleri `readline` kullanmamalı) ve TTY yoksa otomatik düz mod.

## 10. Benimsenmeyecekler

- `pi-ai` üzerinden provider SDK'larını topluca almak. Synorch provider adapter'ları kendi capability testleriyle eklenir.
- OMP'nin `speculative-execution`, `snapcompact`, Rust native araçları. MVP dışı.
- Hook'ların (`beforeToolCall`) policy yerine geçmesi. Synorch'ta policy/approval zorunlu kapıdır, opsiyonel callback değil.
