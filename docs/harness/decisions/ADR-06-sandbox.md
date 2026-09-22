# ADR-06: Sandbox tabanı

## Status

Accepted

## Date

2026-09-22

## Context

Policy, approval ve sandbox ayrı kavramlardır; approval paterni process sandbox yerine geçmez ([araçlar ve güvenlik](../design/tools-and-security.md), [karşılaştırma](../research/comparison.md)). Platformlar arasında gerçek OS enforcement farklıdır; `partial` koruma açıkça raporlanmalıdır.

## Decision

- v1 enforcement'ın birinci katmanı `ToolGateway` içindeki policy uygulamasıdır: eylem anında lexical normalize + `realpath`/junction/symlink çözümü, argv tabanlı yıkıcı komut sınıflandırması, cwd'nin çalışma alanına hapsedilmesi, env temizliği, çıktı üst sınırları, timeout ve iptal.
- İkinci katman OS backend'idir; `SandboxRunner.probe()` sonucu `full | partial | unavailable` raporlar:
  - Linux: `bubblewrap` varsa kullanılır.
  - macOS: `sandbox-exec` varsa kullanılır.
  - Windows: v1'de `partial` (job object/AppContainer sonraki sürüm).
- `partial` durumu TUI başlığında, JSONL `tool/execution_started.sandbox_enforcement` alanında ve `doctor --runtime` çıktısında görünür.
- `require_full_sandbox` işaretli görev, enforcement `full` değilse `workspace-write` ve `exec` etkileri `deny` alır ve durur.
- Probe hatası fail-closed davranır: backend `unavailable` sayılır.

### Değişiklik (2026-09-23): tam olmayan sandbox'ta neyin sınırlandığı, neyin sınırlanmadığı

Dürüst sınır: enforcement `full` değilken (bugün Windows'ta her zaman) **policy katmanı yalnız harness'in kendi araçlarını sınırlar.** `write_file`, `edit`, `delete` gibi araçların kapsam dışı yazması `write-outside-scope` rail'iyle reddedilir; ancak bir exec komutunun başlattığı process'in ne yaptığı sınırlanamaz. İzin verilen bir build/test veya doğrulama komutu (`pnpm test`, `node --test`, `tsc`, `cargo test`, planın doğrulama komutları) **deponun kodunu kullanıcının izinleriyle çalıştırır**; o kod çalışma alanı dışına yazabilir, ağa çıkabilir, credential okuyabilir.

- Bu yüzden tam olmayan sandbox'ta depo kodunu çalıştıran komutlar **çalışma alanı güveni** ister (SEC-N1): kullanıcı çalışma alanına bir kez, yalnız kullanıcı kapsamında (`<synorch home>/trust.json`; kanonik kök + depo kimliği) güvenir — `syn trust`, etkileşimli tek seferlik soru ("This workspace's tests and build scripts will run with your user permissions; Synorch cannot confine them on this platform") veya tek run için `--trust-workspace`. Güvenilmeyen çalışma alanında `autonomous` mod bu komutları `workspace-untrusted` ile reddeder, `ask` modu sorar, headless run exit 3 ile durur. Depo içeriği güven veremez. Ayrıntı: [policy ve onay §4](../contracts/policy-and-approval.md#4-effectivepolicy-alanları).
- Güvenden bağımsız olarak `node --test`'e modül/yapılandırma enjekte eden seçenekler (`--import`, `--require`/`-r`, `--loader`, `--experimental-loader`, `--env-file`, `--test-global-setup`, yerleşik olmayan reporter, dışarıyı gösteren `--test-reporter-destination`), git'in çalışma alanı dışını okuduğu biçimler ve işçilerin git entegrasyon komutları reddedilir; bunlar güvenin kapsamını genişletmez.
- Güven bir sınırlama değil, bilinçli bir risk kabulüdür; `doctor --runtime` durumunu (`trust` kontrolü) gösterir, her karar ve kullanım denetlenir.
- **Yol haritası:** Windows OS sandbox'ı — AppContainer veya kısıtlı token (restricted token) + job object (process ağacı, UI ve kaynak sınırları) ile child process'lerin gerçekten sınırlanması. Hazır olduğunda Windows `full` raporlar ve güven gereksinimi yalnız tam olmayan backend'ler için kalır.

## Alternatives

- **Yalnız policy (OS backend yok):** Shell ile kapsam dışı yazma engellenemez. Reddedildi.
- **Her platformda tam OS sandbox şartı:** Windows v1'de karşılanamaz; ürünü Windows'ta kullanılamaz kılar. Reddedildi; açık `partial` raporuyla ilerlenir.
- **Container/VM:** Ağır, yerel CLI deneyimine uygun değil. Sonraki aşamaya bırakıldı.

## Consequences

- Güvenlik iddiası pazarlama cümlesi değil, platform bazlı raporlanmış invariant'tır.
- Windows kullanıcıları yüksek riskli ve `require_full_sandbox` görevlerde durur; bu açıkça söylenir.
- Tam olmayan sandbox'ta `write-outside-scope` harness araçları için uygulanır, güvenilen build/test komutlarının çalıştırdığı kod için **uygulanmaz**; bu, güven sorusunda ve `doctor --runtime` çıktısında kullanıcıya söylenir.

## Evidence

- `src/harness/contracts/tools.ts` (`SandboxRunner`, `sandboxReportSchema`, `SANDBOX_ENFORCEMENT`), `policy.ts` (`require_full_sandbox` refinement'ı, `HARD_RAILS`).
- Platform deneyleri (junction, hard link, TOCTOU) **henüz yapılmadı**; I3 kabul ölçütüdür.
- Sözleşme: [araçlar](../contracts/tools.md), [policy ve onay](../contracts/policy-and-approval.md).

## Verification

- `tests/harness-contracts.test.ts`: `require_full_sandbox` + `partial` altında yazma/exec izinli policy'nin reddi.
- `tests/harness-security-trust.test.ts` (SEC-N1/N2/N3/N5) ve `tests/harness-e2e-trust.test.ts`: güvenilmeyen çalışma alanında build/test ve doğrulama komutunun reddi (spawn edilmeden), `ask` modunda soru, güvenilen yolun çalışması, node modül enjeksiyonunun güvenden bağımsız reddi, depo içeriğinin güven verememesi, headless exit 3.
- I3: symlink/junction kaçışı, `..`, mutlak yol, büyük/küçük harf farkı, hard link, yarış senaryoları; read-only rolün shell üzerinden yazamaması; probe hatasında `unavailable`.

## Revisit trigger

Windows'ta güvenilir bir OS backend'inin (AppContainer veya restricted token + job object + ACL) prototiplenmesi — çalışma alanı güveni gereksinimini Windows için kaldırır; bubblewrap/sandbox-exec'in kullanımdan kalkması; güvenilen bir çalışma alanında zarar veren bir build/test komutu vakası.
