# CLI kullanıcı deneyimi ve protokol taslağı

> Statü: öneri; komut adları henüz uygulanmadı. Eski `syn inspect/init/sync/doctor` komutları [mevcut davranış](../foundation/current-state.md) olarak kalır. Referans: [Claude Code döngüsü](https://code.claude.com/docs/en/how-claude-code-works), [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), [DeepSeek profilleri](https://deepseek-harness.github.io/deepseek-harness/en/reference/).

## İnsan modu

Önerilen komut ailesi (nihai isim ADR ile seçilir):

```text
syn agent                 # bulunduğun repo/workspace için terminal sohbeti
syn agent --resume <id>   # mevcut session'a devam
syn agent --fork <id>     # geçmişten yeni session
syn run "<görev>"        # tek görev; terminalde stream ve etkileşim
syn runs                  # yerel görev/oturum listesi
syn show <run-id>         # plan, worker, maliyet, onay, kanıt
syn doctor --runtime      # provider, sandbox, depolama ve izin sağlığı
```

İlk açılış ekranı: çalışma kökü, git durumu, etkin model profili/override, rol eşlemesi, policy modu, sandbox enforcement düzeyi, tahmini bütçe sınırları. Mevcut Synorch'un model profili onayı kuralıyla uyumlu bir akış gerekir; aynı oturumda tekrar edilen gereksiz onaylar [açık karardır](../delivery/decisions.md).

Çalışma sırasında durum satırı en az `run/task`, model, mevcut step, kullanılan/limit bütçe, çalışan worker sayısı, aktif izin isteği ve son doğrulama sonucunu gösterir. `Ctrl+C` önce etkin isteği iptal eder, ikinci kullanımda güvenli kapanış önerir; process'i öldürüp belirsiz task bırakmaz. Kullanıcı mesajı çalışma sürerken kuyruğa girip bir sonraki güvenli sınırda steer edebilir. İzin kararının varsayılanı süre aşımında ret olur.

## Oturum içi komutlar

| Komut adayı | Davranış |
| --- | --- |
| `/plan` | Son plan sürümü, digest, onay ve bekleyen değişiklik |
| `/tasks` | DAG ve worker durumu; path sahipliği |
| `/context` | Kaynak bazında bağlam/token kullanımı, son compaction |
| `/permissions` | Etkin kurallar ve geçerli onaylar |
| `/model` | Gerçek route, capability, geçici override isteği |
| `/diff` | Bu run'ın değişiklikleri; kullanıcının önceki değişiklikleri ayrı |
| `/evidence` | Kabul ölçütü → test/artifact/review eşlemesi |
| `/cancel` | İstek veya task iptali; devam edilebilir durum |
| `/help` | İnsan modu ve headless kullanım örnekleri |

## Makine modu

`syn run --json ...` ya da ayrı bir `--mode jsonl` modu stdout'a **yalnızca sürümlü JSONL olayları** yazmalı. İnsan metni ve spinner stderr'e veya hiç gönderilmez. Her frame: `schema_version`, `run_id`, `seq`, `type`, `timestamp`, `data`; ayrıca `result` ve terminal `error` frame'leri bulunur. Stdin üzerinden approval/steer istenecekse RPC ayrı modu olmalı; tek yönlü JSONL ile çift yönlü RPC aynı sözleşmeye sıkıştırılmamalı. Exit code: `0` kabul edilmiş başarı, `2` kullanım/konfigürasyon, `3` plan/onay reddi, `4` provider/tool, `5` doğrulama başarısızlığı, `130` kullanıcı iptali gibi **taslak** sınıflar; kesin sayılar testle sabitlenir.

## Kullanıcı akışı

```text
syn agent → ortam ve profil → kullanıcı hedefi → keşif → plan
→ gerekli onay → task DAG → worker stream → test → bağımsız review
→ kabul ölçütü bazında rapor → session resume için kayıt
```

Trivial işte worker sayısı ve doğrulama maliyeti risk oranlı azalır; ürün akışı açıklanabilir kalır. Kullanıcı zaten belli bir eyleme açık yetki vermişse aynı eylem için yeni onay sorusu çıkmamalı; kapsam değişimi veya dış etki doğarsa yeniden değerlendirilir.

## Hata mesajı standardı

Hata, `ne oldu`, `hangi adım/kimlik`, `çalışma alanı etkisi`, `yeniden deneme güvenli mi`, `sonraki komut` bilgilerini taşır. Provider yokluğu model kimliğiyle, sandbox `partial` ise uygulanan/uygulanamayan sınırla, stale task packet ise kaynak digest farkıyla açıklanır. Gizli anahtarlar ve ham prompt varsayılan terminal log'una dökülmez.
