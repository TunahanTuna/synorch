# Mevcut Synorch ve önerilen harness sınırı

> Statü: depo incelemesi, 2026-09-22. Kapsam: bu çalışma ağacı.

## Bugün doğrulananlar

- `package.json`: paket adı `synorch`, sürüm `0.3.0`, Node `>=24`, `syn` ve `synorch` yürütülebilirleri aynı `dist/cli.js` dosyasına bağlı.
- `src/cli.ts`: `inspect`, `init`, `sync`, `doctor` komutları var. `inspect` yazmadan önizleme, `init` yapı kurma, `sync` elle keşif, `doctor` doğrulama yapıyor.
- `src/domain/canonical-contracts.ts`: agent manifest ve skill sözleşmesi Zod şemaları var.
- [Mevcut mimari](../../AI-ORCHESTRATION-ARCHITECTURE.md): provider tarafında Codex/Claude Code'a uyarlanan `.ai/` protokolleri, roller, skill'ler, model profilleri, görev paketleri ve risk oranlı doğrulama anlatılıyor.
- [Önceki vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md): sağlayıcı adaptörleri, ledger, güvenlik, çoklu model, yol haritası **öneri** olarak belirtilmiş.

## Bugün bulunmayan runtime kabiliyetleri

Depodaki CLI komutlarında model konuşma döngüsü, tool dispatcher, provider bağlantısı, worker process yöneticisi, kalıcı runtime oturum deposu veya terminal sohbet arayüzü bulunmuyor. Dolayısıyla üretilen anayasa ve protokoller bugün büyük ölçüde **host agent tarafından yorumlanan talimatlar**; harness geliştirilince bazıları process düzeyinde uygulanabilir politikaya dönüşecek. Bu ayrım hem UI'da hem `doctor` çıktısında görünmeli.

## Korunacak Synorch çekirdeği

| Mevcut kavram | Harness karşılığı | Dikkat |
| --- | --- | --- |
| `.ai/constitution.md`, core protokoller | Policy derleyicisinin girdisi | Metin tek başına yetki sınırı değil |
| Agent manifest | Runtime rol ve yetki tanımı | Statik sözleşme ile etkin kabiliyet ayrı raporlanır |
| Skill Contract | İsteğe bağlı bağlam/prosedür | Skill çalıştırılabilir eklentiyle karıştırılmaz |
| Task Context Packet | Worker'ın sürümlü, kaynaklı girdisi | Ham ebeveyn transkripti otomatik kopyalanmaz |
| Completion / Review Packet | Çıktı ve kanıt sözleşmeleri | Reviewer kendi bağımsız kanıtını üretir |
| Model profile | Sağlayıcı/model çözümleme girdisi | Gerçek kullanılabilirlik çalışma zamanında doğrulanır |
| `syn doctor` | Statik + runtime tanılaması | Geriye dönük komut davranışı korunur |

## Önemli gerilim

Mevcut [orkestrasyon mimarisi](../../AI-ORCHESTRATION-ARCHITECTURE.md) her oturumda model profili onayı ve uygulama öncesi plan/onay öngörüyor. [README](../../../README.md) risk oranlı süreç de tarif ediyor. Harness bunları sürümden sürüme değişen prompt geleneğine bırakmamalı: onay politikasının kapsamı, istisnaları ve etkileşimsiz mod davranışı makine tarafından uygulanmalı. Özellikle kullanıcının aynı oturumda daha önce verdiği onayların tekrar istenip istenmeyeceği [karar kaydında](../delivery/decisions.md) açıkça çözülmeli.

## Sınır ilkesi

İlk harness, mevcut `syn` komutlarını zorunlu model bağımlılığına bağlamaz. Çalışan agent ayrı bir alt komut, paket veya process olabilir; somut yerleşim karar aşamasındadır. Runtime'ın tükettiği canonical şemalar mümkün olduğunca tek kaynaktan üretilmelidir.
