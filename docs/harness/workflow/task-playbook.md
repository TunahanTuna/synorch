# Bir harness işi için uygulanabilir oyun kitabı

> Durum: `harness` dalında çalışacak geliştirici ve agent için süreç şablonu. Buradaki Git/pnpm komutları mevcut depoya aittir; önerilen `syn agent` komutları [CLI tasarımında](../design/cli-experience.md) ayrıca işaretlenir.

## 1. Başlangıç denetimi

İşe başlamadan çalışma dalı, yerel değişiklikler ve son commit kaydedilir. Çalışma ağacı kirliyse hangi dosyanın kime ait olduğu anlaşılmadan silme, stash veya branch değiştirme yapılmaz. `main` üzerindeysen `harness`a geç; birden fazla geliştirici çalışıyorsa mevcut worktree'leri kontrol et. Konu dalı açılacaksa **güncel `harness` commit'inden** aç. Örnek:

```powershell
git branch --show-current
git status --short
git switch harness
git switch -c codex/harness-<konu>
```

Son satır yalnızca konu dalı gerektiğinde kullanılır; `<konu>` gerçek bir kısa adla değiştirilir. Mevcut dalda kullanıcı değişiklikleri varsa önce korunur. Worktree tercih edildiğinde yeni klasörün branch tabanı yine `harness` olmalı; worker kendi worktree'si dışındaki dosyaları düzenlememeli.

## 2. İş notu şablonu

İş küçük değilse aşağıdaki not issue/PR açıklaması veya `docs/harness/work-items/<id>.md` olarak tutulabilir. `work-items/` henüz yok; kalıcı kayıt formatı [dokümantasyon planındaki](./documentation-plan.md) traceability ile birlikte kararlaştırılır.

```yaml
id: HWORK-001
title: Kısa eylem başlığı
status: proposed             # proposed | ready | active | review | done | blocked
base_branch: harness
goal: Kullanıcı açısından tek cümlelik sonuç
why_now: Bu işin çözdüğü somut problem
scope:
  in: [değişecek modül veya belge]
  out: [özellikle ele alınmayacak konu]
  owned_paths: [ilgili/yollar/**]
dependencies: [ADR-03, HWORK-000]
risk: trivial                # trivial | standard | high-risk
acceptance:
  - id: AC-1
    behavior: Gözlenebilir sonuç
    evidence: Test, komut çıktısı veya belge bağlantısı
decision_needed: []
rollback: Geri alma veya veri geçişi yolu
```

Kabul ölçütü “çalışıyor” gibi genel cümle değil, giriş/eylem/beklenen sonuç biçiminde olmalı. `evidence` alanı kod yazılmadan önce planlanır. Güvenlik veya kalıcı veri etkisi varsa en az bir olumsuz senaryo eklenir. `blocked` durumu, eksik yetki veya karar gerektiren somut nedenle açıklanır.

## 3. Hazır olma kapısı

Bir iş uygulamaya ancak şu sorular cevaplandığında geçer:

1. Bu davranış bugünkü Synorch'ta mı, yoksa yeni harness runtime'ında mı olacak?
2. Kullanıcı etkisi ve birincil kabul örneği yazıldı mı?
3. İlgili kaynak kod, belge ve test sahipleri bulundu mu?
4. Kararı değiştiren ADR açık mı? Gerekliyse kabul edildi mi veya prototip etiketi var mı?
5. Modül ve dosya sahipliği çakışıyor mu?
6. İzin, credential, veri saklama ve provider etkisi değerlendirildi mi?
7. Test seviyesi ve rollback/iptal yolu belirlendi mi?

Eksik bilgi ürün sahibinden yanıt gerektiriyorsa bağımsız yapılabilecek keşif/deney sürer; bağımlı davranış keyfi varsayımla uygulamaya geçirilmez. Salt dokümantasyon/araştırma işlerinde “uygulama” yerine kaynak ve bağlantı doğrulaması kapısı kullanılır.

## 4. Dilimleme yöntemi

Bir milestone, kullanıcıya veya geliştiriciye gözlenebilir tek bir akış üretmeli. Örnek ilk dilim: tek model isteği → stream → session event → resume görünümü. Sonraki dilim: salt okunur araç → policy kararı → log. Sonra dosya yazma/sandbox. Bu sıralama, tek PR'da auth + tool + TUI + worker scheduler değiştirip hata kaynağını belirsizleştirmeyi önler. Her dilim kendi test ve belgeleriyle kapanır.

İş ayrıştırılırken bağımlılık grafiği çıkar: şema/arayüz önce, tüketici sonra; paralel yapılabilen işler farklı dosya sahipliği alır. Worker'a [Task Context Packet](../design/orchestration-contracts.md) mantığında amaç, bilinen kanıt, kapsam, kabul ve çıktı formatı verilir. Worker başka dosyaya ihtiyaç duyarsa kendi başına kapsamı büyütmez; orchestrator yeni plan/dosya sahipliği oluşturur.

## 5. Kanıt toplama sırası

1. Değişimden önce beklenen davranışı veya hatayı kaydet.
2. En dar ilgili testi/fixture'ı çalıştır.
3. Kod değişiminden sonra aynı testi tekrarla; farklılaştığını açıkla.
4. Modül sınırı veya tip değiştiyse typecheck/build çalıştır.
5. Entegrasyon öncesi mevcut repo kapısı `pnpm check` çalıştır; yalnızca belge işi için neden gerekmediği yazılabilir.
6. `git diff --check`, değişen dosyalar ve yeni Markdown göreli bağlantıları denetle.
7. Güvenlik/izin/depolama etkisinde negatif test ve platform farkını kaydet.

Yapılmayan test, geçen test gibi raporlanmaz. Test komutu, exit code, çalışma ortamı ve ilgili commit/patch kimliği belirtilir. Flaky sonuç tekrar edilirse kaç deneme yapıldığı görünür olur. Test çalıştırmak gerçek dış sistemde yan etki yaratıyorsa önce etkisi incelenir.

## 6. Completion ve review şablonu

```yaml
work_id: HWORK-001
base_commit: <harness-tabanı>
result_commit: <commit-veya-diff>
status: completed             # completed | partial | failed | blocked
changed_paths: [src/...]
acceptance_evidence:
  AC-1: <test-id/komut/artifact>
checks:
  - command: pnpm check
    result: passed
    evidence: <çıktı veya CI bağlantısı>
decisions: [ADR-03]
unresolved_risks: []
```

Reviewer aynı kanıtları okur ama sonucu otomatik kabul etmez. Diff'in kapsamı, API/şema uyumu, hata yolları, güvenlik etkisi ve belgelerin gerçek davranışı anlattığı bağımsız kontrol edilir. Review çıktısı `accept`, `revise` veya `block`, bulgular ve kendi kanıtını içerir. Yüksek riskli değişikliklerde reviewer implementer'dan ayrı olmalıdır; standart işte bağımsız inceleme [risk politikasına](./governance.md) göre yapılır.

## 7. Entegrasyon ve kapanış

Konu dalı kullanıldıysa hedef `harness` olarak karşılaştırma yapılır. Entegrasyon öncesi dalın eskiyip eskimediği, aynı dosyaları değiştiren başka iş olup olmadığı ve testin hangi commit'te çalıştığı doğrulanır. Çakışma çözülürse ilgili test yeniden çalıştırılır. Commit mesajı değişikliği anlatır; release/PR gerekiyorsa kullanıcı tarafından tanımlanan yayın akışı izlenir. `harness` üzerinde sonuç doğrulanmadan iş `done` olmaz. `main`e merge veya npm publish, bu kapanışın otomatik adımı değildir.

Kapanış raporu dört kısa bölüm taşır: değişen davranış, kanıt/test, kalan risk/karar, sonraki bağımlı iş. Belgelerin öneri → uygulanmış statüsüne geçmesi yalnızca gerçek kod ve test kanıtı varsa yapılır.
