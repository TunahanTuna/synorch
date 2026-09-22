# Referans: core ve store (I1)

> Durum: `implemented`, 2026-09-22. Sahip: I1. Kod: `src/harness/store/**`, `src/harness/core/**`. Sözleşmeler: [olaylar ve depolama](../contracts/events-and-storage.md), [kimlikler ve durum](../contracts/identity-and-state.md), [model adapter](../contracts/model-adapter.md), [tools](../contracts/tools.md). Kararlar: [ADR-02](../decisions/ADR-02-agent-loop-seams.md), [ADR-03](../decisions/ADR-03-session-store.md).

Bu belge I1'in **uyguladığı** davranışı anlatır. Sözleşmenin kendisi `src/harness/contracts/**` altındadır; burada yalnız implementasyon kararları, sınırlar ve tüketici modüllerin bilmesi gerekenler vardır.

## 1. Dışa açık fabrikalar

| Fabrika | Modül | Döndürdüğü |
| --- | --- | --- |
| `createSessionStore(home, options?)` | store | `SessionStore` (segmentli JSONL) |
| `createBlobStore(home)` | store | `BlobStore` (içerik adresli) |
| `createAgentDriver(deps)` | core | `AgentDriver` (sabit döngü) |
| `projectSession(items)` / `SessionProjector` | core | `SessionProjection` |
| `recoverSession(store, options?)` | core | `Promise<RecoveryReport>` |
| `rebuildModelRequest(event, blobs)` | core | Log'dan `ModelRequest` |
| `loadRecordedMessage(event, blobs)` | core | Satır içi veya blob `ModelMessage` |

`SessionStoreOptions` (hepsi opsiyonel): `clock`, `writerVersion` (varsayılan paket sürümü), `segmentMaxBytes` (varsayılan `SEGMENT_MAX_BYTES`), `lease.{ttlMs, heartbeatMs, pid, host}`. Üretimde varsayılanlar kullanılır; seçenekler deterministik test içindir.

`src/harness/core/testing.ts` yalnız test çiftlerini içerir (`ScriptedModelAdapter`, `ScriptedBackendAdapter`, `RecordingToolGateway`, `createLogContextBuilder`, `testPolicy`, `testRoute`); üretim kodu bunları kullanmaz. Diğer iş akışları kendi testlerinde kullanabilir.

## 2. Oturum deposu

### Yerleşim ve dosya biçimi

ADR-03 yerleşimi birebir uygulanır: `sessions/<project-id>/<session-id>/{session.json, lock.json, segments/NNNNNN.jsonl}` ve `blobs/sha256/<2>/<62>`. Dosyalar `0600`, dizinler `0700` ile oluşturulur (Windows'ta mod yok sayılır, kullanıcı profili ACL'i geçerlidir). Satır = `JSON.stringify(event) + "\n"`, yalnız LF, UTF-8, BOM yok. Okuyucu satırları **yalnız `0x0A` baytında** böler; `readline` kullanılmaz, U+2028/U+2029 metin içinde güvenle taşınır.

### Append

- `append` bir kuyruk üzerinden sıralanır; eşzamanlı çağrılar yoğun `seq` alır.
- Store `schema_version`, `event_id`, `session_id`, `seq`, `timestamp` alanlarını kendisi atar; taslakta bu alanlar olsa bile ezilir. Envelope `parseSessionEvent` ile doğrulanır; geçersiz veya daha yeni sürümlü taslak `write_failed` ile reddedilir ve `seq` tüketilmez.
- Satır `write` + `datasync` ile diske yazıldıktan sonra promise resolve olur.
- Tek satır üst sınırı `MAX_EVENT_LINE_BYTES` = 1 MiB. Bunun üstü reddedilir; büyük yükler blob'a yazılmalıdır (driver 16 KiB üstü mesajları zaten blob'a yazar).
- Yazma veya `fsync` hatası store'u **zehirler**: sonraki her `append` `write_failed` alır. Yarım kalmış olabilecek satır bir sonraki `openForWrite`'ta torn tail olarak karantinaya alınır.
- Rotasyon: mevcut segmentte en az bir olay varken yeni satır `segmentMaxBytes`'ı aşacaksa yeni segment açılır (`wx`, header + `datasync`, dizin `fsync`). Bir olay iki segmente bölünmez; tek olay sınırdan büyükse kendi segmentinde kalır.

### Okuma

`read(fromSeq?, toSeq?)` segment header'larından başlangıç segmentini seçer, sonra akış halinde (64 KiB parça) okur; bellek kullanımı en uzun satırla sınırlıdır. Doğrulananlar: segment numaralarının ardışıklığı, header'ın `session_id`/`segment`/`first_seq` sürekliliği, yoğun `seq`, olayın `session_id`'si. Bozuk satır `{status: "invalid"}`, bilinmeyen tip veya yeni sürüm `{status: "unsupported"}`, son segmentin son satırı yarım veya parse edilemiyorsa `{status: "torn-tail", segment, bytes}` olarak döner; hiçbiri sessizce atlanmaz. Yazıcının kendi `read`'i yalnız çağrı anındaki `lastSeq`'e kadar okur, dolayısıyla yazılmakta olan satırı görmez. Canlı bir oturumu başka süreçten okuyan `openForRead` son satırı geçici olarak torn tail görebilir.

### Torn tail ve bozulma

`openForWrite` önce lease'i alır, sonra oturumun kendi segmentlerini baştan sona doğrular:

- Ortada bozuk satır, `seq` boşluğu, yabancı `session_id` veya eksik segment → `session_corrupt`; dosyalara dokunulmaz.
- `unsupported` olay → `unsupported_version`; oturum yalnız `openForRead` ile açılır (AC-3).
- Torn tail → bayt aralığı önce `segments/<segment>.torn-<n>` dosyasına dayanıklı biçimde kopyalanır, sonra segment kesilir (`truncate` + `fsync`). Arada çökme yalnız çift karantina dosyası üretir, bayt kaybetmez. Header'ı yarım kalmış segment (rotasyon sırasında çökme) tamamen karantinaya alınıp silinir ve yazma önceki segmentte sürer.
- Karantina bilgisi `SegmentedEventStore.quarantinedTail` üzerinden sunulur; `recoverSession` bunu `RecoveryReport.tornTail` olarak raporlar.

### Lease

- `lock.json` `open(..., "wx")` (O_EXCL) ile oluşturulur; içerik `SessionLease` + 128 bit rastgele `token`.
- Heartbeat `LEASE_HEARTBEAT_MS` aralıkla (unref'li zamanlayıcı, meşgul döngü yok) token'ı doğrular ve `expires_at`'i uzatır. Yenileme temp + `fsync` + rename ile yazılır.
- Her `append` öncesi `lock.json` okunup token doğrulanır; süre bitmeye bir heartbeat aralığı kaldıysa önce yenilenir. Token başkasınınsa store zehirlenir ve `write_failed` ("taken over by pid … on …") döner.
- Canlı lease → `session_locked`, mesajda sahibin `pid`, `host` ve `expires_at` değeri bulunur (exit 8).
- Devralma: süresi dolmuş lease **veya** aynı host'ta süreci artık olmayan (`process.kill(pid, 0)` → `ESRCH`) lease devralınır. Devralma, eski dosyayı benzersiz bir ada rename ederek yapılır (tek kazanan); taşınan dosya incelenen lease değilse geri konur ve yeniden denenir.
- `close()` handle'ı kapatır ve lease hâlâ bizimse `lock.json`'u siler.

### Windows davranışı

Açık dosya üzerine rename `EPERM/EACCES/EBUSY` verebildiği için rename sınırlı üstel geri çekilmeyle (en fazla 8 deneme, toplam ~1,3 s) tekrarlanır. Windows'ta dizin açılamadığından dizin `fsync`'i atlanır (NTFS metadata günlüğü). `fsync` için `FileHandle.datasync()`/`sync()` kullanılır (Windows'ta `FlushFileBuffers`). Süreçler arası kilit ve çökme sonrası devralma testleri gerçek alt süreçle çalışır.

### Fork ve list

- `fork(id, upToSeq)` yeni `SessionId` ile `parent: {session_id, up_to_seq}` taşıyan manifest yazar; ilk segment `first_seq = up_to_seq + 1` ile başlar. Okuma önce atayı `up_to_seq`'e kadar (atanın torn tail'i hariç), sonra kendi segmentlerini verir. `upToSeq` atanın son `seq`'inden büyükse `write_failed`.
- `list(projectId)` her oturum için yalnız son segmenti okur (`lastSeq`, `lastEventAt`) ve lease'i inceler (`locked`). Sıralama `created_at`, sonra `session_id`.

## 3. Blob deposu

`put` baytların `sha256`'sını hesaplar; aynı içerik zaten varsa ve digest'i doğrulanıyorsa yazmaz, bozuk kopya varsa atomik olarak yeniden yazar. `get` dosyayı okur, digest'i yeniden hesaplar; uyuşmazlık `blob_digest_mismatch` fırlatır ve **hiç veri döndürmez** (AC-8). Eksik dosya veya biçimsiz digest `blob_missing`'dir (yol geçişi mümkün değildir). `media_type` diskte saklanmaz, yalnız `BlobRef`'te taşınır.

## 4. Projection

`SessionProjector.apply(item)` okuma öğelerini (veya çıplak olayları) sırayla uygular; `projectSession` bunun toplu biçimidir. Her `*_state_changed` geçişi `from`'un mevcut durumla eşleşmesi ve `validateTransition` ile doğrulanır. Türetilmiş geçişler:

| Olay | Etki |
| --- | --- |
| `run/created` | run `created` |
| `plan/proposed` | plan `proposed` (aynı `plan_id` yeni sürümle üzerine yazılır) |
| `task/created` | task `draft` |
| `attempt/started` | attempt `running` |
| `tool/call_proposed` | toolCall `proposed` |
| `tool/policy_decided` (`ask`) | toolCall → `awaiting_approval` |
| `tool/execution_started` | toolCall → `executing` |
| `tool/result_recorded` | toolCall → `data.state` |
| `tool/interrupted` | toolCall → `interrupted` |
| `approval/requested` | approval `pending` |
| `approval/decided` | `allowed-*` → `allowed`, diğerleri aynı adla; istek yoksa doğrudan oluşturulur (orchestrator oto-onayı) |
| `approval/invalidated` | approval → `invalidated` |
| `step/started` / `step/ended` | step `open` → `data.state` (açık turn şart) |
| `turn/started` / `turn/ended` | turn açılır/kapanır |

Tabloda olmayan geçiş, `from` uyuşmazlığı, bilinmeyen varlık, yinelenen oluşturma, `seq` boşluğu veya `invalid` öğe → `status: "corrupt"`; `unsupported` öğe → `status: "unsupported"`. Her iki durumda projection o noktada durur (`appliedSeq`), tahmin yürütmez ve `writable: false` olur. Yalnız torn tail oturumu yazılamaz yapmaz.

## 5. Crash recovery

`recoverSession(store)` log'u projekte eder; `corrupt` ise `session_corrupt`, `unsupported` ise `unsupported_version` fırlatır ve hiçbir şey yazmaz. Aksi halde önce `session/resumed {previous_last_seq, recovered[], torn_tail?}` (v2; `torn_tail` store'un `quarantinedTail`'inden) yazar, ardından kapanış olaylarını `causation_seq = resumed.seq` ile ekler:

| Açık varlık | Yazılan olay |
| --- | --- |
| toolCall `executing` / `awaiting_approval` | `tool/interrupted {outcome: unknown, idempotent}` (AC-4) |
| toolCall `proposed` (hiç çalışmadı) | `tool/result_recorded {state: cancelled}` |
| approval `pending` | `approval/decided {outcome: cancelled, decided_by: broker}` |
| step `open` | `step/ended {state: aborted}` |
| turn açık | `turn/ended {outcome: failed}` |
| attempt / task / run | `RECOVERY_STATE` hedefine geçiş tablo izin veriyorsa `*_state_changed` |

`idempotent` bayrağı `options.isIdempotent(toolName)` ile tool metadata'sından gelir; bilinmiyorsa `false`. Recovery hiçbir aracı yeniden çalıştırmaz; ikinci çağrı açık varlık bulmaz (idempotent).

## 6. Agent driver

`createAgentDriver({events, blobs, router, context, tools, gateway, credentials, backendEnv?})`. Her `runTurn`:

1. `turn/started`; varsa kullanıcı mesajı `message/recorded`.
2. Her step başında steer kuyruğu `steer/queued` olarak boşaltılır, sonra `step/started {step_id, turn_id, request_id}`.
3. `ContextBuilder.build` → istek `modelRequestSchema`, `request_id`, route ve `envelopeDigest = digestOf(request)` ile doğrulanır; canonical JSON olarak blob'a yazılır ve `model/request_prepared` kaydedilir. Böylece `envelope_blob.digest == envelope_digest` ve istek log'dan bayt bayt yeniden kurulur (AC-5, `rebuildModelRequest`).
3a. Context builder `budget-exceeded` ile reddederse istek hazırlanmaz: `step/ended {aborted}`, `turn/ended {budget_exceeded}`. Diğer retler step'i `errored`, turu `failed` bitirir.
4. `ModelAdapter`: `credentials(route, signal)` ile kimlik alınır, stream tüketilir. `oauth-subscription` route'unda ilk olay HTTP 401 hatasıysa kimlik bir kez `{forceRefresh: true}` ile yeniden çözülür ve aynı istek yeniden gönderilir. Her stream olayı şemayla doğrulanır; stream throw ederse, bozuk olay verirse veya `done`/`error` olmadan biterse `stream_interrupted`/`protocol_mismatch`.
5. Başarılı cevap: her `tool_call` parçasına yeni `ToolCallId` atanır, `message/recorded`, `model/response_settled`, usage varsa `provider/usage`.
6. Tool çağrıları **kaynak sırasıyla, sıralı** `ToolGateway.invoke` ile çalışır; her sonuç ayrı bir `message/recorded {role: tool}` olarak hemen kaydedilir. Gateway çağrısından sonra `events.lastSeq` ilerlememişse (kayıt yok) driver durur.
7. `stop_reason: length` ise mesajdaki tool çağrıları çalıştırılmaz, sentetik hata sonucu alır ve döngü devam eder.
8. Tool çağrısı yoksa turn `completed` (steer bekliyorsa bir step daha); `maxSteps` dolarsa `max_steps`.

İptal (AC-6): sinyal adapter'a, context builder'a ve gateway'e iletilir; ayrıca driver stream'i kendi tarafında da yarıştırır, adapter sinyali yok saysa bile beklemez. İptal edilen stream her zaman `model/response_failed {error.code: cancelled}` (kısmi içerik `partial_blob`) + `step/ended {aborted}` + `turn/ended {cancelled}` üretir; iptalden sonra gelen `done` bile `settled` sayılmaz. Tool batch'i sırasında iptalde kalan çağrılar çalıştırılmaz, sentetik "cancelled before execution" sonucu alır.

Append reddi (AC-7): driver'ın herhangi bir `append`'i reddedilirse (veya gateway kayıt bırakmazsa) yeni tool çağrısı ve yeni model isteği başlamaz; best-effort `turn/ended {failed}` denenir ve `StoreFailure` çağırana fırlatılır. `runTurn` yalnız bu durumda reject olur; sağlayıcı ve tool hataları `TurnOutcome` ile döner.

`AgentBackendAdapter` turları aynı olaylara kaydedilir: tek step, aynı `model/request_prepared` envelope'u, sistem blokları birleştirilerek `systemPrompt` olur. Driver bir `ToolBridge` üretir; köprü çağrıları (`mcp__synorch__` öneki soyulur) sıralı olarak aynı gateway yolundan geçer ve backend'in döndürdüğü `tool_call` parçaları köprüde atanan `ToolCallId` ile eşlenir; driver bunları **yeniden çalıştırmaz**. `ApprovalBridge` yalnız kayıtlı Synorch köprü araçlarına izin verir. `backend_init.tools` içinde öneksiz araç varsa `protocol_mismatch` ve `interrupt()`. Backend oturumu her turn sonunda kapatılır; sonraki turn `resumeBackendSessionId` ile devam eder.

## 7. Kabul ölçütleri ve testler

| AC | Test (dosya) |
| --- | --- |
| AC-1 | `AC-1 appended events read back…`, `AC-1 concurrent appends…`, `AC-1 a second writer in the same process…`, `AC-1 a second writer in another process…`, `AC-1 an expired lease is taken over…` (`harness-store-session`) |
| AC-2 | `AC-2 a half-written last line…`, `AC-2 a corrupt line in the middle…`, `AC-2 a seq gap or a foreign session id…`, `AC-2 a torn header…` (`harness-store-segments`) |
| AC-3 | `AC-3 an unknown event type makes the session read-only…`, `AC-3 a newer payload version…` (`harness-store-segments`) |
| AC-4 | `AC-4 a call that crashed after tool/execution_started…`, `AC-4 a driver crash mid-tool…` (`harness-core-recovery`) |
| AC-5 | `AC-5 every model request envelope is rebuilt byte for byte…`, `AC-5 a tampered envelope blob…` (`harness-core-driver`) |
| AC-6 | `AC-6 a cancelled stream ends with step aborted…`, `AC-6 a stream that still reports done after the abort…`, `AC-6 cancelling during a tool batch…` (`harness-core-driver`) |
| AC-7 | `AC-7 when recording the assistant message is rejected…`, `AC-7 when a tool result cannot be recorded…`, `AC-7 a gateway that leaves no durable record…` (`harness-core-driver`) |
| AC-8 | `AC-8 a blob whose bytes no longer match…`, `AC-8 a truncated blob…` (`harness-store-blob`) |

Çapraz platform: testler Windows 11 (Node 24) üzerinde yerelde geçti; `ubuntu-latest`/`macos-latest` CI matrisi henüz koşulmadı.

## 8. Bilinen sınırlar

- Tool çağrılarının `concurrency: parallel` metadata'sına rağmen driver v1'de hepsini sıralı çalıştırır.
- Aynı host'ta PID yeniden kullanımı, ölü bir yazıcının lease'inin TTL dolana kadar canlı görünmesine yol açabilir (güvenli yönde hata).

## 9. Sözleşme değişiklik istekleri (Dalga 2a sonucu)

| # | İstek | Karar |
| --- | --- | --- |
| 1 | `AgentDriverDependencies.credentials(route, signal)` | **Çözüldü:** zorunlu `credentials: CredentialResolver` (`(route, signal, options?: ResolveOptions)`); yerel opsiyonel bağımlılık kaldırıldı. Driver `oauth-subscription` route'unda ilk olaydan önceki 401'de bir kez `forceRefresh` ile yeniden çözer ve aynı isteği yeniden gönderir. |
| 2 | `session/resumed.data.torn_tail?` | **Çözüldü:** `session/resumed` v2 `torn_tail {segment, bytes}`; `EventStore.quarantinedTail?` sözleşmeye alındı, recovery'deki yapısal yoklama silindi. |
| 3 | `SessionProjection` ve `RecoveryReport` sözleşmeye | **Çözüldü:** `contracts/projection.ts` (tüm `Projected*`, `ProjectionIssue*`, `RecoveredEntity`); fabrikalar core'da. |
| 4 | `attempt/started` ⇒ `running` | **Çözüldü (belge):** [identity-and-state.md](../contracts/identity-and-state.md) ve [runtime-seams.md](../contracts/runtime-seams.md#3-projection-ve-recovery-core--cli-orchestration); ayrı `queued → running` olayı yazılmaz. |

Ayrıca: `ContextBuildInput.attemptId` driver'dan iletilir; `ContextBuildResult.reason: budget-exceeded` step'i `aborted`, turu `budget_exceeded` bitirir; `ContextBlockReport.source` enum olduğundan `model/request_prepared` cast'i kaldırıldı.
