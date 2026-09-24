# ADR-08: Onay politikası — otonom varsayılan ve hard rail'ler

## Status

Accepted

## Date

2026-09-22

## Context

Mevcut Synorch protokolü her görev planı için kullanıcı onayı öngörür (`execution_requires_user_approval`, [mimari](../../AI-ORCHESTRATION-ARCHITECTURE.md) §7). Ürün sahibi kararı: orchestrator **tam yetkilidir** ve oturumu otonom yürütür; varsayılan olarak eylem başına onay sorulmaz. Buna karşın prompt olmayan teknik sınırlar korunmalıdır: çalışma alanı dışına yazma yok, yıkıcı/geri alınamaz komutlar policy ile reddedilir, her şey audit edilir. Daha sıkı mod açık seçenek olmalıdır.

## Decision

- Policy modları: `autonomous` (varsayılan, `DEFAULT_POLICY_MODE`) ve `ask`.
- `autonomous`: eylem başına prompt yok; etki matrisinde `ask` değeri şemaca yasaktır. Plan onayı `approval/decided` olayı olarak `decided_by: orchestrator` ile kaydedilir (audit).
- `ask`: plan ve kapsam içi yazma/exec eylemleri kullanıcıya sorulur.
- Hard rail'ler (`HARD_RAILS`) prompt değil, retdir; hiçbir mod, grant, config veya onay gevşetemez: `write-outside-scope`, `reserved-path-write` (`.git`, `.synorch`), `destructive-command`, `credential-access`, `secret-egress`, `policy-self-modification`, `foreign-credential-store`.
- `external-write` (ör. push, publish, dış sistem yazımı) otonom modda yalnız kullanıcı allowlist'i (`external_write_allowlist`) ile izinlidir; aksi halde `deny`.
- Yalnızca insanın onaylayabileceği konular: `provider-change`, `budget`, `workspace-trust` (`HUMAN_ONLY_APPROVAL_SUBJECTS`).
- **Değişiklik (2026-09-23), rail'in dürüst kapsamı:** `write-outside-scope` harness araçlarının her yazması için uygulanır. Sandbox `full` değilken exec edilen bir process'in yazması **sınırlanamaz**; bu yüzden depo kodunu çalıştıran komutlar (doğrulama komutları ve build/test listesi) yalnız kullanıcının güvendiği çalışma alanında çalışır. Güvenilmeyen çalışma alanında `autonomous` mod bu komutları `workspace-untrusted` ile **reddeder** (prompt değil; headless run exit 3), `ask` modu sorar. Güven kullanıcı kapsamında (`<synorch home>/trust.json`) bir kez verilir — `syn trust`, renderer'ın onay arayüzünden tek seferlik soru veya tek run için `--trust-workspace` — ve denetlenir (`trust/granted`, `trust/revoked`, `trust/used`). Orchestrator, depo içeriği, yapılandırma katmanı veya model metni güven veremez. Güvenilen bir build/test komutunun çalıştırdığı kod için "çalışma alanı dışına yazma yok" garantisi **verilmez**; yol haritası: Windows OS sandbox (AppContainer/restricted token + job object), bkz. [ADR-06](./ADR-06-sandbox.md).
- İşçiler git entegrasyon komutlarını (`git add`, `commit`, `stash`, `checkout`, `reset`, `switch`, `restore`, `rebase`, `merge`, `tag`, `branch` yazma biçimleri, …) hiçbir modda ve sandbox'ta çalıştıramaz; yalnız harness entegre eder.
- Oturum model profili açılış başlığında gösterilir; otonom modda engelleyici prompt değildir, `ask` modunda onaylatılır.
- Bu karar runtime için statik `execution_requires_user_approval` invariant'ının yerini alır; `.ai/` canonical dosyaları host agent'lar için değişmeden kalır.
- Etkin yetki: `platform ∩ user ∩ workspace ∩ role ∩ task ∩ sandbox ∩ approval`; model metni, repo dosyası veya tool çıktısı yetki kaynağı değildir.

## 2026-09-24 owner revision — etkileşimli izin modları

Ürün sahibi geri bildirimi (bağlayıcı; "otonom = asla sorma, sadece reddet" yorumunun yerine geçer): *"CLI'mın yetkisi yok gibi; Claude Code'da ask / auto-accept / full access var; önemli şeylerde sor; izinlerde cömert ol yoksa iş yapamaz."* Windows'ta (kısmi sandbox) build/test allowlist'i dışındaki her komut doğrudan reddediliyordu ve kullanıcının `/allow` dışında yapabileceği bir şey yoktu. Bu bölüm ekleyicidir; yukarıdaki kararlar headless için aynen geçerlidir.

- **Modlar** (`PERMISSION_MODES`, `EffectivePolicy.permission_mode`, yalnız `session`; işçiler yalnız `full`'u miras alır):
  - `ask`: düzenleme ve komutlar sorulur (`mode: ask`).
  - `auto` (**etkileşimli oturumun varsayılanı**, kullanıcı config'i `ui.permission_mode`): düzenlemeler ve allowlist'teki/güvenilen komutlar kendiliğinden çalışır; allowlist dışı komut, güvenilmeyen çalışma alanında depo kodu, dış yazma ve allowlist dışı host **ret yerine etkileşimli soru** üretir.
  - `full`: soru yok; çalışma alanında her şey serbest, yalnız hard rail'ler (kimlik bilgisi/Synorch home depoları, `.git` iç yapısı, çalışma alanı dışını hedefleyen yıkıcı komutlar, sır sızdırma, git entegrasyonu) kalır. Güveni yalnız oturum için ima eder (kalıcı değil) ve kırmızı tek satırla söylenir.
  - `plan`: salt okur.
- **Motor:** allowlist retleri (`PERMISSION_LIFTABLE_CODES`) `auto`'da `ask`, `full`'da `allow` olur; hard rail her modda `deny`'dir ("rail prompt değildir" kuralı değişmedi). Repo katmanları yalnız daraltabilir: `policy.mode: ask` `auto`/`full`'u `ask`'e indirir, `ui` anahtarı repo katmanında yok sayılır.
- **Soru arayüzü (UX-03):** eylem kartı (ne / neden / sonuç) ve seçimler *Allow once* · *Always allow `<önek>`* (çalışma alanı başına, kullanıcı kapsamı, `command/allowed` ile denetlenir) · *Deny* (isteğe bağlı gerekçe ajana iletilir). 1/2/3 veya oklar + Enter; Esc = ret; TTY'de zaman aşımı yok. `Shift+Tab` `ask → auto → full → plan` döngüsüdür (`/plan` sürer); alt bilgi modu renkle gösterir (`full` kırmızı/kalın). `/permissions` modu, kalıcı kuralları ve güven durumunu gösterir; kural ekler/siler, mod değiştirir; `/allow` kısayol olarak kalır.
- **Güven kapısı** `auto`/`ask`'te aynı soru akışının parçasıdır (depo kodu çalıştıran ilk komutta "trust this workspace?").
- **Headless** (`syn run`, JSONL, TTY yok): `--permission-mode full|auto` açıkça verilmedikçe bugünkü varsayılan-ret aynen sürer; headless `auto`'da sorular rettir.
- Önceki "Alternatives" maddesindeki *"Otonom modda dış yazma için prompt: reddedildi"* kararı etkileşimli `auto` için tersine çevrildi; headless ve mod yokken geçerlidir.
- Kanıt: `src/harness/contracts/policy.ts` (`PERMISSION_MODES`, `PERMISSION_LIFTABLE_CODES`, `approvalRequestSchema.command/details`), `src/harness/policy/engine.ts` (`liftByPermission`), `src/harness/cli/conversation.ts` (broker, `/permissions`), `tests/harness-policy-permission-modes.test.ts`, `tests/harness-e2e-permission-modes.test.ts`; sözleşme: [policy ve onay §9](../contracts/policy-and-approval.md).

### 2026-09-24 owner revision (ek) — yıkıcı komutlar `full`'da da sorar

Ürün sahibi kararı (bağlayıcı, ekleyici): `full` modda yıkıcı komut kuralları (`DESTRUCTIVE_COMMAND_RULES`: force push, `npm publish`, özyinelemeli silme — çalışma alanı dışı dahil —, `git reset --hard`, `git clean -f`, disk biçimlendirme, uzak betik çalıştırma vb.) **sert ret yerine etkileşimli soru** (eylem kartı) üretir; `auto` ve `ask`'te de sorar. Headless (insan yok) aynen reddeder; `plan` ve varsayılan-ret (mod yok) reddeder; salt-okur roller reddeder.

- **Motor:** `destructive-command` rail'i taşıyan, katmanı `platform` olan bulgu "sorulabilir"dir; kararın tek sert olmayan retleri bunlar (ve `PERMISSION_LIFTABLE_CODES`) ise `ask|auto|full`'da karar `ask` olur, rail kaldırılır ve `destructive-prompt` gerekçesi eklenir (kural kodu, ör. `git-force-push`, kartta "neden" olarak kalır). Aynı kararda başka bir rail varsa o rail raporlanır ve karar `deny` kalır.
- **Sert rail olarak kalanlar (her mod):** çalışma alanı dışına çözülen yazmalar ve kaçışlar (`write-outside-scope`), `.git` iç yapısı ve Synorch home (`reserved-path-write`), kimlik bilgisi depoları (`credential-access`, `foreign-credential-store`), sır sızdırma (`secret-egress`), policy kaynakları (`policy-self-modification`), git entegrasyonu ve modül enjeksiyonu.
- Düz `git push` (force yok) değişmedi: `auto`'da sorar, `full`'da izinli.
- Broker: soru etkileşimli konuşmada eylem kartıdır; headless broker `unavailable` ile reddeder (exit 3).
- Kanıt: `src/harness/policy/engine.ts` (`liftByPermission`, `DecisionBuilder.destructive`), `tests/harness-policy-permission-modes.test.ts` ("destructive commands ask in every interactive mode…").

## Alternatives

- **Her plan için zorunlu kullanıcı onayı:** Ürün sahibinin otonom çalışma kararına aykırı; trivial işte gereksiz onay. Reddedildi.
- **Onayı tamamen kaldırmak (rail'siz):** Yıkıcı eylem ve kapsam dışı yazma riski. Reddedildi.
- **Otonom modda dış yazma için prompt:** Otonom modun anlamını bozar; allowlist veya ret seçildi.

## Consequences

- Güvenlik prompt yorgunluğuna değil, testle kanıtlanan rail'lere dayanır.
- Otonom modda yanlış yetki verme ölçümü (hedef sıfır) doğrudan rail testlerine bağlanır ([doğrulama](../delivery/verification.md)).
- `current-state.md`'deki "onay tekrarı" gerilimi bu kararla kapanır.

## Evidence

- `src/harness/contracts/policy.ts` (`POLICY_MODES`, `DEFAULT_POLICY_MODE`, `HARD_RAILS`, `effectivePolicySchema`, `approvalDecisionSchema`, `HUMAN_ONLY_APPROVAL_SUBJECTS`).
- [Araçlar ve güvenlik](../design/tools-and-security.md), [orkestrasyon sözleşmeleri](../design/orchestration-contracts.md) "Rol yetkileri".
- Sözleşme: [policy ve onay](../contracts/policy-and-approval.md).

## Verification

- `tests/harness-contracts.test.ts`: otonom modda `ask` etkisinin reddi; allowlist'siz dış yazma izninin reddi; orchestrator'ın `ask` modunda onay verememesi; orchestrator'ın `provider-change`/`budget` onaylayamaması; rail'li kararın `deny` dışı olamaması.
- I3: her hard rail için negatif test (otonom ve ask modunda), prompt injection ile yükseltme denemesi.
- `tests/harness-security-trust.test.ts`, `tests/harness-e2e-trust.test.ts`: SEC-N1 (güven kapısı, `workspace-trust` insan-yalnız, headless exit 3), SEC-N2 (git'in dışarıyı okuması), SEC-N3 (işçi git entegrasyonu), SEC-N5 (doğrulama komutu olarak satır içi kod).

## Revisit trigger

Otonom modda bir yanlış yetki olayının gözlenmesi, ekip/CI kullanıcıları için farklı varsayılan talebi, yeni bir yıkıcı eylem sınıfı.

## 2026-09-24 owner revision — Claude Code native mode

Gerekçe: ürün sahibi Claude Code'u altyapı olarak kullanmak istiyor ([ADR-05](./ADR-05-provider-auth.md) native mode revizyonu); yerleşik araçları kapatıp aynılarını MCP üzerinden yeniden yazmak pahalı ve Claude'un yeteneklerini kısıtlıyor. Karar yetkisi yine Synorch'ta kalır:

- **İzin modu eşlemesi** (Claude `--permission-mode`, `claude --help` 2.1.282 ile doğrulandı): `ask` → `manual` (Claude'un varsayılan modu; 2.1.x'te `default` adı kabul edilmiyor), `auto` → `acceptEdits`, `full` → `bypassPermissions`, `plan` → `plan`. Headless (izin modu yok): `manual` ve her istem Synorch'un headless broker'ına düşer ve reddedilir (fail closed). Mod her Claude süreci başlarken okunur; Shift+Tab / `/permissions` sonraki adımda geçerli olur.
- **İstemler bizim onay arayüzümüze gelir**: `--permission-prompt-tool mcp__synorch__approve`; araç Claude Code'un belgelenmiş sözleşmesini izler (girdi `{tool_name, input, tool_use_id?}`, çıktı metin JSON `{behavior:"allow", updatedInput}` veya `{behavior:"deny", message}`). Yerleşik bir araç için karar oturumun onay broker'ına gider: gateway'in kullandığı aynı eylem kartı (`subject_kind: action`; etki `claudeToolEffect(name)` ile tek yerde eşlenir: Bash → `exec` ve komut kelimeleri, Edit/Write/MultiEdit/NotebookEdit → `workspace-write`, WebFetch/WebSearch ve diğerleri → `read`), `approval/requested` + `approval/decided` olarak turun günlüğüne yazılır. `full` her şeye izin verir (Claude zaten sormaz); `plan` Bash/düzenleme/ExitPlanMode'u reddeder; `auto` düzenlemeleri kabul eder; geri kalanı sorar.
- **"Always allow <prefix>"**: Bash kartındaki kalıcı izin, konuşma broker'ı tarafından komut izin deposuna (`command-grants.json`, kullanıcı kapsamı) yazılır ve sonraki Claude Bash istemlerinde de uygulanır (öneki eşleşen ve kabuk sözdizimi (`;`, `&`, `|`, `$`, ters tırnak, `<`, `>`, parantez, süslü parantez, satır sonu) içermeyen komut sorulmadan izinli; `decided_by: config` ile denetlenir). Önekler yalnız `session` rolü için geçerlidir.
- **Yalıtım ve bütünlük Synorch'ta kalır**: worker'larda `cwd` attempt worktree'sidir; değişen yollar araç olaylarından değil worktree diff'inden (`workspace.changeSet()`) hesaplanır ve yalnız sahip olunan yollar entegre edilir; doğrulama komutlarını harness kendisi çalıştırır; bağımsız review değişmez.

**Kalan risk**: Claude'un yerleşik araçları bizim `exec` allowlist'imizden, sandbox runner'ımızdan ve sır sızdırma raylarımızdan (`credential-in-arguments`, redaksiyon, hard rail'ler) **geçmez**; Bash kullanıcının yetkileriyle ve Synorch sandbox'ı dışında çalışır, WebFetch/WebSearch ağ politikamıza tabi değildir, `full` modunda Claude hiç sormaz. Azaltımlar: Claude izin modları + bizim izin istem aracımız (ask/auto'da her komut ve dış okuma kullanıcıya sorulur; headless reddeder), worker'larda worktree yalıtımı, sahip olunan yol entegrasyonu (diff'e dayalı), harness'in çalıştırdığı doğrulama, bağımsız review ve her yerleşik araç kullanımının `backend/tool_observed` ile denetim kaydı. Bu riski kabul etmeyen kullanıcı `claude_code.mode: restricted` seçer.

## 2026-09-24 owner revision 3 — `auto` = otonom

Gerekçe (ürün sahibi): Opus'la web araması MCP üzerinden her site ve her eylem için tekrar tekrar izin istedi; `auto` her şeyi sormamalı, model neyin izin gerektirdiğine kendisi karar verebilir; kullanıcı allowlist güncellemek istemiyor. Bu bölüm önceki revizyonların üzerine eklenir (hiçbirini silmez); çelişkide bu bölüm geçerlidir.

- **Synorch `auto` (Claude Code auto benzeri)**: çalışma alanında her düzenleme, her komut (allowlist istemi yok; `exec-not-allowlisted`, `workspace-untrusted`, `network-denied`, `host-not-allowlisted` gibi kaldırılabilir retler `auto`'da **izne** dönüşür), kurulumlar, arka plan süreçleri, herhangi bir genel alan adına `web_search`/`web_fetch` (alan adı başına istem yok). Sessiz hard rail'ler aynen kalır: SSRF/özel IP engeli, sır sızdırma (`secret-egress`), ayrılmış yollar, kimlik depoları, policy kaynakları, çalışma alanı dışına yazma (`write-outside-scope`, istem değil ret), git entegrasyon alt komutları ve modül enjeksiyonu.
- **`auto`'da yalnız sorulanlar**: yıkıcı komut kuralları (force push, geçmiş yeniden yazma, `git reset --hard`/`clean -f`/değişiklik atma, publish/registry push, çalışma alanı kökünün veya dışının özyinelemeli silinmesi, ayrıcalık yükseltme, uzak betik çalıştırma …); dışa dönük yazmalar (`external-write`: HTTP yazma, `gh` yazma, uzak kopya, bulut yazma, deploy); düz `git push` oturum başına **bir kez** sorulur, kullanıcı onaylayınca oturumun geri kalanında sorulmaz (`PolicyEngineOptions.gitPushApproved`, `Runtime.approveGitPushForSession`); web okumasından sonraki dışa dönük eylem kalkanı (`web-content-shield`) yalnız dışa dönük yazmalar için korunur.
- **Güven**: `auto` (full gibi) çalışma alanına bu oturum için güvenir, **hiçbir şey kaydetmez** ve soru sormaz; ilk komutta tek satır bildirim gösterilir (`Auto mode: trusting this folder for this session …`). `ask` modu ilk depo kodu komutunda güven sorusunu sormaya devam eder. `/trust` kalıcılaştırır.
- **`ask`** bugünkü gibi sorar; **`full`** hiç sormaz (yıkıcı komut kartı ve hard rail'ler aynen); **`plan`** salt okunur, yeni alan adında sorar. "Always allow" ve `/allow` çalışmaya devam eder, ama `auto`'da nadiren gerekir.
- **Claude Code native eşlemesi**: `auto` → Claude'un kendi `auto` izin modu (`acceptEdits` değil; gerçek CLI'nin `system/init` olayı `permissionMode: auto` bildirir, `claude --help` 2.1.282 seçenekleri: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`). Claude'un sınıflandırıcısı karar verir; yalnız onun yükselttikleri Synorch kartına gelir; `auto`'da WebSearch/WebFetch her alan adı için sorulmadan izinlidir (sır sızdırma reddi kalır). `full` → `bypassPermissions`, `ask` → `manual`, `plan` → `plan`.
- **Çift web aracı yok**: native modda Synorch'un `web_search`/`web_fetch` araçları MCP köprüsünde sunulmaz (`NATIVE_DUPLICATE_TOOLS`, `core/driver.ts`); Claude'un yerleşik WebSearch/WebFetch'i tek web aracıdır. OpenAI rotalarında barındırılan `web_search` açıkken Synorch'un `web_search`'ü istekten çıkarılır (`providers/responses.ts`, değişmedi).

Doğrulama: `tests/harness-policy-permission-modes.test.ts` (auto otonom; git push oturumda bir kez; kalkan), `tests/harness-e2e-permission-modes.test.ts` (auto istemsiz çalışır, güven bildirimi, `trust.json` yazılmaz; ask "Always allow" akışı), `tests/harness-web-fetch.test.ts`, `tests/harness-claude-native.test.ts`.

### 2026-09-25 ek — revizyon 3 işçilere de uygulanır

Gerekçe (ürün sahibi, ekran görüntüsü): `auto` modunda bir orkestrasyon işçisi (implementer) `npm create vite@latest . -- --template react` komutunu "sandbox allowlist" nedeniyle çalıştıramadı ve oturum kullanıcıya `/allow npm create` yazmasını söyledi. "Allowlist yönetmek istemiyorum; bu olmamalı." Revizyon 3 yalnız `session` rolüne uygulanmıştı. Bu ek önceki bölümleri silmez.

- **İşçiler oturumun izin modunu izler**: `implementer`/`debugger` (yazma kapsamı olan) `auto` ve `full`'u motordan miras alır (`PolicyEngineOptions.permissionMode`; `EffectivePolicy.permission_mode`, şema `session` dışında `auto`/`full` kabul eder). `auto`'da worktree içinde her komut (kurulum, iskele CLI'ları, build, test, dev sunucusu) allowlist reddi ve istem olmadan çalışır; `exec_confinement` `auto`/`full`'da bilgi amaçlıdır (kaldırılabilir retler `permission-auto` ile izne döner). `ask`, `plan`, headless ve salt-okur roller (explorer, reviewer, rca-only debugger) ile orchestrator eski varsayılan-ret allowlist'ini korur.
- **İstemler kullanıcıya gider**: işçide `auto`'da sorulanlar (yıkıcı komut kuralları — force push, publish, çalışma alanı dışı silme —, dışa dönük yazmalar, ilk uzak push) etkileşimli oturumda kullanıcının onay arayüzüne yönlenir (`Runtime.brokerFor`: izin modu varken etkileşimli broker); headless'ta açık mesajla ret.
- **Güven**: `auto`/`full` oturum güveni işçileri de kapsar (motorun `workspaceTrusted` kaynağı oturumun etkin güvenidir); işçi düzeyinde güven reddi yok.
- **`/allow` önerisi**: yalnız konuşma ajanının kendi kısmi-sandbox allowlist reddinde önerilir; işçi reddinde, hard rail'de ve `auto`/`full`'da önerilmez — ret nedeni açıklanır (`transparency.ts`, `conversation-view.ts`, `harness:session` yönergesi).
- **Plan zamanı doğrulama ön kontrolü** aynı motoru kullandığından aynı semantiği izler: `auto`/`full`'da allowlist dışı komut planı reddettirmez.
- Hard rail'ler (git entegrasyon alt komutları, bağlı bağımlılık dizinli worktree'de bağımlılık değişikliği, modül enjeksiyonu, ayrılmış yollar, kapsam dışı yazma) her modda aynen kalır.

Doğrulama: `tests/harness-policy-permission-modes.test.ts` ("workers follow the session's auto mode").
