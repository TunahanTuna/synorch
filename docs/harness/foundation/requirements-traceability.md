# Gereksinim izlenebilirliği

> Durum: `accepted`, 2026-09-22. Sahip: entegrasyon (orchestrator). Her P0 gereksinim bir ADR, bir sözleşme maddesi, bir test ve bir sorumlu modüle bağlanır ([dokümantasyon planı](../workflow/documentation-plan.md) §6). "Mevcut test" sütunu bugün `pnpm check` içinde çalışan testleri, "Planlanan test" iş akışlarının [uygulama planındaki](../implementation-plan.md) kabul ölçütlerini gösterir. Commit sütunu entegrasyonda doldurulur.

Kaynak: ürün sahibi kararları (2026-09-22), [vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md), [harness README](../README.md).

| HREQ | Öncelik | Gereksinim | ADR | Sözleşme | Mevcut test | Planlanan test | Modül |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HREQ-001 | P0 | Mevcut `syn inspect/init/sync/doctor` davranışı bayt bayt korunur; runtime eager yüklenmez | ADR-01 | [cli-and-jsonl §1](../contracts/cli-and-jsonl.md#1-geriye-uyumluluk-sınırı) | `tests/harness-boundary.test.ts` (legacy katman importu), mevcut 11 test dosyası | I5 AC-1 `tests/cli-legacy-snapshot.test.ts` | cli |
| HREQ-002 | P0 | Orchestrator → explorer/implementer/debugger/reviewer rolleri runtime'da zorlanır (orchestrator ürün dosyası yazmaz, read-only roller yazmaz) | ADR-02, ADR-08, ADR-10 | [policy §4](../contracts/policy-and-approval.md#4-effectivepolicy-alanları), [task-packets §2](../contracts/task-packets.md#2-task-context-packet-v2-kind-full) | `harness-contracts`: effective-policy/task-packet invalid örnekleri, packet mutasyon testi | I3 AC-2, I4 AC-8 | policy, orchestration |
| HREQ-003 | P0 | Plan, task, completion, review paketleri şemayla doğrulanır; bozuk ve yetki genişletmeye çalışan paketler reddedilir (Faz 0 kapısı) | ADR-07, ADR-09, ADR-10 | [task-packets](../contracts/task-packets.md) | `harness-contracts`: plan/task/delta/completion/review geçerli+geçersiz örnekler, "privilege escalation through packet mutation" | I4 AC-1 | contracts, orchestration |
| HREQ-004 | P0 | Bağımsız review: ayrı bağlam, sabit artifact, reviewer'ın kendi kanıtı; implementer raporu tek başına kabul değildir | ADR-09 | [task-packets §5](../contracts/task-packets.md#5-review-packet) | `harness-contracts`: review-packet invalid (yalnız worker kanıtı, kendi kendini inceleme) | I4 AC-2/3 | orchestration |
| HREQ-005 | P0 | Append-only event log, tek yazıcı lease, replay, crash recovery; yan etkili çağrı sessiz tekrarlanmaz | ADR-03 | [events-and-storage](../contracts/events-and-storage.md), [identity-and-state §3](../contracts/identity-and-state.md#3-crash-recovery-eşlemesi) | `harness-contracts`: session-event geçerli/geçersiz/unsupported, geçiş tabloları | I1 AC-1…4, AC-7, AC-8 | store, core |
| HREQ-006 | P0 | Modelin gördüğü girdi log + blob'lardan yeniden üretilebilir | ADR-03, ADR-11 | [events-and-storage §1](../contracts/events-and-storage.md#1-temel-ilkeler), [model-adapter §2](../contracts/model-adapter.md#2-modeladapter) | `harness-contracts`: canonical JSON/digest | I1 AC-5 | core, context |
| HREQ-007 | P0 | Orchestrator tam yetkili, varsayılan `autonomous` (eylem başına prompt yok); `ask` açık seçenek | ADR-08 | [policy §2](../contracts/policy-and-approval.md#2-modlar), [policy §6](../contracts/policy-and-approval.md#6-onay) | `harness-contracts`: approval-decision örnekleri, autonomous'ta `ask` reddi | I3 AC-4, I4 plan onayı | policy, orchestration |
| HREQ-008 | P0 | Hard rail'ler: workspace/owned dışı yazım yok, yıkıcı komut reddi, her şey audit | ADR-06, ADR-08 | [policy §3](../contracts/policy-and-approval.md#3-hard-railler), [tools §1](../contracts/tools.md#1-tek-hat) | `harness-contracts`: normalized-action `..` reddi, policy-decision rail≠allow, whole-workspace/reserved path retleri | I3 AC-1/3/5 | policy, tools |
| HREQ-009 | P0 | OpenAI ChatGPT aboneliğiyle giriş (PKCE + device-code) ve Responses ile model kullanımı | ADR-05 | [model-adapter §7](../contracts/model-adapter.md#7-kimlik-doğrulama-soyutlaması) | `harness-contracts`: credential-secret (`originator: synorch`), provider-capabilities | I2 AC-1/2/3 | auth, providers |
| HREQ-010 | P1 | Claude aboneliği yalnız kullanıcının kendi Claude Code'u üzerinden (`cli-bridge`); doğrudan Claude.ai OAuth yok | ADR-05 | [model-adapter §3](../contracts/model-adapter.md#3-agentbackendadapter-cli-bridge) | `harness-contracts`: cli-bridge secret reddi, backend + native tool kanalı reddi | I2 AC-5 | providers, auth |
| HREQ-011 | P0 | OpenAI ve Anthropic API key desteği | ADR-05 | [model-adapter §1](../contracts/model-adapter.md#1-iki-adapter-ailesi-tek-stream-sözleşmesi) | `harness-contracts`: auth-status, credential-secret | I2 AC-1 | providers, auth |
| HREQ-012 | P0 | Credential güvenliği: keychain öncelikli, `0600` fallback, yabancı token deposu yok, sessiz ücretli fallback yok | ADR-05, ADR-08 | [model-adapter §6–7](../contracts/model-adapter.md#6-yönlendirme-ve-fallback) | `harness-contracts`: route-decision onaysız fallback reddi, orchestrator'ın provider-change onayı reddi | I2 AC-3/4/6 | auth, providers |
| HREQ-013 | P0 | Windows/macOS/Linux/SSH/non-TTY'de çalışan terminal: pi-tui adapter + plain + JSONL | ADR-04 | [cli-and-jsonl §3](../contracts/cli-and-jsonl.md#3-renderer-seçimi) | `harness-contracts`: renderer/color seçimi; `harness-boundary`: pi-tui tek dosya | I5 AC-2/4 | tui |
| HREQ-014 | P0 | JSONL makine modu, stdout yalnız frame, kesin exit code'lar | ADR-15 | [cli-and-jsonl §4–5](../contracts/cli-and-jsonl.md#4-jsonl-frameleri) | `harness-contracts`: jsonl-frame örnekleri, dizi invariant'ları, LF bölme, exit code totalliği | I5 AC-2/3 | cli, tui |
| HREQ-015 | P0 | Paralel worker'lar aynı path'e yazmaz; yazan worker izole | ADR-07 | [task-packets §1](../contracts/task-packets.md#1-plan) | `harness-contracts`: plan invalid (paralel örtüşme, büyük/küçük harf), path overlap testi | I4 AC-1 | orchestration |
| HREQ-016 | P1 | Bütçe ve kullanım kaynak etiketiyle görünür; aşımda politika | ADR-14 | [model-adapter §2](../contracts/model-adapter.md#2-modeladapter), [events §3](../contracts/events-and-storage.md#3-event-kataloğu) (`budget/exceeded`) | `harness-contracts`: usage şeması (örnekler) | I4 AC-6 | orchestration |
| HREQ-017 | P1 | Compaction kanıt kaybetmez, orijinal olayları silmez | ADR-11 | [events §3](../contracts/events-and-storage.md#3-event-kataloğu) (`context/compacted`) | — | I4 AC-7 | context |
| HREQ-018 | P1 | Markdown hafıza, Obsidian isteğe bağlı; varsayılan `~/.synorch/memory/<project-id>/` | ADR-16 | [memory §1–2](../contracts/memory.md#1-konum-ve-sınır) | `harness-contracts`: memory-note örnekleri | I6 AC-1/2/4 | memory |
| HREQ-019 | P1 | Hafıza yazma politikası: evidence/concept otomatik, decision/preference/çelişki kuyrukta; orchestrator kabulü denetlenir | ADR-17 | [memory §3](../contracts/memory.md#3-yazma-politikası-adr-17) | `harness-contracts`: memory-note/proposal invalid örnekleri | I6 AC-3 | memory |
| HREQ-020 | P0 | `doctor --runtime` ücretli istek göndermeden sandbox/store/auth/capability raporlar | ADR-04, ADR-05, ADR-06 | [cli-and-jsonl §2](../contracts/cli-and-jsonl.md#2-komutlar-v1), [tools §5](../contracts/tools.md#5-sandbox) | `harness-contracts`: sandbox-report örnekleri | I5 AC-6, I2 health testleri | cli, tools, providers |
| HREQ-021 | P1 | v1'de üçüncü taraf eklenti yok; MCP client sonra; köprü için dahili MCP sunucusu | ADR-12, ADR-13 | [tools §2](../contracts/tools.md#2-metadata) | `harness-contracts`: tool-metadata invalid (MCP/extension öz beyanı); `harness-boundary`: computed import yasağı | I2 AC-5 | tools, providers |
| HREQ-022 | P0 | Secret'lar prompt, log, artifact, terminal ve hafızada redakte edilir | ADR-05, ADR-06 | [events §1](../contracts/events-and-storage.md#1-temel-ilkeler), [tools §3](../contracts/tools.md#3-sonuç) | `harness-contracts`: provider-error'da fazladan `api_key` alanı reddi | I2 AC-4, I3 AC-7, I6 AC-5 | tools, auth, memory |

## Kapsam dışı (v1)

Daemon, web/desktop UI, remote runner, stdin RPC modu, MCP client, semantik hafıza katmanı, Obsidian eklentisi, üçüncü taraf eklenti yükleme, Codex app-server köprüsünün uygulanması (yalnız seam), ekip/çok kullanıcılı yönetim.

## Konuşma öncelikli pivot (ekleme, 2026-09-23)

Kaynak: [product-requirements.md](./product-requirements.md) (D0), [ADR-21](../decisions/ADR-21-conversation-first-runtime.md) (D1), [harness-context.yaml](../harness-context.yaml) (HCTX/HD kimlikleri). Zincir: D0 → D1 (ADR-21) → D2 (sözleşme commit'i) → K0 dikey dilim → K1…K4 ([uygulama planı §8](../implementation-plan.md#8-konuşma-öncelikli-çekirdek-dalgası)). Test sütunu "önce inşa et" kararına göre yalnız kritik testleri listeler; diğerleri ürün sahibi denemesiyle (UX kapısı) kabul edilir.

| HREQ | Öncelik | Gereksinim (kısa) | ADR | Sözleşme | Planlanan test / kanıt | Dalga | Modül |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HREQ-023 | P0 | Her mesaj ana ajan turu, anında stream | ADR-21 D1 | `runtime.ts` `TurnInput` | `harness-e2e-conversation` (selam turu), ürün sahibi | K0 | cli, core |
| HREQ-024 | P0 | Gecikme L1–L4, güven sorusu açılışta | ADR-21 D3, D8 | `events.ts` `timing` | tek zamanlama testi | K0/K1 | cli, context |
| HREQ-025 | P0 | Ana ajan araçları tek gateway'den | ADR-21 D2, ADR-08 | `tools.ts` | mevcut gateway testleri | K0 | tools, policy |
| HREQ-026 | P0 | Doğrudan yazma kapsamı, git mutasyonu yok | ADR-21 D3 | `policy.ts` | `harness-security-session` | K0 | policy |
| HREQ-027 | P0 | Exec sınırlaması + güven | ADR-21 D3, ADR-06 | `policy.ts` | mevcut exec/trust testleri | K0 | policy, tools |
| HREQ-028 | P0 | Doğrudan değişiklik "review yapılmadı" etiketi, `/review` | ADR-21 uzlaşma tablosu, ADR-09 | `jsonl.ts` `result.reviewed` | ürün sahibi | K1/K3 | cli, tui |
| HREQ-029 | P1 | Checkpoint + `/undo` | ADR-21 D6 | `events.ts` `checkpoint/*` | tek mutlu yol testi | K1 | tools, cli |
| HREQ-030 | P1 | Plan modu | ADR-21 D2 | `policy.ts` katman | plan modu ret testi | K1 | policy, cli |
| HREQ-031 | P0 | Orkestrasyon ana ajan aracı, aynı oturum | ADR-21 D5 | `runtime.ts` `RunRequest` | orkestrasyon e2e | K2 | orchestration, cli |
| HREQ-032 | P0 | Gösterilmemiş planla worker yok | ADR-21 D4 | `policy.ts` `decided_by` | kritik test (otonom + ask) | K2 | cli, orchestration |
| HREQ-033 | P0 | Tur ≠ run; JSONL tur frame'leri | ADR-21 D1, D9 | `jsonl.ts` | JSONL frame testi | K1 | cli, tui |
| HREQ-034 | P0 | Uzun oturum bağlamı | ADR-21 D7, ADR-11, ADR-20 | `runtime.ts` | ürün sahibi (uzun oturum) | K1 | context |
| HREQ-035 | P0 | Resume/fork/recovery, `--continue` | ADR-21 D1, ADR-03 | `events.ts` | mevcut recovery testleri | K0/K1 | cli, core |
| HREQ-036 | P1 | Tur başına hafıza | ADR-21 D7, ADR-16/17 | `memory.ts` | ürün sahibi | K1 | context |
| HREQ-037 | P0 | `syn run` tek tur, `--orchestrate` | ADR-21 D9, ADR-15 | `jsonl.ts` | mevcut e2e'ler `--orchestrate` ile | K0/K1 | cli |
| HREQ-038 | P0 | Esc/steer semantiği | ADR-21 D8 | `runtime.ts` `AgentDriver.steer` | mevcut driver iptal testleri | K0 | core, cli |
| HREQ-039 | P0 | UX kapısı | ADR-21 | — | ana konuşma snapshot'ları + ürün sahibi | her dalga | tui |
| HREQ-040 | P1 | Ayrıştırıcılar | ADR-21 | — | ürün sahibi | K1–K4 | çeşitli |

HREQ-002 notu: orchestrator'ın ürün dosyası yazmaması değişmez; doğrudan yazma ADR-21 ile eklenen `session` rolüne aittir.
