# ADR-18: Harness'in hesapladığı kanıt, toleranslı çözümleme ve model dostu düzenleme araçları

## Status

Accepted. Kısmen değiştirir (Supersedes, kısmen): [ADR-09](./ADR-09-reviewer-independence.md) — `met` hükmünün kanıt kuralı. Bağımsız inceleme 4 (R1, R2, R4) ile 2026-09-23'te daraltıldı: `harness-diff` yalnız destekleyicidir; bağımsız ve ikame edici harness kanıtı yalnız kanıtlayan (`passed`, build/test sınıfı veya ölçütün aynen andığı, salt okunur olmayan) doğrulama çalıştırmasıdır; harness doğrulaması gateway üzerinden sistem çağrısı olarak koşar.

## Date

2026-09-23

## Context

Gerçek modellerle yapılan iki canlı çalıştırma (`syn-smoke`, run_01M35SSARRMK87VYMT770BNM3X ve run_01M35VYXAC79ST06QZBAFGWT1S) doğru işi teslim edemeden başarısız oldu. Denetim A (model biçimi kırılganlığı) nedenleri kayıtlardan çıkardı:

- Kanıt işaretçileri harness `ToolCallId`'si (`call_01M…`) olmak zorundaydı, ama model bu kimliği hiç görmez: adapter'lar yalnız `provider_call_id` gönderir, tool sonucu metninde kimlik yoktur (F1). Beş gerçek `task_report` çağrısının hiçbiri geçerli kimlik kullanmadı; `functions.exec node check.mjs: exit code 0`, `src-add.mjs:1-3 — …` gibi yazdı. Başarısızlık oranı %100.
- Rapor araçları kanıtı çözmeden "report recorded; end your turn now" dedi; sorun tur bittikten sonra coordinator'da ortaya çıktı, düzeltme şansı olmadı (F2).
- Yalnız kanıt eksik olan `revise`, başarısız attempt gibi ele alındı: çalışma alanı geri alındı, triyajla paylaşılan tek retry bütçesi (`maxRetries: 1`) tükendi ve **doğru artifact hiç review edilmeden** run başarısız oldu (F3). Triyaj istemi yalnız listelenmiş (çözülmemiş) işaretçiyi "[evidenced]" gösterdi (F10).
- Doğrulama komutları yalnız modelin iddiasıyla ve tam metin eşleşmesiyle denetlendi; model yazdığı çıkış kodu doğru kabul edildi (F7). `file` kanıtı yalnız çıplak yol kabul etti (F8). Reviewer aynı kimlik sorununa yapısal olarak açıktı ve çözülmeyen tek işaretçi review'ü `invalid` yapıyordu (F9).
- `apply_patch` yalnız sayılı `@@ -a,b +c,d @@` unified diff kabul etti; GPT modelleri iki attempt'te de `*** Begin Patch` biçimini kullandı (F6). `read_file` digest döndürmedi, model yazma önkoşulunu paketten veya hata metninden kopyaladı (F5). `write_file` CRLF dosyayı LF'e çevirdi (F17, Denetim B B6); `apply_patch` karışık EOL'u tek tipe çevirdi, BOM'lu dosyada eşleşmedi (B5) ve cp1254 dosyada dokunulmamış baytı `EF BF BD` yaptı (B4, sessiz bozulma).

İlke: **harness doğruyu hesaplar, model anlatıyı verir**; çözümleme toleranslıdır ve model kendini düzeltmek için bir tur alır.

## Decision

**D1 — Harness'in hesapladığı kanıt ve toleranslı çözümleme**

- Worker turu bittikten sonra harness paketin `verification.commands` listesini attempt çalışma alanında kendisi koşar ve her komut için `attempt/verification_ran` olayı yazar. Her çalıştırma **tool gateway üzerinden bir sistem çağrısıdır** (`ToolInvocationScope.actor: system`; review R4): `exec` normalizasyonu, argümanda kimlik bilgisi denetimi, policy (`verification_commands` allowlist'i, workspace trust, bağımlılık bağlantısı kuralı), sandbox, redaksiyon ve `tool/*` denetim olayları worker'ın `exec`'iyle aynıdır; olaylar attempt session'ına `actor.kind: system` ile yazılır, kısa ref almaz, onay asla sorulmaz (`ask` → `not-run`) ve attempt günlüğü bu çağrıları modelin kanıtı saymaz. Harness komutu sınıflar (`command_class`: `build-test | read-only | other`, `classifyVerificationCommand`). Sonuçlar completion'da `harness_evidence.verification[]` olur: `kind: harness-verification`, `produced_by: harness`, `ref: <session_id>#<seq>`. Değişiklik varsa sabitlenmiş diff `harness_evidence.diff` olur (`kind: harness-diff`, `ref` = `artifact_digest`). `harness-*` türlerini yalnız harness üretir, harness başka tür üretmez (şema uygular). `commands_run` modelin iddiasından değil attempt günlüğündeki `exec` çağrılarından kurulur.
- Modele gösterilen her tool sonucu `[#n] ` ile başlar (`renderToolResultText`); `n` attempt içi 1'den başlayan çağrı sırasıdır, gateway atar ve `tool/call_proposed.ref` (v2) olarak kaydeder; `#n` tam bir `ToolCallId`'ye eşlenir.
- İşaretçi çözümü toleranslıdır ve sırası sabittir: harness `ToolCallId` → `#n` → provider call id → araç adı + argüman örtüşmesi (`functions.`/`mcp__synorch__` öneki atılır) → ilk yol benzeri sözcük. Her çözüm yöntemiyle birlikte `evidence_resolution[]` içinde kaydedilir (`EVIDENCE_RESOLUTION_METHODS`).
- `task_report` ve `review_report` kanıtı **araç çağrısının içinde** çözer. Çözülmeyen işaretçide `invalid_arguments` döner; metin her sorunu ve geçerli `#n` listesini verir (`formatEvidenceCorrection`). Aynı session'da **bir** düzeltme turu vardır (`REPORT_CORRECTION_ROUNDS = 1`); ikinci ret de kayda geçer ve rapor olduğu gibi kabul edilir. `plan_propose` ve `task_triage` kendi girdi doğrulamasını aynı biçimde (eyleme dönük `invalid_arguments`) yapar.
- **Kanıtlayan çalıştırma** (`verificationProves`, review R1/R2): `passed` ve ya `build-test` sınıfı (vetted build/test listesi, kurulum komutları hariç) ya da ölçüt ifadesinin aynen andığı komut. Salt okunur listedeki komutlar (git status/diff/log/show, listeleme, görüntüleme, arama) her zaman geçer ve hiçbir şey kanıtlamaz; asla sayılmaz.
- Model işaretçileri düzeltme turundan sonra da çözülmezse, harness doğrulamasının bütün komutları `passed` ise, **en az biri kanıtlayan bir çalıştırmaysa** ve yazan görevde diff kapsam içindeyse, ölçüt harness kanıtıyla kanıtlanır (`method: harness-substitute`; kanıtlayan kayıtlar + diff); reviewer bunu paketinde görür. Plan model çıktısıdır: salt okunur, boş bir doğrulama komutu trivial görevi kanıtsız kabul ettiremez (review R2).
- Reviewer aynı mekanizmayı kullanır. Düzeltmeden sonra çözülmeyen reviewer işaretçisi review'ü `invalid` yapmaz: işaretçi düşer (kayıtlı), bağımsız kanıtı kalmayan `met` hükmü harness tarafından `unverifiable`'a düşürülür (`note`'ta gerekçe) ve `accept` `revise` geri bildirimine çevrilir. `invalid` yalnız bağ ihlallerinde (başka görev/attempt/artifact/completion) kalır.
- **ADR-09 değişikliği (review R1 ile daraltılmış):** `met` hükmü reviewer'ın kendi çözülen araç kanıtına **veya o ölçütü kanıtlayan bir harness doğrulama çalıştırmasına** dayanır. `harness-diff` yalnız destekleyicidir, tek başına asla yetmez: diff yalnız bir değişikliğin var olduğunu gösterir ve incelenen şeyin kendisidir. Böylece `verification.commands` boş olan standard/high-risk bir görev, kimse bir şey çalıştırmadan kabul edilemez: reviewer kanıtı kendisi üretir, yalnız diff'e dayanan `met` → `unverifiable` → `revise`. Worker kanıtı tek başına yine yetmez.
- Triyaj istemi ölçütleri `resolveEvidence` sonrası `[resolved] / [unresolved: neden] / [missing]` olarak gösterir.

**D2 — Doğru iş atılmaz**

- Yalnız kanıt eksik olan `revise` (`evidence-repair`) ve başarısız harness doğrulaması (`verification-repair`) **aynı attempt session'ında**, çalışma alanı ve artifact korunarak onarılır; her tur `attempt/repair_requested` olayıyla kaydedilir.
- Bütçeler görev başına ve ayrıdır (`orchestrationBudgetsSchema`): `triage_retries` (yeni attempt; varsayılan 1), `evidence_repairs` (session içi onarım, iki onarım türü paylaşır; varsayılan 2), `review_revisions` (review sonrası revizyon; varsayılan 2). Bir bütçe tükenince görev kendiliğinden `failed` olmaz; orchestrator `task_triage` ile danışılır.

**D3 — Model dostu düzenleme araçları**

- `read_file` attempt çalışma alanındaki ham baytların digest'ini (`workspaceDigest`, ADR-19) başlık satırında ve `ToolResult.digest`'te döndürür.
- `write_file`/`apply_patch` için `expected_digest` verilmezse bu attempt'te o yolun son okunan/yazılan digest'i kullanılır (`AttemptFileLedger`); yazma defteri günceller, ardışık düzenlemeler yeniden okuma gerektirmez. Bilinmeyen yol için açık digest gerekir. `stale_precondition` güncel digest'i ve "re-read and retry" der.
- `apply_patch` unified diff'e ek olarak `*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` biçimini ve satır sayısız `@@` başlıklarını (hunk bağlamdan bulunur) kabul eder; hata mesajı kabul edilen biçimleri ve kısa bir örneği içerir.
- EOL satır başına, BOM dosya başına korunur; `write_file` var olan tek tip EOL'u korur. Geçerli UTF-8 olmayan dosya `invalid_arguments` ile reddedilir (`TextDecoder` `fatal: true`); asla sessizce bozulmaz.

## Alternatives

- **Modele harness `ToolCallId`'sini göstermek:** 30 karakterlik ULID'leri doğru kopyalamak modeller için hataya açık ve bağlamı büyütür; `#n` kısa, sıralı ve bağlamda zaten görünür. Reddedildi; tam kimlik yine de ilk çözüm yöntemi olarak kabul edilir.
- **Kanıt işaretçilerini tamamen kaldırmak, yalnız harness kanıtı:** Açıklayıcı olmayan ölçütlerde (ör. "API değişmedi") harness kanıtı ölçütle eşleşmez; modelin eşlemesi anlatı olarak değerlidir. Reddedildi; işaretçi korunur, harness kanıtı yedektir.
- **Sınırsız düzeltme turu:** Bozuk bir model sonsuz döngüye girer ve maliyet artar. Reddedildi; tek tur + session içi onarım bütçesi.
- **Başarısız kanıtta yeni attempt (mevcut davranış):** Doğru işi geri alır ve bütçeyi tüketir (F3). Reddedildi.
- **Reviewer'da harness kanıtını bağımsız saymamak:** Her `met` için reviewer'ın doğrulama komutunu yeniden koşmasını ister; harness zaten koşmuş ve kaydetmiştir. Reddedildi; reviewer'ın kendi kanıtı hâlâ kabul edilir ve tercih edilir.
- **Sabitlenmiş diff'i bağımsız kanıt saymak (ilk ADR-18 metni):** Diff incelenen değişikliğin kendisidir; doğrulama komutu yoksa görev hiçbir şey çalıştırılmadan kabule ulaşır (bağımsız inceleme 4, R1). Reddedildi; diff destekleyici kalır.
- **Her `passed` doğrulama komutunu ikame için saymak:** Salt okunur komutlar güvenilmeyen çalışma alanında bile koşar ve hep geçer; plan prompt-injection'a açıktır (R2). Reddedildi; yalnız build/test sınıfı veya ölçütün andığı komut sayılır.
- **Harness doğrulamasını gateway dışında koşmak (ilk uygulama):** Policy ve sandbox uygulanıyordu ama argümanda kimlik bilgisi denetimi ve `tool/*` denetim izi yoktu (R4). Reddedildi; sistem çağrısı olarak gateway'den geçer.

## Consequences

- Kanıt sözleşmesi model davranışına karşı dayanıklıdır; ikinci live run'daki üç işaretçi (`functions.read_file src-add.mjs …`, `functions.git_diff …`, `functions.exec node check.mjs …`) `tool-name-args`/`path-token` ile çözülür.
- Harness doğrulama komutlarını bir kez daha koşar: süre maliyeti komut süresi kadardır; worker aynı komutu koşmuşsa sonuç yine harness'inkidir.
- Completion ve review paketleri daha zengin kayıt taşır (`harness_evidence`, `evidence_resolution`, `repairs`); alanlar opsiyonel olduğu için eski paketler geçerli kalır.
- Rapor araçları artık callback ister (orchestration sağlar, composition root bağlar); callback yoksa eski "acknowledge" davranışı sürer.
- Terminal rapor başarılı olunca tur biter (ADR-20); düzeltme turu ise aynı turda kalır.

## Evidence

- Denetim A (`audit-a.md`, harness @ 7b9ebcf): §0 run 2 akışı; F1, F2, F3, F5, F6, F7, F8, F9, F10, F14, F17; §2 "model ne görüyor / doğrulayıcı ne istiyor"; §3 doğrulama akışı.
- Denetim B (`audit-b.md`): B4 (cp1254 bozulması, `s2.mjs` E), B5 (karışık EOL, CR, BOM), B6 (CRLF üstüne LF yazma).
- Sözleşme: `src/harness/contracts/evidence.ts` (`renderToolResultText`, `parseToolRef`, `EVIDENCE_RESOLUTION_METHODS`, `TOOL_EVIDENCE_RESOLUTION_ORDER`, `evidenceResolutionSchema`, `harnessVerificationSchema`, `harnessEvidenceSchema`, `REPAIR_KINDS`, `REPORT_CORRECTION_ROUNDS`, `orchestrationBudgetsSchema`, `formatEvidenceCorrection`), `common.ts` (`HARNESS_EVIDENCE_KINDS`, `evidenceRefSchema`), `packets.ts` (completion/review ek alanları, bağımsız reviewer kanıtı), `events.ts` (`attempt/verification_ran`, `attempt/repair_requested`, `tool/call_proposed` v2, `tool/result_recorded` v2), `tools.ts` (`AttemptFileLedger`, `ToolCallOutcome.ref`, `ToolResult.digest`).
- Belgeler: [task-packets §8](../contracts/task-packets.md#8-harness-kanıtı-çözümleme-ve-onarım-adr-18), [tools §3](../contracts/tools.md), [runtime-seams §7–§9](../contracts/runtime-seams.md).

## Verification

- Bağımsız inceleme 4: `tests/harness-orchestration-review.test.ts` (boş doğrulama + yalnız `harness-diff` → `revise`; `verifyReview` sınıfları), `tests/harness-orchestration-evidence.test.ts` (salt okunur doğrulama ikame etmez; `classifyVerificationCommand`), `tests/harness-tools-gateway.test.ts` ve `tests/harness-e2e-dependency-links.test.ts` (sistem çağrısı: kimlik bilgisi denetimi, `tool/*` izi, ref yok, onay yok).
- `tests/harness-contracts.test.ts`: `[#n]` render ve `#n` ayrıştırma, çözüm sırası, düzeltme metni; `harness-*` üretici kuralı; completion'da kayıtsız harness işaretçisinin reddi; bütçe varsayılanları; yeni olayların sürümleri ve reddedilen biçimleri (çıkış 1 ile `passed`, bütçeyi aşan tur, `ref` taşıyan v1 çağrı); reviewer'ın harness kanıtıyla `met` örneği.
- W1a/W1c kabul ölçütleri ([uygulama planı §7](../implementation-plan.md#7-canlı-çalıştırma-sağlamlaştırma-dalgası)); W2: sloppy-model scripted adapter ve iki canlı transkriptin replay'i — ikinci run'ın transkripti düzeltme turu olmadan da `completed` + review'e ulaşmalı.

## Revisit trigger

Toleranslı çözümün yanlış çağrıya eşlediği (yanlış pozitif) bir vaka; harness doğrulamasının maliyetinin görev süresine oranla kabul edilemez olması; modellerin `#n` yerine başka bir kalıbı ısrarla kullanması.
