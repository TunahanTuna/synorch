# Konuşma runtime'ı: bileşen tasarımı

> Durum: `proposal`, 2026-09-23. Karar: [ADR-21](../decisions/ADR-21-conversation-first-runtime.md). Gereksinimler: [product-requirements.md](../foundation/product-requirements.md). Ekran: [TUI deneyimi](../design/tui-experience.md) (R0–R9). Bağlam: [harness-context.yaml](../harness-context.yaml). Taban: `harness` @ `a93ae10`. Kısa tutuldu: ayrıntı kodla birlikte `reference/`'a gider (D4).

## 1. Tur akışı

```text
renderer.input ──► ConversationLoop (cli/conversation.ts)
                    │ ilk mesajda: session create (yoksa), session policy + route (önbellekli)
                    ▼
                  AgentDriver.runTurn({role: "session", trigger: "user", runId: undefined, …})   ← mevcut, değişmez
                    │ ContextBuilder.build(role: session)  → kararlı önek + hafıza + history
                    │ adapter.stream ──► renderer (stream)
                    │ tool calls ──► ToolGateway.invoke  (policy ∩ sandbox ∩ güven ∩ onay, audit)
                    │      ├─ read/search/list/git_*     → mevcut araçlar
                    │      ├─ apply_patch/write_file     → mevcut araçlar + checkpoint ön görüntüsü
                    │      ├─ exec                       → mevcut araç + SandboxRunner
                    │      ├─ plan_propose               → plan/proposed (plan bloğu)
                    │      └─ orchestrate ──► Coordinator.run({log: konuşma günlüğü, plan, approval, turnId})
                    │                          worker'lar ayrı oturumlarda (mevcut); pano; Enter → coordinator.steer
                    │                          dönüş: sonuç bloğu (≤ 4 KiB) → aynı turda ana ajan raporlar
                    ▼
                  turn/ended → checkpoint/recorded → (bağlam > %70 ise) boşta compaction
```

## 2. Modül haritası

Satır sayıları bugünkü `src/harness` (36,7k satır) üzerinden kaba tahmindir.

| Modül | Bugün (satır) | Karar | Değişiklik |
| --- | --- | --- | --- |
| `store/` | 1,4k | Değişmez | — |
| `providers/` | 3,2k | Neredeyse değişmez | K2: `claude-code` köprüsü için oturum boyu açık `stream-json` süreci (~150) |
| `auth/` | 2,0k | Değişmez | Credential ön-çözümü composition'dan çağrılır |
| `memory/` | 1,7k | Değişmez | — |
| `core/` | 1,5k | Neredeyse değişmez | `trigger`/`runId` opsiyonelliği; `timing.first_token_ms` yazımı (~40) |
| `tools/` | 3,5k | Ekleme | `visible_to`'ya `session`; write araçlarında checkpoint ön görüntüsü (~120); `orchestrate` kontrol aracı tanımı (~40) |
| `policy/` | 2,5k | Ekleme | `ROLE_EFFECT_CEILINGS.session`, `session` yazma kapsamı, plan modu katmanı, git mutasyon reddinin `session`'a uygulanması (~120) |
| `orchestration/` | 8,1k | Ekleme | `RunRequest.log/plan/approval/brief/turnId` (planner atlama, paylaşılan günlük) (~150); sonuç bloğu (R5) (~60); K3: dirty base overlay (~200, `isolation.ts`) |
| `context/` | 1,3k | Ekleme | `harness:session` talimatı ve protokol seçimi (~120), artımlı projeksiyon (~150), boşta compaction tetiği (~60) |
| `tui/` | 2,5k | TUI iş akışına ait | [TUI deneyimi](./tui-experience.md) mockup'ları; bu tasarım yalnız R1/R2/R9 olaylarını sağlar |
| `cli/` | 4,3k | **Kısmen yeniden yazılır** | `session.ts` `agentCommand`/`runCommand` → yeni `conversation.ts` (~450, eskisi `--legacy`/`--orchestrate` yolu olarak kalır); `runtime.ts` tembel kurulum (~150 değişen); `slash-commands.ts` `/plan` `/tasks` `/undo` `/compact` `/workers` `/review` `/why` (~150); `args.ts` `--orchestrate`, `--legacy`, `--continue` (~40) |
| `contracts/` | 4,6k | Tek sözleşme commit'i | §3 (~200) |

Özet: mevcut kodun **≈ %90'ı değişmeden** kalır (store, providers, auth, memory, tools, policy, orchestration ve core'un iç mantığı); **≈ %3'ü yeniden yazılır** (`cli/session.ts` ve `cli/runtime.ts`'nin kurulum kısmı); toplam **≈ 2,5k satır** yeni/eklenen kod (≈ %7). Yeni bir üst düzey modül açılmaz: konuşma döngüsü, composition root'un zaten kardeş modülleri birleştirdiği `cli/` içinde yaşar (boundary kuralı değişmez).

## 3. Sözleşme değişiklikleri (tek commit, K0'dan önce)

Hepsi opsiyonel alan veya enum eklemesidir; eski olaylar okunmaya devam eder (governance §4, `EVENT_FIELD_VERSIONS`).

| Dosya | Değişiklik |
| --- | --- |
| `common.ts` | `AGENT_ROLES += "session"`; `ACTOR_KINDS += "agent"` |
| `policy.ts` | `effectivePolicySchema`: `run_id` opsiyonel (yalnız `session` için yok olabilir); `session` için `write_scope: ["**"]` izni (ayrılmış yollar yine yasak); `approval decided_by += "session"`; plan modu için `POLICY_LAYERS` içinde `task` katmanı kullanılır (yeni katman yok) |
| `runtime.ts` | `TurnInput.runId`, `ContextBuildInput.runId` opsiyonel; `RunRequest.log?`, `plan?`, `approval?`, `brief?`, `turnId?`; `RunOutcome.finalMessage?` (R5) |
| `tools.ts` | `ToolExecutionContext.runId` opsiyonel, `checkpoint?: CheckpointRecorder` (`capture(path, beforeDigest \| null)`) |
| `events.ts` | `checkpoint/recorded`, `checkpoint/restored` (v1); `model/response_settled` v2 `timing?: {first_token_ms}` (R9); `turn/ended` v2 `files_changed?` (ölçüm); `run/created` v2 `parent_turn_id?` |
| `jsonl.ts` | frame tabanında `run_id` opsiyonel + `turn_id?`; yeni `turn` frame'i; `hello.data.mode?`; `result.data.orchestration?`, `result.data.reviewed?` (doğrudan düzenlemede `false`) |
| `renderer.ts` | `stream` olayına `origin?` (R1); `StatusLine` alanları (R2) — TUI iş akışıyla birlikte |
| `errors.ts` | `max_steps` turunun exit kodu tablosu |

## 4. Gecikme için somut değişiklikler

| Bugün | Değişiklik |
| --- | --- |
| İlk mesajdan sonra koşulsuz `promptWorkspaceTrust` | Yalnız depo kodu çalıştıran ilk exec'te (ADR-21 D3, UX-GATE-01); selam/okuma/düzenleme hiç beklemez |
| Her mesajda `coordinator.run` → run/policy/route olayları + planlama turu | Yalnız `orchestrate`'te |
| `createRuntime` hepsini senkron kurar (kanonik `.ai/`, sandbox probu, adapter'lar, hafıza) | Config + renderer senkron; gerisi `Promise` olarak başlatılır, ilk `build` yalnız eksik olanı bekler |
| ContextBuilder her step'te günlüğün tamamını okur (`readAll`) | Oturum başına artımlı projeksiyon |
| `session` policy/route her tur yeniden | Oturum başında bir kez; değişince yeniden kaydedilir |
| Credential ilk istekte çözülür (keychain süreci, token yenileme) | Açılışta arka planda ön-çözüm |

Ölçüm: `turn/started` → `model/request_prepared` zaman damgası farkı (L3) ve `timing.first_token_ms` (L4); sahte adapter'la tek bir zamanlama testi.

## 5. Test geçişi (önce inşa et)

- Mevcut `syn agent`/`syn run` e2e testleri (`harness-e2e-agent`, `-steer`, `-ask-user`, `-trust`, `-recovery`, `-headless`, `-trivial`, `-standard`, `-conflict`, `-high-risk`, `-provider`, `-live-*`) argümanlarına `--orchestrate` (run) veya `--legacy` (agent) eklenerek **aynen** geçer; script'leri değişmez. `--legacy` K0 onayından sonra kaldırılırken agent testleri `syn run --orchestrate`'e taşınır.
- `harness-cli-args`, `harness-tui-*` yeni bayraklar ve `turn` frame'i için güncellenir.
- Yeni testler yalnız şunlar: (1) scripted adapter'la konuşma e2e'si (selam → okuma → düzenleme → exec); (2) kritik güvenlik rail'leri (`session` → `.git`/`.synorch`/rol manifesti yazma reddi, git mutasyon reddi, plan modu yazma/exec reddi, gösterilmemiş planla worker başlamaması); (3) ana konuşma görünümü snapshot'ları (TUI §15); (4) tek zamanlama testi (L3/L4).
- `pnpm check` ve legacy snapshot her dalgada yeşil. Kapsamlı matris ve replay paketi yok (ürün sahibi kararı).

## 6. Riskler

| Risk | Etki | Azaltma |
| --- | --- | --- |
| Tüm çalışma alanına yazan ilk rol | Yanlış yetki | Aynı gateway ve rail'ler; kritik negatif testler; ilk büyük kilometre taşında tek güvenlik incelemesi |
| Windows'ta allowlist dışı komutlar reddedilir | Claude Code'dan daha kısıtlı his | Açık ret metni + `/why`; ADR-21 açık soru 1 |
| Ana ajan orkestrasyonu yanlış zamanda önerir | Gereksiz maliyet veya kalitesiz büyük doğrudan iş | Talimat eşiği; `/plan` ile zorlama; `turn/ended.files_changed` ölçümü |
| Kirli ağaçta orkestrasyon (dirty base K3'e kadar yok) | Worker doğrudan düzenlemeyi görmez | O görevler `scoped-dir`'e düşer ve uyarı basılır |
| Uzun oturumda compaction kalitesi | Bağlam kaybı | ADR-11 özetine dosya/karar/açık iş alanları; `/compact [odak]` |
| Paylaşılan günlükte ana ajan ve coordinator olayları | History karışması | `belongsTo` rol filtresi; orkestrasyon yalnız sonuç bloğu olarak görünür |
| JSONL tüketicileri | Plan olayı beklenen yerde yok | `--orchestrate`, `hello.mode`, yalnız opsiyonel alanlar |

## 7. Arka plan orkestrasyonu (K3, UX-GATE-02)

Run sürerken sohbet açık kalır (Claude Code'un arka plan görevleri gibi). ADR-21 açık soru 5'in K3 cevabı; v1'deki "run turun içinde" davranışı headless için aynen kalır.

- **Ne zaman arka planda:** etkileşimli oturumda (stdin TTY, insan bağlı) `orchestrate` varsayılan olarak arka planda başlar ve hemen `run-N` kimliğiyle döner. `orchestrate {wait: true}` ve her headless/JSONL oturum run bitene kadar turu tutar (eski davranış: yazılan mesaj coordinator'ı steer eder, Esc Esc durdurur); böylece headless'ta run yetim kalmaz, olaylar bugünkü gibi akar.
- **Tamamlanma bildirimi:** run bitince kullanıcıya bir satır (`Background workers run-1 finished`) ve pano özeti; ajana sonuç bloğunu taşıyan bir `[Synorch note: …]` bir sonraki tura eklenir. Oturum boştaysa döngü uyanır ve `trigger: follow-up` kısa bir tur sonucu kullanıcıya özetler. Ajan sonucu `run_status` ile kendisi okuduysa not düşürülür (çift rapor yok).
- **Ajan araçları (yalnız `session`):** `run_status {run?, wait?, timeout_seconds?}` (faz, görevler, durum, etkinlik, sahip olunan yollar; bitince sonuç bloğu), `run_steer {message, run?, task?}` (task yoksa orchestrator'a bir sonraki güvenli noktada, varsa o worker'a bir sonraki adımda), `run_cancel {run?, task?}`.
- **Kullanıcı:** `/runs` (liste), `/runs <id>` (görevler), `/runs cancel [id]`; `/cancel` önce çalışan turu, tur yoksa arka plan run'ını durdurur. Arka plan run'ında yazılan mesaj ajana gider (ajan düzeltmeyi `run_steer` ile iletir); worker'a doğrudan mesaj için drill-in veya `/worker <key> <mesaj>`. Esc yalnız turu keser, run sürer. Pano editörün üstünde kalır; Ctrl+G pano/graf, ↓ worker seçimi, Enter worker görünümü. Editör serbest olduğu için çıplak `g` yalnız bir worker seçiliyken grafı açar.
- **Çakışma güvenliği:** worker'lar kendi worktree'lerinde çalışır; entegrasyon her dosyanın tabanını ana ağaçla karşılaştırır ve ana ağaç değiştiyse `integration conflict` ile görevi düşürür (sessiz üzerine yazma yok). Ek olarak ajan, canlı bir görevin sahip olduğu yola `apply_patch`/`write_file` ile yazmak isterse gateway o çağrıyı `workspace-write: deny` katmanıyla (`background-run-owned-path`) reddeder; ret metni sahibi görevi ve seçenekleri (bekle, `run_steer`, iptal) söyler. Planlama sırasında (görevler oluşmadan) kilit yoktur; o aralıkta koruma entegrasyon çakışma kontrolüdür. `exec` ile yapılan yazmalar kilitlenmez (aynı kontrol geçerli).
- **İzin ve istemler:** worker'lar oturumun izin modunu kullanır (auto = otonom). Arka plan run'ı varken TUI'de istemler (worker onayları, ajan soruları) tek tek sıraya girer ve kullanıcı yazmayı ~1,2 sn bıraktığında açılır; beklerken bir uyarı satırı görünür, taslak editörde kalır.
- **Çıkış:** `/exit` ve `/quit` run'ı temizce iptal eder (worktree temizliği için ≤ 15 sn bekler); Ctrl+C Ctrl+C / Ctrl+D "Keep working / Stop the workers and exit" sorar. Oturum sonunda (her yol) aktif run iptal edilir ve beklenir.
- **Sınırlar (v1):** aynı anda tek run (ikinci `orchestrate` açıklayıcı hatayla reddedilir); resume sonrası önceki süreçteki arka plan run'ları sürmez.
