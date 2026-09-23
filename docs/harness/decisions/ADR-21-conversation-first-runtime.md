# ADR-21: Konuşma öncelikli runtime — ana ajan döngüsü, kabiliyet olarak orkestrasyon

## Status

Proposed — ürün sahibinin dikey dilim onayıyla `Accepted` olur ([ürün gereksinimleri §9](../foundation/product-requirements.md#9-ilk-dikey-dilim-onay-kapısı)). Kısmen değiştirir: ADR-02 (tetikleyici modeli), ADR-08 (doğrudan yazan rol, orkestrasyon başlatma onayı), ADR-09 (doğrudan düzenlemeler zorunlu review'dan geçmez), ADR-15 (`syn run` eşlemesi). ADR-07, ADR-18, ADR-19 ve orkestrasyon içindeki ADR-09 aynen geçerlidir. Ekran tarafı: [TUI deneyimi](../design/tui-experience.md) (R0 bu ADR'dir).

## Date

2026-09-23

## Context

Ürün tanımı ([product-requirements.md](../foundation/product-requirements.md), bağlayıcı): Synorch harness Claude Code gibi kullanılan konuşma öncelikli bir kodlama ajanıdır. Her mesaj hemen stream edilen bir cevap alır; kullanıcı soru sorar, birlikte plan yapar, ajana doğrudan okutur/düzenletir/komut çalıştırtır; oturumlar uzun sürer. Orkestrasyon Synorch'un farkı olarak kalır ama iş gerektirdiğinde çağrılan bir **kabiliyettir**.

Bugünkü kod bunun tersini uygular:

- `syn agent`/`syn run` her mesajı `coordinator.run({goal})`'a verir (`src/harness/cli/session.ts`); coordinator her run'da policy snapshot'ı, route kararı ve zorunlu planlama turu yapar (`coordinator.ts` ~L320–470).
- Orchestrator rolünün tavanı `exec: deny`, yazma yalnız `.ai/tasks/**` (`ROLE_EFFECT_CEILINGS`, `effectivePolicySchema` refine). Doğrudan düzenleme mümkün değil.
- İlk mesajdan sonra güven sorusu (`promptWorkspaceTrust`) cevabı geciktirir; açılışta senkron kurulum var (`createRuntime`).
- Konuşma geçmişi yok: her mesaj ayrı bir hedef.

[harness-context.yaml](../harness-context.yaml) (ürün sahibinin tasarım bağlamı) bu çatışmayı açıkça adlandırır: `product_modes.direct.decision_gate` "ana ajanın ürün dosyası yazması ADR-08/09 güncellemesi ister" der ve `agent_instructions` "kabul edilmiş ADR-08/09 davranışını konuşma öncelikli öneriyle sessizce değiştirme" der. Açık kararlar HD-01 (ana ajan doğrudan yazabilir mi), HD-02 (her tur bir run mı), HD-04 (review'suz doğrudan değişiklik nasıl etiketlenir) bu ADR'de kapanır; HD-03 (host başına OS sandbox) ADR-06'da açık kalır. Yetki sırası (`reading_contract.authority_order`): en güncel açık kullanıcı kararı > kabul edilmiş ADR'ler. Ürün sahibinin konuşma öncelikli tanımı en güncel açık karardır; bu ADR onu ADR-08/09'a **açık bir delta** olarak işler (aşağıda "ADR-08/09 ile uzlaşma").

Korunması gerekenler: tek gateway hattı ve hard rail'ler (ADR-08), append-only log ve replay (ADR-03), orkestrasyonda bağımsız review ve kanıt (ADR-09/18), abonelik kimlikleri (ADR-05), hafıza (ADR-16/17), kanonik `.ai/` yüklemesi, legacy komutlar (ADR-01). Pi/OMP ve Claude Code aynı modeli gösterir: tek, uzun ömürlü ajan döngüsü; alt ajanlar ve plan modu onun araçlarıdır ([pi-agent-patterns.md](../research/tui/pi-agent-patterns.md), [claude-code.md](../research/claude-code.md), [UX araştırması](../research/ux/README.md)).

## Decision

### D1 — Ana ajan ve yeni `session` rolü

- Etkileşimli oturumun tek muhatabı **ana ajandır** (UI'da "Synorch"). Mevcut `AgentDriver` aynen kullanılır; her kullanıcı mesajı `trigger: "user"` ile bir `runTurn` açar. Yeni döngü yazılmaz.
- Yeni rol `session` (`AGENT_ROLES`'a eklenir; worker ve salt okuma rolü değildir). Orchestrator rolü **değişmez**: planner turu, triyaj ve steer danışması için coordinator içinde kalır ve ürün dosyası yazmaz (HREQ-002).
- Route: `{tier: "orchestrator", role: "session"}`; kullanıcı `role: session` kuralıyla ayrı model seçebilir, yoksa orchestrator tier route'u kullanılır. Yeni tier yok.
- **Tur ve run (HD-02):** Her kullanıcı mesajı bir **turdur** ve oturumda yaşar. **Run yalnız orkestrasyonla açılır** (`syn runs`/`syn show` yalnız run'ları listeler). Bunun için `run_id` ana ajan turlarında yoktur: `TurnInput.runId`, `ContextBuildInput.runId`, `ToolExecutionContext.runId`, `EffectivePolicy.run_id` opsiyonel olur (orchestrator/worker için yine zorunlu, şema refine'ı rolle bağlar); korelasyon `turn_id` ile yapılır. Bütçe kapısı ana ajan turlarında oturum kapsamlı çalışır.
- Aktör: ana ajanın olayları `actor: {kind: "agent", role: "session"}` (`ACTOR_KINDS`'a `agent`). History filtresi (`context/history.ts belongsTo`) `session`'a yalnız kendi mesajlarını, kullanıcı mesajlarını ve orkestrasyon sonuç özetlerini verir; orchestrator/worker olayları modele gitmez.
- UI metinleri şimdilik İngilizce; model kullanıcının dilinde cevap verir (harness talimatı). Yerelleştirme sonra.

### D2 — Araç seti

Oturum boyunca kararlı liste (önbellek, ADR-20):

| Grup | Araçlar | Değişiklik |
| --- | --- | --- |
| Okuma | `read_file`, `search`, `list_dir`, `git_status`, `git_diff` | Yok (`visible_to` zaten tüm roller) |
| Düzenleme | `apply_patch`, `write_file` | `visible_to`'ya `session` |
| Komut | `exec` | `visible_to`'ya `session` |
| Etkileşim | `ask_user`, `load_skill`, `memory_propose` | `ask_user` `session`'a açılır |
| Plan | `plan_propose` | `session`'a açılır; ana ajan için terminal değil, plan bloğu olarak gösterilir |
| Delegasyon | `orchestrate` (UI: "workers", `/workers`) | **Yeni** kontrol aracı, yalnız `session` |

- `orchestrate({plan_ref} | {goal, brief})`: gösterilmiş planı (`plan_ref` = son `plan/proposed`) veya bir hedefi coordinator'a verir; hedef verilirse mevcut planner planlar ve plan önce gösterilir (D4). Araç **run bitene kadar turun içinde sürer** (Claude Code alt ajanları gibi); sonuç aracın dönüşüdür ve ana ajan aynı turda kullanıcıya raporlar. Run durumu için ayrı `run_status`/`run_steer` aracı gerekmez: run sürerken ekranda pano vardır, kullanıcının yazdığı mesaj steer olarak coordinator'a gider (D8).
- **Plan modu** (`/plan <hedef>`, `Shift+Tab`) araç değil policy daraltmasıdır: `workspace-write` ve `exec` `deny` (neden `plan-mode`); ana ajan okur, tartışır, `plan_propose` ile plan bloğu üretir. Kullanıcı seçer: *Workers ile çalıştır* (`orchestrate`) / *Burada doğrudan yap* (mod kapanır) / *Planlamaya devam*. Mod değişimi tek bir önbellek kaçırmasına mal olur. Bugünkü `/plan` çıktısı `/tasks`'a taşınır.
- `/review`: çalışma ağacının diff'ini mevcut `dispatchReview` yoluyla bağımsız reviewer'a gönderir (isteğe bağlı; K3).

### D3 — Doğrudan mod yetkisi

`ROLE_EFFECT_CEILINGS.session = {read, workspace-write, exec, external-write, control: allow}`; sonra mevcut kesişim (mod, config, sandbox, güven, onay) uygulanır.

- **Yazma kapsamı:** `write_scope = ["**"]` yalnız `session` için; `effectivePolicySchema`'daki whole-workspace yasağı bu rol için istisnalanır. Ayrılmış yollar (`.git`, `.synorch`) ve policy kaynakları (rol manifestleri, çalışma alanı config'i; `policy-self-modification`) istisnasız reddedilir. `forbidden` kullanıcı/çalışma alanı config'inden gelir.
- **Exec:** mevcut `exec_confinement` aynen (tam sandbox → yıkıcı olmayan her komut; `policy-only` + `autonomous` → allowlist + güven; `ask` → sorulur). Yıkıcı komut tablosu ve rail'ler değişmez.
- **Git:** salt okuma serbest; geçmiş/index değiştiren komutlar (`commit`, `add`, `stash`, `reset`, `checkout`, `rebase`, `merge`, `switch`, `restore`, `tag`, `push` …) v1'de reddedilir (worker kuralı `session`'a da uygulanır).
- **Güven (UX-GATE-01 kararı):** soru **ilk ihtiyaç anında** sorulur: güvenilmeyen çalışma alanında depo kodu çalıştıran ilk exec'te gateway `workspace-untrusted` ile durur, etkileşimli oturumda mevcut güven istemi o anda bir kez gösterilir ("Not now / This session / Always"), cevap kaydedilir (`trust/granted`) ve aynı çağrı yeniden değerlendirilir. Açılışta ve selam/okuma/düzenleme için soru yoktur. Gerekçe: [harness-ux-context.yaml](../harness-ux-context.yaml) senaryosu "boş klasörde selam: plan, worker veya güven gerekmez" ve J-01 "yalnız gerçek bir güven kararı keser"; ADR-08 güveni yalnız depo kodu çalıştırmaya bağlar. *Not now* → o exec reddedilir ve görünür bir satır basılır, okuma ve düzenleme sürer; oturum içinde tekrar sorulmaz (`/trust` ile sonradan verilir). Bu, [TUI R8](../design/tui-experience.md#14-runtime-önkoşulları)'deki "oturum açılışında sor" önerisinden bilinçli bir sapmadır (R8'in amacı olan "ilk mesajı geciktirmeme" yine sağlanır). Headless'ta bugünkü gibi (exit 3 veya `--trust-workspace`).
- **Review:** doğrudan düzenlemeler zorunlu review'dan geçmez (bilinçli ürün kararı); orkestre edilen run'larda zorunlu bağımsız review aynen sürer.

### D4 — Onay ve orkestrasyon başlatma

| Durum | `autonomous` (varsayılan) | `ask` | Headless |
| --- | --- | --- | --- |
| Okuma | Sorusuz | Sorusuz | Sorusuz |
| Düzenleme / izinli exec | Sorusuz, audit'li | Eylem başına (mevcut) | Otonom kurallar; soru gerekirse exit 3 |
| Orkestrasyon | Plan bloğu gösterilir, run hemen başlar; blok `esc to stop` gösterir; steer ile değiştirilebilir. `approval/decided {decided_by: "session"}` | Plan onay overlay'i; ret → run açılmaz | Plan olayları frame olarak yazılır, otonom onay |
| Plan revizyonu, bütçe, sağlayıcı değişikliği | Mevcut (ADR-08/14) | Mevcut | Mevcut |

- **Değişmez:** `orchestrate` gösterilmiş bir plan olmadan worker başlatmaz. Geri sayım yoktur.
- Ne zaman orkestre edileceği **talimat** kuralıdır: büyük/çok parçalı iş (≈ ≥ 5 dosya, ≥ 2 bağımsız alan, `high` risk, bir bağlam penceresine sığmayan iş) veya kullanıcı isteği ("plan yap", "paralel yap", `/workers`) → plan öner; aksi halde doğrudan yap. Kullanıcı `/plan` ile her zaman zorlayabilir.

### D5 — Coordinator aynı oturumda servis

- `RunRequest` opsiyonel alanlarla genişler: `log` (konuşma oturumunun yazıcısı; verilirse coordinator yeni oturum açmaz), `plan` (ana ajanın gösterdiği plan adayı; verilirse planner turu atlanır, `validatePlan` yine koşar), `approval`, `brief`, `turnId` (hangi turdan çağrıldı). `Coordinator.run` imzası aynı kalır.
- **Olaylar konuşma günlüğüne gömülür:** run'ın `run/*`, `plan/*`, `task/*`, `review/recorded`, `task/integrated` olayları konuşma oturumuna kendi `run_id`'leriyle yazılır; worker attempt'leri bugünkü gibi ayrı oturumlardır. Tek süreç, tek `EventStore` örneği; tek yazıcı ilkesi korunur.
- **Sonuç özetlenir:** `orchestrate`'in dönüşü harness'in kurduğu bir sonuç bloğudur (hedef, görev durumları, kriter → kanıt satırları, entegre yollar, başarısızlık nedeni, orchestrator'ın son paragrafı — [TUI R5](../design/tui-experience.md#14-runtime-önkoşulları); ≤ 4 KiB). Ham worker transkripti ana ajana girmez.
- Oturum başına aynı anda en çok bir orkestrasyon (bugünkü tekil `DelegationSlot`). Orkestrasyonun iç mantığı (planner, packet, izolasyon, harness doğrulaması, bağımsız review, triyaj, entegrasyon, bütçe) değişmez.

### D6 — Doğrudan düzenleme, checkpoint, izolasyon

- Doğrudan mod **ana çalışma ağacını** düzenler; worktree yalnız orkestrasyon worker'ları içindir.
- **Checkpoint = olay günlüğü + blob ön görüntüsü**, git stash değil. Bir turda bir dosyaya ilk yazmadan önce ön görüntü blob store'a konur; tur sonunda `checkpoint/recorded {turn_id, files: [{path, before, after}]}` (digest veya `null`). `/undo` şu anki digest `after` ise `before`'u geri yazar (yoksa siler), değilse dosyayı atlayıp söyler; `checkpoint/restored`. Stash seçilmedi: kullanıcının git durumuna dokunur, git dışı dizinde çalışmaz, ADR-08 git yasağıyla çelişir. Exec'in dosya etkileri kapsam dışıdır ve `/undo` bunu söyler.
- **Kirli ağaç orkestrasyonun tabanıdır:** doğrudan düzenlenmiş bir dosyayı sahiplenen görev orkestre edilirse worker o düzenlemeyi görmelidir. ADR-19 overlay'i owned path'lere genişletilir: worktree HEAD'den açılır, kirli/izlenmeyen owned + read yolları kopyalanır, worktree içinde sentetik taban commit'i alınır; snapshot/integrate yalnız worker'ın farkını taşır. Bu gelene kadar (K3) böyle görevler ADR-07 kuralıyla `scoped-dir`'e düşer ve bu görünür bir uyarıdır.

### D7 — Uzun konuşmanın bağlamı

`ContextBuilder` aynı arayüzle `role: "session"` için (ADR-20 kararlı önek kuralıyla):

1. **Kararlı önek** (`cache.key = <session_id>:session`): `harness:session` talimatı (doğrudan mod kuralları, ne zaman plan öner, kullanıcının dilinde cevap), `.ai/` anayasası, `session`'a uygulanan protokoller (planlama ve worker protokolleri değil), rol manifesti, skill kataloğu, araç şemaları.
2. **Değişken bloklar:** tur başına hafıza çağırma (kullanıcı mesajıyla, mevcut tam metin indeksi, ≤ 5 not, neden getirildi, `untrusted`; aynı turun step'lerinde yeniden kullanılır, model çağrısı yok), son compaction özeti.
3. **History:** son compaction sınırından sonraki kendi mesajları, kullanıcı mesajları, araç çağrı/sonuç çiftleri, orkestrasyon sonuç blokları.

- **Compaction:** ADR-11 `summary-v1` aynen; ek **boşta tetik**: tur bittiğinde bağlam pencerenin %70'ini aşıyorsa compaction arka planda yapılır; kullanıcı mesajı gelirse beklenir. `/compact [odak]` elle tetikler. Özet dokunulan dosyaları, kararları, açık işleri ve plan/run referanslarını taşır.
- **Artımlı okuma:** ContextBuilder her step'te günlüğü baştan okumaz; oturum başına bellek içi projeksiyon yalnız yeni `seq`'lerle büyür. Envelope digest'i yine kaydedilir; replay deterministik kalır.

### D8 — Gecikme ve kesme

- **Cevaplayan istekten önce model çağrısı yok:** sınıflandırıcı, router modeli, otomatik planlama yok.
- **Tembel kurulum:** imleç config okuma + renderer başlatmadan sonra görünür; kanonik `.ai/`, sandbox probu, hafıza kökü, credential ön-çözümü arka planda. İlk mesaj yalnız eksik olanı bekler. Coordinator/planner yalnız `orchestrate`'te kurulur. `session` policy'si ve route kararı oturum başında bir kez kaydedilir, yalnız değişince yeniden.
- Hedefler [TUI §4](../design/tui-experience.md#4-gecikme-beklentileri) ile aynıdır (Enter → ekranda ≤ 50 ms, Enter → istek p95 ≤ 300 ms, editör hazır p95 ≤ 700 ms). Ölçüm: `model/response_settled` v2'ye opsiyonel `timing: {first_token_ms}` (TUI R9).
- `claude-code` köprüsü tur başına süreç başlatır; oturum boyu açık tek `stream-json` sürecine geçiş K2'dedir, o zamana kadar köprü route'unda gecikme hedefi geçerli değildir.
- **Kesme ([TUI §9](../design/tui-experience.md#9-tuş-atamaları-ve-komutlar)):** Esc/ilk Ctrl+C etkin isteği ve araç batch'ini iptal eder (exec süreç ağacı sonlanır), tur `cancelled`, imleç döner. Çalışırken Enter mesajı kuyruğa alır; ana ajan turunda `driver.steer`, orkestrasyon sürerken `Coordinator.steer`'e gider (bugünkü steer danışması). Orkestrasyonda ilk Esc worker'ları durdurmayı önerir, ikinci Esc run'ı iptal eder ve araç `cancelled` sonuç döner. `ask_user` beklerken yazılan mesaj cevaptır.

### D9 — `syn run` ve JSONL

- `syn run "<hedef>"` = yeni oturumda tek kullanıcı turu; ana ajan cevaplar, düzenler veya orkestre eder. `--orchestrate` eski zorunlu yolu bayt bayt korur (mevcut e2e testleri ve CI bu bayrağa geçer).
- Exit code: tur `completed` → 0, orkestrasyon varsa onun mevcut eşlemesi, `max_steps` → 4, iptal 130, bütçe mevcut kod; kesin tablo sözleşme commit'inde `exitCodeFor` ile sabitlenir.
- JSONL geriye uyumlu genişler: frame tabanında `run_id` opsiyonel olur ve opsiyonel `turn_id` eklenir; yeni `turn` frame'i (`{turn_id, phase: started|ended, outcome?}`); `hello.data.mode: conversation | orchestrate`; `result.data.summary` = ana ajanın son mesajı, `tasks` orkestrasyon yoksa boş, opsiyonel `orchestration: {run_id, status}`. `--orchestrate` çıktısı bugünkü fixture'larla aynı kalır.

### D10 — Geçiş

- `syn agent` yeni yola geçer; K0 onaylanana kadar `syn agent --legacy` eski davranışı sunar, sonra kaldırılır. Argümansız `syn`'in TTY'de ajanı açması açık soru 3'tedir (legacy snapshot etkilenmemeli).

### ADR-08/09 ile uzlaşma (HD-01, HD-04)

ADR-08 ve ADR-09 silinmez veya yeniden yazılmaz; bu ADR onlara aşağıdaki deltayı ekler. Delta dışındaki her kural aynen geçerlidir.

| Kural | ADR-08/09 (bugün) | ADR-21 deltası | Neden güvenli |
| --- | --- | --- | --- |
| Kim ürün dosyası yazar | Yalnız worker'lar, owned path'lerde, izole çalışma alanında | + `session` rolü, ana ağaçta, `**` eksi ayrılmış yollar ve policy kaynakları | Aynı gateway, aynı rail'ler (`write-outside-scope`, `reserved-path-write`, `policy-self-modification`), her yazma audit'li ve checkpoint'li |
| Orchestrator | Ürün dosyası yazmaz, exec yok | Değişmez | HREQ-002 korunur; bağımsızlık argümanı bozulmaz |
| Otonom mod | Eylem başına prompt yok; `ask` açık seçenek | Değişmez; ana ajan için de geçerli | HCTX-06 "otonomda onay istemi uydurma" |
| İnsan-yalnız konular | provider-change, budget, workspace-trust | Değişmez; güven sorusu ilk depo kodu exec'inde (D3) | Konu listesi aynı |
| Exec | Tam sandbox / allowlist + güven / ask | `session` aynı sınırlamayı alır | Windows kısmi sandbox tam koruma gibi gösterilmez |
| Git mutasyonu | İşçilere yasak | `session`'a da yasak (v1) | Kullanıcının git durumu korunur |
| Plan onayı | Otonomda orchestrator öz-onayı, `ask`'te kullanıcı | Orkestrasyonu ana ajan başlatır: otonomda plan **gösterilir** ve `decided_by: session` ile kaydedilir; `ask`'te kullanıcı | Görünmeyen plan yapısal olarak yok |
| Bağımsız review (ADR-09) | Standart/yüksek riskli orkestre görevde zorunlu | Orkestrasyonda değişmez. Doğrudan düzenleme zorunlu review'dan **geçmez**; sonuç satırı ve JSONL `result` bunu açıkça etiketler ("not independently reviewed"), `/review` isteğe bağlı bağımsız review başlatır | Rapor bağımsız review ima etmez (HD-04); ADR-18 kanıt kuralları orkestrasyonda aynen |

## Alternatives

- **Orchestrator'a sohbet yolu ve yazma yetkisi vermek:** en az kod, ama orchestrator'ın "yazmaz" değişmezini bozar ve her mesajda coordinator kurulumu taşır. Reddedildi.
- **Mesajı sınıflandıran ön model çağrısı:** her mesaja bir TTFT ekler. Reddedildi.
- **Doğrudan düzenlemeyi tek görevli worktree run'ı yapmak:** her küçük işte worktree + entegrasyon gecikmesi. Reddedildi.
- **Checkpoint için git stash / gizli branch:** kullanıcının git durumuna dokunur. Reddedildi.
- **Arka planda süren orkestrasyon + paralel sohbet (UX-GATE-02):** daha esnek ama iki eşzamanlı yazıcı akışı, mesajın kime gittiği belirsizliği, run görevlerinin yollarına dinamik yazma yasağı ve daha çok kod. v1 için reddedildi; turun içinde süren run + steer seçildi (açık soru 5, yeniden açma tetikleyicisi aşağıda).
- **Güveni oturum açılışında sormak (TUI R8):** güvenilmeyen klasörde selamdan önce bir istem çıkarır; owner UX senaryosuyla çelişir. Reddedildi; ilk ihtiyaçta sorulur (UX-GATE-01).
- **Her turu bir run yapmak:** `syn runs` listesini sohbet turlarıyla doldurur, run olay yükü ekler. Orchestrator kararıyla reddedildi.

## Consequences

- Kodun büyük kısmı değişmeden kalır; değişen ve yeni modüller [conversation-runtime.md](../design/conversation-runtime.md)'dedir.
- İlk kez bir rol tüm çalışma alanına yazar. Rail'ler aynı; birkaç kritik negatif test (ayrılmış yol, policy kaynağı, git mutasyonu, plan modu) zorunludur ve ilk büyük kilometre taşında tek bir güvenlik incelemesi yapılır.
- `syn run` JSONL tüketicileri basit hedefte plan olayı görmez; `--orchestrate` ve `hello.mode` bunu ayırt ettirir.
- Otonom orkestrasyon onayının sahibi ana ajandır (`decided_by: "session"`).

## Evidence

- Ürün sahibinin tasarım bağlamı: [harness-context.yaml](../harness-context.yaml) (`reading_contract`, `product_modes`, HCTX-01…13, HD-01…04, `delivery_order` faz 0 çıktıları: ADR deltası, doğrudan mod yetki matrisi, oturum/run kimliği kararı, UX taban ölçümü).
- Kod: `cli/session.ts`, `cli/runtime.ts`, `orchestration/coordinator.ts`, `orchestration/delegation.ts`, `policy/engine.ts`, `contracts/policy.ts`, `tools/builtin/*` (`visible_to`), `context/history.ts`.
- [product-requirements.md](../foundation/product-requirements.md), [TUI deneyimi §3, §4, §9, §14](../design/tui-experience.md), [UX araştırması](../research/ux/README.md), [pi-agent-patterns.md](../research/tui/pi-agent-patterns.md) §3–5, §7.

## Verification

- K0 kabul ölçütleri ([uygulama planı §8](../implementation-plan.md#8-konuşma-öncelikli-çekirdek-dalgası)) ve ürün sahibinin gerçek terminal denemesi.
- Kritik güvenlik testleri: `session` `.git/**`, `.synorch/**`, rol manifestine yazamaz; git mutasyonu reddedilir; plan modunda yazma/exec reddedilir; `orchestrate` gösterilmiş plan olmadan worker başlatmaz.
- `pnpm check` yeşil; mevcut testler `--orchestrate`/`--legacy` ile aynen geçer.

## Revisit trigger

- Ana ajanın orkestrasyonu yanlış zamanda önerdiği veya hiç önermediği tekrar eden gözlem.
- Doğrudan modda bir yanlış yetki olayı.
- Checkpoint'in exec yan etkileri yüzünden yanıltıcı bulunması.
- Uzun run'larda sohbetin donmasının sorun olması (arka plan orkestrasyonu yeniden değerlendirilir).

## Kaydedilen kararlar (orchestrator, 2026-09-23)

UI metni İngilizce, cevaplar kullanıcının dilinde; ana ajan büyük işte worker önerir, otonomda plan gösterip başlatır, `ask`'te sorar, kullanıcı `/plan` veya "paralel yap" ile zorlar; doğrudan düzenlemede zorunlu review yok, `/review` isteğe bağlı, orkestrasyonda zorunlu review sürer; abonelik route'larında kota %, API key route'larında $; her mesaj bir tur, run yalnız orkestrasyonla, JSONL'de tur frame'leri; 16 renk, panoda rol/model sütunları, `Shift+Tab` plan modu.

## Açık sorular (ürün sahibine)

1. **Windows'ta komut özgürlüğü:** OS sandbox olmadığı için otonom modda ana ajan yalnız allowlist'teki build/test/salt okuma komutlarını çalıştırabilir. Etkileşimli oturumda allowlist dışı yıkıcı olmayan komut için "bir kez / bu önek için hep izin ver" sorusu (insan-yalnız, kalıcı, headless'ta ret) eklensin mi? Not: bu, [harness-context.yaml](../harness-context.yaml) HCTX-06 "otonom modda onay istemi uydurma" ilkesiyle çelişir ve ADR-08'e yeni bir insan-yalnız konu (`command-grant`) eklemeyi gerektirir. Varsayılan (cevap gelene kadar): eklenmez; kullanıcı `ask` moduna geçebilir veya kullanıcı config'indeki allowlist'i genişletir.
2. **Commit:** Ana ajan v1'de commit atamaz. İnsan onaylı `/commit` (diff özeti + mesaj önerisi + onay) K2'ye alınsın mı?
3. **Argümansız `syn`:** TTY'de bir depoda argümansız `syn` doğrudan ajanı açsın mı (legacy yardım `syn --help`'te kalır)?
4. **Ana ajan modeli:** Orchestrator tier modeli mi kullanılsın, yoksa sohbet hızı için ayrı bir `session` route'u (hızlı model) mu önerilsin?
5. **Arka plan orkestrasyonu (UX-GATE-02):** v1'de run ana ajan turunun içinde sürer (pano canlı, Enter = steer, Esc Esc = durdur; ana ajan run sırasında yazmadığı için yazma sahipliği çakışmaz). Run sürerken serbest sohbet (arka plan run, `/cancel`, run görevlerinin yollarına ana ajan yazma yasağı) K3'e istenir mi?
