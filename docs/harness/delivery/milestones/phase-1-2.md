# Faz 1 ve Faz 2 çıkış kapıları: kanıt kaydı

> Durum: kanıt kaydı, 2026-09-23 (I5 Aşama B teslimi). Kapılar: [yol haritası](../roadmap.md). Eşleme kuralı: [uygulama planı §5](../../implementation-plan.md#5-faz-kapıları-ile-eşleme). Senaryolar: [verification.md Seviye 3](../verification.md#seviye-3-uçtan-uca-senaryolar). Bu belge kapıların **otomatik testlerle** nerede kanıtlandığını ve neyin henüz kanıtlanmadığını dürüstçe kaydeder; bir kapıyı "kapandı" ilan etmek entegrasyon sahibinin bağımsız review'undan sonra olur.

Kanıt ortamı: Windows 11, Node 24.11, `pnpm check` 544 test, 543 geçti, 1 platform atlaması, 0 hata (Dalga 3 boşluk kapatma sonrası; I5 Aşama B teslimi 522/521/1 idi). Model yanıtları scripted adapter'dan gelir; ağ, gerçek hesap ve gerçek TTY kullanılmadı. `.github/workflows/harness-ci.yml` aynı kapıyı `windows-latest`, `ubuntu-latest`, `macos-latest` üzerinde Node 24 ile koşacak şekilde eklendi; henüz uzakta koşmadı (push yapılmadı).

## Faz 1 — Tek sağlayıcılı yerel agent çekirdeği

Çıkış kapısı: *Tek görev crash/yeniden başlatma sonrası doğru statüde açılır; açık yan etkili tool çağrısı sessizce tekrarlanmaz; modelin gördüğü giriş yeniden üretilebilir.*

| Kapı ölçütü / AC | Kanıt (test dosyası › test adı) | Durum |
| --- | --- | --- |
| Crash sonrası doğru statü, yan etki tekrarlanmaz (I1 AC-4) | `harness-core-recovery` › "AC-4 a call that crashed after tool/execution_started…", "AC-4 a driver crash mid-tool…"; **uçtan uca:** `harness-e2e-recovery` › "crash after tool/execution_started: resume records tool/interrupted and never re-runs the call" (gerçek `syn run` süreci `exec` sırasında öldürülür; `syn agent --resume` run ve attempt oturumlarını kurtarır, işaret dosyası tek satır kalır, ikinci resume bir şey eklemez) | Otomatik kanıtlı (Windows) |
| Modelin gördüğü giriş yeniden üretilebilir (I1 AC-5) | `harness-core-driver` › "AC-5 every model request envelope is rebuilt byte for byte…", "AC-5 a tampered envelope blob…" | Otomatik kanıtlı (birim); e2e oturumlarında `model/request_prepared` blob'ları aynı yoldan yazılır |
| İptal `settled` üretmez (I1 AC-6) | `harness-core-driver` › "AC-6 a cancelled stream ends with step aborted…", "AC-6 a stream that still reports done after the abort…", "AC-6 cancelling during a tool batch…"; **uçtan uca:** `harness-e2e-headless` › "user cancellation during a model stream exits 130 with a cancelled error frame (AC-3)" | Otomatik kanıtlı |
| Stream dilbilgisi, hata eşlemesi (I2 AC-1, AC-2) | `harness-providers-adapters` › "AC-1 openai-chatgpt fixture…", "AC-1 anthropic-messages fixture…", "AC-2 abort mid-stream…", "AC-2 HTTP 429 maps retry-after…"; `harness-auth-oauth` › "AC-2 a 401 triggers exactly one forced refresh…" | Kayıtlı fixture ile kanıtlı; gerçek uç noktalarla değil |
| Kapsam dışı yazım reddi (I3 AC-1) | `harness-tools-paths` › "AC-1: …" (15 test) | Otomatik kanıtlı (Windows junction dahil); Linux/macOS host'ta koşulmadı |
| Bounded output + redaksiyon (I3 AC-7) | `harness-tools-gateway` › "AC-7: output above 16 KiB…", "AC-7: secrets in output…", "AC-7: arguments carrying a live credential…" | Otomatik kanıtlı |
| İptal child ağacını sonlandırır (I3 AC-8) | `harness-tools-exec` › "AC-8: cancelling exec terminates the whole child tree…" | Otomatik kanıtlı (Windows) |
| Legacy komutlar değişmez (I5 AC-1) | `cli-legacy-snapshot` › "legacy commands keep byte-identical stdout, stderr and exit codes (AC-1)" (yalnız üst düzey yardım metni bilinçli güncellendi); `harness-boundary` | Otomatik kanıtlı |
| Non-TTY → plain, JSONL yalnız frame (I5 AC-2) | `harness-cli-args` › "renderer selection…", "JSONL mode reports even usage errors…", "the real binary routes runtime commands…"; `harness-tui-jsonl` › "stdout holds only schema-valid frames… (AC-2)"; her `harness-e2e-*` JSONL testi `validateFrameSequence` + LF-only denetimi | Otomatik kanıtlı |
| `doctor --runtime` ağ isteği yok (I5 AC-6) | `harness-e2e-doctor` › "doctor --runtime --json reports each area separately and makes no network request (AC-6)" (kayıt tutan sahte fetch sıfır çağrı; `--probe-model` tam bir istek) | Otomatik kanıtlı |

## Faz 2 — Synorch orkestrasyonunun yürütülmesi

Çıkış kapısı: *İki worker aynı path'e yazamaz; reviewer, implementer sonucunu kendi kanıtıyla değerlendirir; kabul ölçütlerinin her biri bir kanıt kimliğine bağlanır.*

| Kapı ölçütü / AC | Kanıt | Durum |
| --- | --- | --- |
| İki worker aynı path'e yazamaz (I4 AC-1) | `harness-orchestration-scheduler` › "two dependent writers on the same path run strictly one after the other (Faz 2 gate)", "the coordinator rejects an overlapping plan…"; **uçtan uca:** `harness-e2e-conflict` › "two conflicting tasks: an unordered overlap is rejected and the ordered pair never writes in parallel" | Otomatik kanıtlı |
| Reviewer kendi kanıtıyla değerlendirir, transkript görmez (I4 AC-2, ADR-09) | `harness-orchestration-review` › "the reviewer never sees the implementer transcript…", "a reviewer that only cites worker evidence cannot accept…"; **uçtan uca:** `harness-e2e-standard` › "standard code change: plan, packet, diff, test, independent review and report (AC-5)" (ayrı oturum, farklı model, reviewer'ın kendi `exec` kanıtı, implementer metni reviewer isteklerinde yok) | Otomatik kanıtlı |
| Her kabul ölçütü bir kanıt kimliğine bağlı (I4 AC-3) | `harness-orchestration-review` › "a criterion without resolvable evidence yields revise…", "evidence must resolve…"; e2e: `harness-e2e-trivial`, `harness-e2e-standard` (`syn show --json` kriter → `tool-call:call_…` / `test-run`) | Otomatik kanıtlı |
| Freshness kapısı (I4 AC-4) | `harness-orchestration-freshness` (tüm testler); `harness-context-builder` › "a stale packet source stops the build…" | Birim/entegrasyon kanıtlı; e2e senaryosu yok |
| Retry yeni attempt, kanıt korunur (I4 AC-5) | `harness-orchestration-review` › "a retry is a new attempt and the failed attempt and its evidence stay in the log"; e2e: `harness-e2e-provider` (iki başarısız attempt ayrı oturumlarda, sessiz fallback yok) | Otomatik kanıtlı |
| Explorer/reviewer yazamaz (I3 AC-2) | `harness-tools-gateway`, `harness-policy-engine` › "AC-2: explorer and reviewer cannot write…" | Otomatik kanıtlı |
| Uçtan uca trivial + standart (I5 AC-5) | `harness-e2e-trivial`, `harness-e2e-standard` | Otomatik kanıtlı |
| Synorch orkestrasyon modeli runtime'da (kanonik `.ai/` → anayasa/protokol blokları, rol tanımları policy'yi yalnız daraltır, rol kapsamlı skill kataloğu, profil ipuçları; `.ai/` yoksa yerleşik varsayılan ve bunun bildirilmesi) | `harness-cli-canonical` (5 test); `harness-e2e-doctor` (`canonical` sonucu) | Otomatik kanıtlı |
| Orchestrator delegasyonu (`task_spawn`/`task_status` sahiplik + bütçe kontrollü), `ask_user` bağlama | `harness-orchestration-delegation`, `harness-e2e-steer`, `harness-e2e-ask-user` | Otomatik kanıtlı |
| Exit code ayrımı (provider/tool → 4, doğrulama → 5) | `harness-orchestration-exit-codes` (6 test); `harness-e2e-provider` (artık exit 4) | Otomatik kanıtlı |

## Seviye 3 senaryo durumu

| Senaryo | Durum |
| --- | --- |
| Trivial belge düzeltmesi, standart kod değişikliği, iki çakışan task, crash (tool sonrası kayıt öncesi), provider rate limit/kota, headless onay | Otomatik e2e kanıtı var (§ yukarı; ayrıntı [CLI başvurusu §14](../../reference/cli.md#14-uçtan-uca-senaryolar-verificationmd-seviye-3)) |
| Yüksek riskli değişiklik (güçlü izolasyon + açık onay) | `harness-e2e-high-risk`: `autonomous`'ta zorunlu worktree, ayrı oturumda farklı modelli reviewer ve reviewer'ın kendi test kanıtı; `ask`'ta plan ve her etkili eylem (`write_file`, iki `exec`) insan onaylı; git yoksa daha zayıf izolasyona düşmek yerine ret (exit 6) |
| Çalışırken kullanıcı düzeltmesi (steer) | `harness-e2e-steer`: TTY `syn agent`'ta run sırasında yazılan satır güvenli sınırda uygulanır, orchestrator danışılır (`task_status`, `task_spawn`), plan v2 onaylanınca v1 `superseded`, sonraki görevin packet'i steer'i taşır, çalışan attempt değişmez; `harness-orchestration-delegation`: `ask`'ta revizyon onayı ve reddi |

## Doğrulanmamış olanlar (açık)

- **Gerçek hesaplar:** ChatGPT OAuth (PKCE/device-code, refresh), OpenAI/Anthropic API key akışları, `claude` köprüsü ve `doctor --runtime --probe-model` gerçek uç noktalara karşı hiç koşulmadı ([providers-and-auth §9](../../reference/providers-and-auth.md#9-doğrulanmamış-varsayımlar-ve-gerçek-hesap-gerektirenler)).
- **Gerçek TTY matrisi:** pi-tui renderer yalnız `@xterm/headless` ile test edildi; Windows Terminal/conhost/PowerShell/cmd, macOS/Linux terminalleri, SSH ve ekran okuyucu matrisi ([CLI başvurusu §9](../../reference/cli.md#9-manuel-çapraz-platform-doğrulaması-açık)) işaretlenmedi. `syn agent` TUI modu elle denenmedi.
- **Linux/macOS host'lar:** tüm kanıt Windows 11'de üretildi; `harness-ci.yml` matrisi eklendi ama uzakta koşmadı (bubblewrap/sandbox-exec `full` yolu, keychain CLI'ları, POSIX sinyal iptali, crash testindeki süreç öldürme doğrulanmadı).
- **Dalga 3 sınırları:** steer yalnız dispatch sınırında uygulanır (çalışan attempt'e iletilmez); `task_spawn` yalnız steer danışması sırasında kabul edilir; `task_spawn.packet`'in plan görevi olarak yorumlanması `tools.md` için bir netleştirme isteğidir; model profilleri route değil ipucudur; kanonik `.ai/` gerçek bir `syn init`/`syn sync` deposunda yalnız test fixture'ıyla denendi.
