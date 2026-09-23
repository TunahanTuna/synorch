# ADR-19: Çalışma alanı sadakati — tek digest şeması, izolasyon ve integrate

## Status

Accepted. Kısmen değiştirir (Supersedes, kısmen): [ADR-07](./ADR-07-worker-isolation.md) — worktree oluşturma yedeği, yeniden kullanım, overlay, bağımlılık bağlantıları, submodule ve integrate çakışma tespiti.

## Date

2026-09-23

## Context

İlk canlı çalıştırmanın ilk attempt'i bir ortam hatası yüzünden `needs_context` ile döndü ve tek retry'ı tüketti (Denetim A F4, Denetim B K1). Windows 11 + git 2.52 + global `core.autocrlf=true` üzerinde yapılan tekrar deneyleri sorunun genel olduğunu gösterdi:

- **İki digest şeması, iki ağaç (K1, B2).** Paket `context.sources`/`known_facts` `digestText` (UTF-8 çöz, CRLF→LF, sha256) ile **ana ağaçtan** hesaplanıyordu; yazma önkoşulu attempt çalışma alanının **ham baytları** üzerindeydi; `read_file` digest döndürmüyordu. `git worktree add` dosyaları CRLF yazınca paketteki her digest worktree'de yanlıştı; aynı uyuşmazlık diskte CRLF olan her dosyada scoped-dir modunda da oluştu.
- **Integrate yanlış çakışma (B1, kritik).** `before` HEAD blob'unun ham baytlarından, çakışma denetimi ana ağacın ham baytlarından yapıldı: autocrlf, smudge/clean filtresi ve Git LFS olan her depoda kullanıcının hiç dokunmadığı dosya için "integration conflict" üretti.
- **Worktree ana ağacın gördüğünü görmüyor (B3).** Kirli/izlenmeyen okuma girdileri worktree'de HEAD sürümündeydi veya yoktu; `node_modules`/`.venv` yoktu, doğrulama komutları bağımlılıksız çalıştı; uyarı yoktu.
- **Windows yolları ve dayanıklılık (B7, B8, B9).** `core.longpaths` olmadan uzun yollar worktree oluşturmayı bozdu; ham `GitCommandError` görevi scoped-dir yedeği olmadan durdurdu ve öksüz `<attempt>.owner.json` bıraktı. Submodule dizini worktree'de boştu, içine yazılan iş `changes: []` ile kayboldu. 20k dosyalı depoda her retry/revizyon için worktree oluşturma 8 s + silme 2.9 s sürdü.
- **Unicode ve büyük/küçük harf (B11).** NFD oluşturulmuş dosya NFC owned path ile `outside-owned` reddedildi; yazma kapsamı büyük/küçük harfe duyarlı, izolasyon eşleştiricisi duyarsızdı; darwin ve win32 farklı ele alındı.
- **Bayt düzeyi normalizasyon eksik (B10, B12).** `digestText` cp1254 `sş`/`sğ` ve `0xFF`/`0xFE` baytlarını aynı digest'e indirdi; freshness gerçek düzenlemeleri kaçırdı.

## Decision

**Tek çalışma alanı digest şeması: `workspace-raw-v1`.**

- `workspaceDigest(bytes)` = dosyanın **bir çalışma alanı kökündeki ham baytlarının** SHA-256'sı (`sha256:<64 hex>`); kod çözme, EOL katlama, BOM ayıklama, filtre yok. Modele görünen her dosya digest'i bununla hesaplanır: paket `sources`/`known_facts`, `read_file` başlığı ve `ToolResult.digest`, `write_file`/`apply_patch` önkoşulu, completion `changed_paths` before/after, `AttemptFileLedger`.
- Her digest **modelin çalıştığı çalışma alanında** hesaplanır: izolasyon önce açılır, paket kaynakları `IsolatedWorkspace.digest` ile attempt kökünde hesaplanır (`context.digest_scheme: workspace-raw-v1`), sonra paket yayımlanır. İki farklı ağacın `workspaceDigest`'i hiçbir zaman karşılaştırılmaz.
- Gerekçe: tek saf fonksiyon (`contracts/digest.ts`), git gerektirmez, her araçta süreç başlatmadan hesaplanır (tools modülü orchestration'a bağımlı olmadan kullanabilir), izlenmeyen ve git dışı dosyalarda da aynıdır ve önkoşul semantiği kesindir (EOL dönüşümü dahil her bayt değişikliğini görür). `git hash-object --path` tabanlı tek şema değerlendirildi: her okuma/yazma için git süreci ister, izlenmeyen/git dışı dosyada ikinci bir şemaya düşer ve EOL-only değişikliği önkoşulda görünmez kılar.
- Ağaçlar arası karşılaştırma bir digest değil **`ContentIdentity`**'dir: git'in izlediği (ignore edilmeyen) dosya için `git hash-object --path=<p>` blob kimliği (o ağacın clean filtresi ve EOL dönüşümü uygulanmış; değişmemiş checkout her ağaçta HEAD blob'una eşittir), diğerleri için `workspaceDigest`. Farklı şemalar asla eşit sayılmaz (`sameContent`). Yalnız izolasyon integrate/çakışma tespitinde kullanılır; modele veya pakete yazılmaz.
- `digestText` yalnız statik observation ledger, hafıza `source_digest` ve ADR-19 öncesi paketler (`text-lf-v1`, yalnız okunur) için kalır.

**İzolasyon ve integrate (ADR-07'yi değiştirir).**

- Integrate çakışmayı `ContentIdentity` ile saptar: ana ağaçtaki dosyanın kimliği HEAD blob'una veya kaydedilen after-blob'a eşitse çakışma yoktur. Yazılan içerik ana ağacın gösterimine çevrilir (worktree'de clean → ana ağaç için smudge/EOL; en azından ana dosyanın EOL'u korunur).
- Ana ağaçta kirli veya izlenmeyen okuma girdileri (paketin read_paths'i ve alıntılanan kaynaklar) worktree'ye **overlay** edilir, taban kaydında `ours` gibi işaretlenir ve asla integrate edilmez; sahip olunan yollar overlay edilmez.
- Git'in ignore ettiği bağımlılık dizinleri (`DEPENDENCY_LINK_DIRECTORIES`: `node_modules`, `.venv`, `venv`, `.tox`) ana ağaçta varsa ve hiçbir owned path ile örtüşmüyorsa worktree'ye junction/symlink ile bağlanır. Bağlı dizinler attempt policy'sinde `forbidden`'a eklenir: policy modelinde yalnız-yazma yasağı yoktur ve bağlantıdan geçen yol zaten çalışma alanı dışına çözülür (`link-escape`), bu yüzden dosya araçları onları **ne okur ne yazar**; yalnız build/test süreçleri (exec) bağlantı üzerinden okur. Bağlantı varken bağımlılık kuran/ekleyen/kaldıran/güncelleyen komutlar (`npm/pnpm/yarn/bun install|add|remove|update|ci|…`, çıplak `yarn`, `pip install`, `python -m pip|venv`, `uv sync|add|pip install`, `poetry install`, `cargo fetch|add|update`, `go get|mod download`, `dotnet restore` …) hem worker `exec`'inde hem harness doğrulamasında reddedilir: `EffectivePolicy.dependency_links`, kod `dependency-mutation-in-linked-worktree` (hard rail `write-outside-scope`; kabuk ve önek sarmalayıcılarının içinden de; bağımsız inceleme 4, R3).
- `git -c core.longpaths=true worktree add` ve worktree yapılandırmasında `core.longpaths=true`; worktree yolu kısaltılır (hash tabanlı proje kimliği, kısa attempt kimliği). Worktree oluşturma başarısız olursa `high-risk` olmayan görev `scoped-dir`'e düşer (`fallback.reason`: `worktree-create-failed` | `path-too-long` | `git-unavailable`), hata `HarnessError`'a çevrilir ve öksüz worktree/owner dosyası kalmaz; `high-risk` yazan görev `sandbox_insufficient` ile durur.
- Submodule girişleri (mode 160000) saptanır ve kaydedilir; submodule içindeki owned path `create`'te açıkça reddedilir. Değişiklik adayları yalnız `git status`'tan değil owned path'lerin doğrudan taranmasından da toplanır.
- Aynı görevin retry/onarım/revizyon attempt'leri çalışma alanını **yeniden kullanır** (`IsolationCreateOptions.reuse`: tabana sıfırla + tohum artifact'ı uygula); çalışma alanı görev sonuçlanınca atılır. Scoped snapshot, owned path dışındaki ignore edilmiş dizinleri gezmez.
- Freshness kapısı ve ContextBuilder freshness denetimi paketin şemasıyla ve paketin hesaplandığı kökte okur (ana ağaç değil).

**Yol politikası.** Bütün yol karşılaştırmaları NFC'dir (`normalizePathUnicode`). `win32` ve `darwin` büyük/küçük harfe duyarsızdır (`CASE_INSENSITIVE_PLATFORMS`); duyarsız karşılaştırma yalnız `foldPathCase` ile yapılır: NFC + uzunluk koruyan, yerelden bağımsız kod noktası büyük harfe çevirme, Türkçe özel kuralı yok (`ı`→`I`, `i`→`I`, `İ` yalnız kendisi). NTFS'te olduğu gibi `şehir` ile `ŞEHİR` farklı adlardır; Denetim B'nin B11 beklentisi (`ŞEHİR` = `şehir`) bu yüzden düzeltilir — fikstür eşitliği değil, tüm denetimlerin **tutarlılığını** doğrular. Paylaşılan eşleştirici bu politikayı uygular; araçlar ve orchestration diskteki gerçek harf büyüklüğünü kapsam denetiminden önce çözer.

## Alternatives

- **Worktree'yi `core.autocrlf=false core.eol=lf` ile açmak:** Paket digest'lerini ana ağaçla eşitler ama kullanıcının Windows araçlarının beklediği CRLF'i bozar, doğrulama komutları farklı baytlarla çalışır ve filtre/LFS sorununu (B1) çözmez. Reddedildi.
- **Digest'leri EOL normalize ederek karşılaştırmak:** EOL-only değişikliği önkoşulda görünmez yapar (sessiz CRLF→LF, F17/B6), cp1254/UTF-16'da yanlış eşitlik (B10). Reddedildi.
- **Her karşılaştırmada `git hash-object`:** Tek şema olurdu ama her `read_file`/yazma için süreç maliyeti, git dışı ve izlenmeyen dosyalarda ikinci şemaya düşme. Reddedildi; git kimliği yalnız ağaçlar arası karşılaştırmada.
- **Kirli read_paths'te hep scoped-dir:** Kullanıcının çalışma ağacında yazmak ADR-07'nin geri alma güvencesini zayıflatır ve bağımlılık sorununu çözmez. Reddedildi; overlay tercih edildi (worktree kurulamazsa yedek scoped-dir).

## Consequences

- Paket, izolasyondan sonra yayımlanır; `attempt/started.packet_digest` son pakete bağlanır. Paket oluşturmanın izolasyonla sıralaması değişir.
- `attempt/started` v3 izolasyon ayrıntılarını (yeniden kullanım, yedek, overlay, bağlantılar, submodule) taşır; eski olaylar okunmaya devam eder.
- Bağımlılık bağlantıları worktree'den ana ağacın `node_modules`'una yazma yolu açar. Dosya araçları bağlantıya erişemez ve bağımlılık değiştiren komutlar reddedilir (R3). **Kalan risk:** güvenilen (trusted) bir build/test sürecinin bağlı dizinler altına yazdığı test/build önbellekleri (ör. `node_modules/.cache`, `.vite`, `.tox` ortamları, `__pycache__`) ana ağaca düşer; bunlar değişiklik kümesinin dışındadır, review edilmez ve geri alınmaz. Bu, güvenilen çalışma alanında kullanıcının yetkileriyle koşan build'in zaten sahip olduğu etkidir (SEC-N1, ADR-06); tam OS sandbox'ı veya bağlantı yerine kopya/salt okunur bağlama gelecekte kapatabilir. Bağlantı kaldırma güvenlidir: bağlantılar sıfırlama/kaldırmadan önce çözülür, Node `rm` bağlantının hedefine inmez.
- Yol katlama politikasının eşleştiriciye taşınması izin/ret kararlarını ASCII dışı adlarda değiştirebilir; ASCII davranışı aynıdır.

## Evidence

- Denetim B (`audit-b.md`, Windows 11, git 2.52.0.windows.1, autocrlf=true, git-lfs 3.7.1, Node 24.11.1): K1 kök nedeni (`k1.mjs`), B1 (`k1.mjs`, `s6.mjs`, `s8.mjs`), B2, B3 (`s2.mjs` D), B7 (`s4.mjs`), B8 (`s6.mjs`), B9 (`s5.mjs`), B10 (`s2.mjs` E), B11 (`s3.mjs`), B12; çürütülen hipotezler (`s7.mjs`, sparse checkout, NFC Türkçe yollar).
- Denetim A: F4 (packet digest'lerinin ana ağaçtan gelmesi, coordinator.ts:545-550), F5, F17; §5 "harness ortam hatası `needs_context` gibi görünüyor".
- Sözleşme: `src/harness/contracts/digest.ts` (`workspaceDigest`, `SOURCE_DIGEST_SCHEMES`, `ContentIdentity`, `sameContent`), `paths.ts` (`normalizePathUnicode`, `foldPathCase`, `CASE_INSENSITIVE_PLATFORMS`), `runtime.ts` (`IsolatedWorkspace.digest/reused/fallback/overlaid/dependencyLinks/submodules`, `IsolationCreateOptions.reuse/overlay`, `ISOLATION_FALLBACK_REASONS`, `DEPENDENCY_LINK_DIRECTORIES`, `WorkspaceDigestReader`), `packets.ts` (`context.digest_scheme`), `events.ts` (`attempt/started` v3), `tools.ts` (`ToolResult.digest`).
- Belgeler: [events-and-storage §7](../contracts/events-and-storage.md#7-digest), [runtime-seams §4, §10](../contracts/runtime-seams.md).

## Verification

- `tests/harness-contracts.test.ts`: `workspaceDigest` ham bayt, EOL değişikliği farklı digest; `digestText` ledger davranışı değişmedi; `sameContent` şemalar arası eşitlik vermez; `attempt/started` v3 alanları ve v2'de reddi; NFC eşleşme, `foldPathCase` (`ı`/`İ`/`ß`), platform duyarlılığı.
- Bağımsız inceleme 4 (R3): `tests/harness-security-policy.test.ts` (bağlantı varken kurulum/ekleme/güncelleme komutları her sandbox'ta ve sarmalayıcılar içinden reddedilir; bağlantı yokken olağan kurallar), `tests/harness-e2e-dependency-links.test.ts` (worker'ın `pnpm install`'ı ve aynı harness doğrulama komutu `dependency-mutation-in-linked-worktree` ile reddedilir).
- W1b kabul ölçütleri ve W2'deki 11 Windows/git fikstürü ([uygulama planı §7](../implementation-plan.md#7-canlı-çalıştırma-sağlamlaştırma-dalgası)).

## Revisit trigger

Worktree yeniden kullanımının sıfırlamada kullanıcı verisi kaybettiği bir vaka; `hash-object` maliyetinin integrate'te büyük change set'lerde kabul edilemez olması; bağımlılık bağlantısının ana ağacı değiştirdiği bir doğrulama komutu; macOS'ta NFD/katlama politikasının APFS ile uyuşmadığı bir ad.
