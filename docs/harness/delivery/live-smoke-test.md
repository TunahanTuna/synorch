# Canlı smoke test: gerçek hesaplarla Windows doğrulaması

> Durum: runbook, 2026-09-23. Hedef kişi: ürün sahibi. Hedef ortam: Windows 11, Windows Terminal (PowerShell 7) ve bir kez klasik conhost (cmd.exe), Node `>=24`. Otomatik kanıtın kapsamı ve açık kalanlar: [Faz 1–2 kapanış kaydı](./milestones/phase-1-2.md). Komut başvurusu: [CLI başvurusu](../reference/cli.md), [sağlayıcılar ve kimlik](../reference/providers-and-auth.md). TUI kontrol listesinin tamamı: [çapraz platform kontrol listesi](../research/tui/cross-platform-checklist.md).

Otomatik testler model yanıtlarını scripted adapter'dan alır; gerçek OAuth, gerçek uç noktalar ve gerçek terminal hiç denenmedi. Bu runbook o boşluğu gerçek hesaplarla ve atılabilir bir depoda kapatmak içindir. Her adımda **beklenen** çıktı ve **başarısızlıkta toplanacaklar** yazılıdır. Adımlar sırayla yapılır; bir adım başarısız olursa not alın ve devam edebiliyorsanız devam edin.

## 0. Önce okuyun: güven ve risk

- Windows'ta Synorch'un süreç düzeyinde sandbox'ı **yoktur** (`doctor --runtime` → `sandbox: policy-only, enforcement partial`). Bir çalışma alanına güvendiğinizde o deponun test/build betikleri **ve oturum sırasında yapay zekânın yazdığı her kod** sizin kullanıcı izinlerinizle çalışır; çalışma alanı dışındaki dosyalara, **Synorch kimlik bilgileriniz dahil**, erişebilir.
- Bu yüzden smoke test yalnız bu runbook için oluşturduğunuz **atılabilir bir depoda** yapılır. Gerçek bir iş deposunda "Trust this workspace" seçmeyin.
- Kimlik bilgileri Windows'ta DPAPI ile şifrelenmiş olarak `%USERPROFILE%\.synorch` altında durur (`SYNORCH_HOME` ile değiştirilebilir). Hiçbir adım token'ı ekrana yazdırmaz; ekran görüntüsü veya log paylaşırken yine de URL'lerdeki `code=` ve `state=` parametrelerini karartın.

## 1. Hazırlık

```powershell
cd <synorch-deposu>
git switch harness
pnpm install --frozen-lockfile
pnpm build
function syn { node "<synorch-deposu>\dist\cli.js" @args }   # bu PowerShell oturumu için
syn --version
```

Beklenen: sürüm satırı, hata yok.

Atılabilir depo:

```powershell
mkdir C:\temp\syn-smoke; cd C:\temp\syn-smoke
git init
Set-Content README.md "# syn smoke`n"
Set-Content src-add.mjs "export function add(a, b) {`n  return a - b;`n}`n"
Set-Content check.mjs "import { add } from './src-add.mjs';`nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }`nconsole.log('ok');`n"
Set-Content package.json '{ "type": "module" }'
git add -A; git commit -m "smoke fixture"
syn init
git add -A; git commit -m "syn init"
```

Beklenen: `syn init` `.ai/` yapısını ve sağlayıcı giriş dosyalarını oluşturur; var olan farklı dosyaların üzerine yazmaz.

Toplanacaklar (başarısızlıkta): komutun tam çıktısı, `node --version`, `git --version`.

## 2. `syn doctor --runtime`

```powershell
syn doctor --runtime
syn doctor --runtime --json > doctor.json
```

Beklenen (kimlik bağlanmadan önce):

- `OK node`, `OK store` (home yazılabilir, dayanıklı flush).
- `OK canonical` veya `WARN canonical`: `syn init` sonrası `.ai/` bu depodan okunur; geri dönüş varsa hangi parçanın yerleşik varsayılandan geldiği yazar.
- `WARN sandbox  policy-only: enforcement partial …` — Windows'ta beklenen.
- `WARN trust  workspace not trusted …; run syn trust`.
- `WARN auth  0 of 4 identities connected (credential store os-dpapi)`.
- `WARN capabilities  … no route for orchestrator …` — route henüz yok.
- Son satır: `No network request was made …`.

Toplanacaklar: `doctor.json` (sır içermez), terminal türü (Windows Terminal/conhost).

## 3. OpenAI (ChatGPT aboneliği) girişi

### 3a. Tarayıcı PKCE

```powershell
syn login openai
```

Beklenen: bir URL basılır ve varsayılan tarayıcı açılır (`auth.openai.com`). Giriş sonrası tarayıcı yerel geri dönüş sayfasını gösterir; terminal bağlandığını yazar, exit 0. Port meşgulse komut otomatik olarak device-code akışına geçer.

### 3b. Device code

```powershell
syn logout openai --method oauth-subscription
syn login openai --device-code
```

Beklenen: `https://auth.openai.com/codex/device` adresi ve bir kullanıcı kodu gösterilir. Kodu tarayıcıda girin; terminal birkaç saniye içinde bağlandığını yazar. 15 dakika içinde onaylanmazsa zaman aşımı hatası beklenir.

### 3c. Durum

```powershell
syn auth status
syn auth status --json
```

Beklenen: `openai/oauth-subscription · profile default · connected · store os-dpapi` (veya benzeri); token, e-posta dışındaki kimlik bilgisi veya sır **görünmez**.

Toplanacaklar (başarısızlıkta): terminal çıktısı (URL'deki `code`/`state` karartılmış), tarayıcıdaki hata sayfasının metni, `syn auth status --json`.

## 4. Anthropic köprüsü (`cli-bridge`, deneysel)

Önkoşul: Claude Code kurulu ve Claude aboneliğinizle `claude` içinde giriş yapılmış.

```powershell
syn login anthropic --method cli-bridge
```

Beklenen: **tek seferlik** `claude-bridge-experimental` bildirimi; açıkça onaylamanız istenir ("I understand, continue" / düz modda onay sorusu). Onaydan sonra exit 0. Komutu ikinci kez çalıştırın: bildirim **tekrar gösterilmemeli** (profil başına bir kez).

```powershell
syn auth status
```

Beklenen: `anthropic/cli-bridge · profile default · connected …` ve Claude Code sürümü. Köprü abonelik girişi dışındaki bir kimlik kaynağı bildirirse tur `forbidden` ile reddedilir; bu beklenen korumadır.

Toplanacaklar: bildirim metni, ikinci çalıştırmanın çıktısı, `claude --version`.

## 5. Route yapılandırması

`%USERPROFILE%\.synorch\config.yaml` (yalnız kullanıcı katmanı route seçebilir; depo içindeki `.synorch/config.yaml` route'ları yok sayılır):

```yaml
routes:
  - { tier: orchestrator, provider: openai, model: <orchestrator-modeli> }
  - { tier: complex_worker, provider: openai, model: <worker-modeli> }
  - { tier: fast_worker, provider: openai, model: <hızlı-model> }
  # isteğe bağlı: reviewer'ı Claude köprüsüne yönlendirmek için
  # - { tier: complex_worker, role: reviewer, provider: anthropic, model: <claude-modeli>, adapter: claude-code }
# adapters:
#   - { id: claude-code, kind: claude-code }
```

Model adlarını uydurmayın: `syn doctor --runtime`'ın `canonical` satırındaki model profil ipuçlarını veya hesabınızda görünen model adlarını kullanın.

```powershell
syn doctor --runtime
syn doctor --runtime --probe-model
```

Beklenen: `capabilities` artık `OK`; `--probe-model` route başına **tek** gerçek istek atar ve sonucunu yazar.

Toplanacaklar: `config.yaml` (sır içermez), `--probe-model` çıktısı.

## 6. Çalışma alanı güveni (`syn trust`)

Önce güven olmadan headless bir run'ın durduğunu görün:

```powershell
syn run "Fix add() so check.mjs passes; verify with: node check.mjs" --mode jsonl > untrusted.jsonl
$LASTEXITCODE
```

Beklenen: exit **3**; `untrusted.jsonl`'in ilk satırı `hello`, son satırı `error` (`approval_unavailable`, mesaj "workspace trust unavailable …", `next_command: syn trust …`); hiçbir `attempt/started` olayı yok; `src-add.mjs` değişmemiş. (Model planında doğrulama komutu koymazsa bu adım bu şekilde durmaz; o durumda çıktıyı not alın.)

Sonra güvenin:

```powershell
syn trust
```

Beklenen: `Trusted C:\temp\syn-smoke (…) in …\trust.json.` ve şu uyarı: güvenilen çalışma alanında test/build betikleri ve oturumda yapay zekânın yazdığı kod kullanıcı izinlerinizle çalışır, Synorch kimlik bilgileriniz dahil çalışma alanı dışındaki dosyalara erişebilir, çünkü bu platformda sandbox tam değildir. Son satır: `Revoke with: syn trust --revoke`. `syn doctor --runtime` → `OK trust workspace trusted (store) …`.

Toplanacaklar: `untrusted.jsonl`, `syn trust` çıktısı.

## 7. Küçük bir `syn run`

```powershell
syn run "Fix add() so check.mjs passes; verify with: node check.mjs"
$LASTEXITCODE
git diff
node check.mjs
```

Beklenen: plan → (autonomous'ta denetlenen öz-onay satırı) → worker → `node check.mjs` doğrulaması → trivial değilse bağımsız review → integrate → görev raporu; exit 0; `git diff` yalnız `src-add.mjs`'te `a - b` → `a + b` değişikliğini gösterir; `node check.mjs` → `ok`. Özette run kimliği (`run_…`) yazar.

Toplanacaklar (başarısızlıkta): tam terminal çıktısı, exit code, `syn runs` çıktısı.

## 8. `syn show <run>` ve `syn runs`

```powershell
syn runs
syn show <run_kimliği>
syn show <run_kimliği> --json > show.json
```

Beklenen: plan, görevler, attempt'ler (rol, route, izolasyon, oturum, durum), onaylar, kriter → kanıt bağları (`tool-call:call_…`, `test-run`), review kararı, route kararları ve usage. `trust/used` kaydı (`source: store`) run günlüğündedir.

Toplanacaklar: `show.json`.

## 9. `syn memory status`

```powershell
syn memory status
```

Beklenen: bellek kökü, not sayıları ve inceleme bekleyen öneriler; hata yok. İlk kullanımda boş bir durum normaldir.

## 10. `syn agent` etkileşimli TUI kontrolleri

Windows Terminal (PowerShell 7) içinde; yalnız P0 maddeleri. Her maddeyi geçti/kaldı olarak işaretleyin. Bir kez de klasik conhost'ta (`conhost.exe cmd.exe`) 10a, 10b ve 10e'yi tekrarlayın.

Güven sorusunu da görmek için önce güveni geri alın: `syn trust --revoke`.

```powershell
syn agent
```

**10a. Güven sorusu.** İlk mesajdan önce "Trust this workspace?" diyaloğu açılır. Beklenen: üç seçenek sırasıyla **Not now** (önceden seçili), **Trust for this session only**, **Trust this workspace**; metin yapay zekânın yazdığı kodun ve kimlik bilgilerine erişimin riskini söyler. "Allow once" görünmemeli. Aşağı okla **Trust for this session only**'yi seçin → uyarı satırı "trusted … for this session only (not saved)". Oturum sonunda `syn doctor --runtime` yine `WARN trust` göstermeli (kalıcı değil).

**10b. Başlatma ve kapanış (D1).** Açılışta imleç ve editör görünür. `/exit` ile, sonra yeni bir oturumda Ctrl+C ×2 ile çıkın. Beklenen: kabuk bozulmaz (yazdığınız karakterler görünür, renkler normal), `Session saved: ses_…` stderr'de.

**10c. Klavye (D2).** Bir mesaj yazıp Enter → gönderilir; Shift+Enter → yeni satır (çalışmıyorsa not alın). Stream sırasında Ctrl+C → istek iptal edilir, boşta ikinci Ctrl+C güvenli çıkış sorar. Esc tek basışta iptal eder. Ok tuşları, Home/End, Ctrl+Backspace kelime silme. Türkçe `ğüşıöç İ` ve AltGr ile `@ { [` karakter olarak gelir.

**10d. Yapıştırma (D3).** 1 satırlık ve ~500 satırlık metni Ctrl+V ve sağ tıkla yapıştırın. Beklenen: satır sonları göndermeyi tetiklemez; büyük yapıştırma tek parça gelir.

**10e. Render ve resize (D4, D6).** Uzun bir yanıt akarken pencereyi daraltıp genişletin: taşma veya bozuk çizgi yok. Model çıktısındaki kod bloğu ve tablo okunur. `$env:NO_COLOR=1; syn agent` → renk yok.

**10f. Oturum içi komutlar.** `/help`, `/plan`, `/tasks`, `/evidence`, `/diff`, `/cancel` (run sürerken) yanıt verir.

**10g. Resume.** `syn agent --resume <ses_…>` → önceki transcript görünür, viewport son satırdadır.

Toplanacaklar (başarısızlıkta): ekran görüntüsü, terminal türü ve sürümü (`$PSVersionTable`, Windows Terminal "About"), klavye düzeni, `syn doctor --runtime --json`, ilgili oturumun kimliği (`ses_…`).

## 11. Başarısızlıkta genel olarak toplanacaklar

- Komut, tam çıktı (stdout ve stderr ayrı ise ikisi de), `$LASTEXITCODE`.
- `syn doctor --runtime --json` ve `syn auth status --json` (ikisi de sır içermez).
- Run veya oturum kimliği; gerekirse `syn show <id> --json`. Ham oturum günlükleri `%USERPROFILE%\.synorch\sessions\<project-id>\<session-id>\` altındadır; paylaşmadan önce içlerinde kişisel veri olup olmadığını kontrol edin (günlükler redakte edilir ama model metni ve dosya içerikleri bulunabilir).
- Terminal türü ve sürümü, Node sürümü, Windows sürümü.

## 12. Geri alma ve temizlik

```powershell
cd C:\temp\syn-smoke
syn trust --revoke            # "Revoked trust for …" veya "… was not trusted; nothing to revoke."
syn logout openai
syn logout anthropic
syn auth status               # hepsi disconnected / login_required
```

İsteğe bağlı: `%USERPROFILE%\.synorch\config.yaml` içindeki route'ları silin, `C:\temp\syn-smoke` dizinini kaldırın. OpenAI tarafında bağlı uygulama oturumunu hesap ayarlarından da sonlandırabilirsiniz; Claude Code girişi `claude` içinden ayrıca yönetilir (`syn logout anthropic` yalnız köprü opt-in'ini ve Synorch tarafındaki kaydı kaldırır).
