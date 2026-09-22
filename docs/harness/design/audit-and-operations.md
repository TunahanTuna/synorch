# Audit, tanılama ve işletim

> Statü: öneri. Referans: [DeepSeek event ve session modeli](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

## İzleme kimlikleri

Bir CLI run'ı `RunId`, her model isteği `RequestId`, her tool çağrısı `ToolCallId`, her worker `TaskId`/`AttemptId` ile izlenir. Bu kimlikler TUI durum satırı, JSONL event, yerel log ve hata raporunda eşleşir. Sistem saati sıralama için tek kaynak değildir; session `seq` sırası esastır.

## Minimum audit olayı

`actor/role`, plan ve packet digest'i, model route, uygulanan policy versiyonu, approval sonucu, tool adı/etki sınıfı, çözülmüş çalışma kökü, artifact digest'i, test/review sonucu, retry nedeni, usage ölçüm kaynağı. Tam prompt veya gizli içerik varsayılan log alanı değildir. Debug tracing opt-in ve süre/retention sınırlı olur. Kullanıcı `syn show <run>` ile hangi kararın neden verildiğini görebilmelidir.

## Tanılama

`doctor --runtime` aşağıdaki kontrolleri bağımsız sonuçlarla verir:

1. Node/terminal kabiliyeti ve platform sandbox backend'i; enforcement `full/partial/unavailable`.
2. Çalışma kökü, git durumu, junction/symlink politika desteği.
3. Event store yazma/okuma, migrasyon sürümü, lock/lease sağlığı.
4. Provider auth (secret dökmeden), model erişimi, streaming/cancel/usage probe.
5. Canonical `.ai/` yapısı, rol ve task packet şema sürümü.
6. Tool registry'deki aktif eklentiler ve etkili izin kaynağı.

Kontrol başarısızlığında sonuç `error/warning/unknown` ayrımıyla ve düzeltme komutuyla çıkar. `doctor` hiçbir provider'a ücretli model isteği göndermemeli; ücretli test ayrı `--probe-model` gibi açık bayrak ister.

## Yerel veri yönetimi

Run/session/blob/trace dosyalarının kökleri, retention süresi ve silme komutu belgelenmeli. Workspace'e taşınabilir proje talimatlarıyla kişisel session/credential verileri ayrı tutulur. `syn export` redakte edilmiş audit ve artifact manifestini üretir; `syn delete-session` ilişkili blob referanslarını güvenli temizler. Dosya silme veya export semantiği uygulama öncesi tasarlanır; bunlar mevcut komut değildir.

## Operasyonel durumlar

Terminal kapanışı, OS uyku/uyanma, provider bağlantı kopması, disk dolması, tek session'a iki process bağlanması, izin diyaloğunda iptal ve worker orphan durumu ayrı test edilir. Her biri kullanıcıya son güvenli durum ve devam seçeneği sunar. Arka planda çalışan iş ilk sürümde yoksa CLI bunu açıkça söyler; terminali kapatınca işin sürdüğü izlenimini vermez.
