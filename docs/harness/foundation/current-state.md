# Mevcut Synorch ve harness sınırı

> Statü: depo incelemesi 2026-09-22; runtime uygulamasını yansıtacak şekilde güncellendi 2026-09-23. Kapsam: `harness` dalındaki bu çalışma ağacı. `main` dalı runtime'ı henüz içermez.

## Bugün doğrulananlar

- `package.json`: paket adı `synorch`, sürüm `0.3.0`, Node `>=24`, `syn` ve `synorch` yürütülebilirleri aynı `dist/cli.js` dosyasına bağlı.
- `src/cli.ts`: `inspect`, `init`, `sync`, `doctor` komutları var. `inspect` yazmadan önizleme, `init` yapı kurma, `sync` elle keşif, `doctor` doğrulama yapıyor. Bu komutların çıktıları ve exit code'ları bayt bayt korunur (`tests/cli-legacy-snapshot.test.ts`; yalnız üst düzey yardım metnine runtime komutları bilinçli olarak eklendi).
- `src/domain/canonical-contracts.ts`: agent manifest ve skill sözleşmesi Zod şemaları var; runtime aynı şemalarla kanonik `.ai/` yapısını okur.
- [Mevcut mimari](../../AI-ORCHESTRATION-ARCHITECTURE.md): provider tarafında Codex/Claude Code'a uyarlanan `.ai/` protokolleri, roller, skill'ler, model profilleri, görev paketleri ve risk oranlı doğrulama anlatılıyor.
- [Önceki vizyon](../../FUTURE-MULTI-PROVIDER-HARNESS.md): sağlayıcı adaptörleri, ledger, güvenlik, çoklu model, yol haritası **öneri** olarak belirtilmiş.

## Uygulanan runtime (`harness` dalı)

`src/harness/` altında çalışan bir runtime var; mevcut komutlara model bağımlılığı eklemez. `src/cli.ts` runtime modüllerini yalnız runtime komutlarında yükler ([CLI başvurusu §1](../reference/cli.md#1-mevcut-komutlarla-sınır)).

| Kabiliyet | Yer | Başvuru |
| --- | --- | --- |
| Oturum olay günlüğü, blob deposu, kilit, recovery, projeksiyon | `src/harness/core/`, `src/harness/store/` | [çekirdek ve depo](../reference/core-and-store.md) |
| Sağlayıcılar (ChatGPT aboneliği, OpenAI/Anthropic API key, deneysel Claude Code köprüsü), kimlik deposu (DPAPI/keychain/dosya) | `src/harness/providers/`, `src/harness/auth/` | [sağlayıcılar ve kimlik](../reference/providers-and-auth.md) |
| Araç gateway'i, policy engine, onay broker'ı, sandbox probu, exec allowlist'i, çalışma alanı güveni | `src/harness/tools/`, `src/harness/policy/` | [araçlar ve policy](../reference/tools-and-policy.md) |
| Coordinator, plan/DAG, worker attempt'leri, izolasyon, bağımsız review, context builder | `src/harness/orchestration/`, `src/harness/context/` | [orkestrasyon ve bağlam](../reference/orchestration-and-context.md) |
| Proje belleği | `src/harness/memory/` | [bellek](../reference/memory.md) |
| CLI komutları, composition root, pi-tui/plain/JSONL renderer'ları | `src/harness/cli/`, `src/harness/tui/` | [CLI başvurusu](../reference/cli.md) |

Komutlar: `syn agent`, `syn run` (`--mode jsonl`), `syn runs`, `syn show`, `syn doctor --runtime`, `syn login`/`logout`/`auth status`, `syn memory`, `syn trust`. Kanonik `.ai/` yapısı (anayasa, çekirdek protokoller, rol manifestleri, skill kataloğu, model profil ipuçları) runtime'da context ve policy girdisidir; rol manifestleri policy'yi yalnız daraltır. Faz 1 ve Faz 2 çıkış kapıları otomatik testlerle kapandı ([kapanış kaydı](../delivery/milestones/phase-1-2.md)).

### Bilinen sınırlar

- **Windows'ta OS sandbox'ı yok** (`policy-only`, `partial`). Araçların yazmaları gateway'de kapsam denetiminden geçer, exec allowlist ile sınırlıdır; ama güvenilen bir çalışma alanında test/build betikleri ve oturum sırasında yapay zekânın yazdığı kod kullanıcının izinleriyle çalışır ve Synorch kimlik bilgileri dahil çalışma alanı dışına erişebilir ([ADR-06](../decisions/ADR-06-sandbox.md)). Kullanıcı bunu güven sorusunda ve `syn trust` çıktısında açıkça görür.
- Gerçek hesaplarla, gerçek terminal matrisinde ve Linux/macOS host'larında doğrulama yapılmadı; ürün sahibi için adımlar: [canlı smoke test](../delivery/live-smoke-test.md).

## Korunacak Synorch çekirdeği

| Mevcut kavram | Harness karşılığı | Dikkat |
| --- | --- | --- |
| `.ai/constitution.md`, core protokoller | Context builder'ın anayasa/protokol blokları ve policy girdisi | Metin tek başına yetki sınırı değil |
| Agent manifest | Runtime rol tanımı (policy'yi yalnız daraltan katman) | Genişleten alanlar yok sayılır ve raporlanır |
| Skill Contract | Rol kapsamlı katalog, istek üzerine yüklenen prosedür | Skill çalıştırılabilir eklentiyle karıştırılmaz |
| Task Context Packet | Worker'ın sürümlü, kaynaklı girdisi | Ham ebeveyn transkripti otomatik kopyalanmaz |
| Completion / Review Packet | `task_report` / `review_report`, kriter → kanıt bağı | Reviewer kendi bağımsız kanıtını üretir |
| Model profile | Tier başına model ipucu (route değil) | Route yalnız kullanıcı yapılandırmasından gelir |
| `syn doctor` | Statik doctor + `syn doctor --runtime` | Geriye dönük komut davranışı korunur |

## Önemli gerilim

Mevcut [orkestrasyon mimarisi](../../AI-ORCHESTRATION-ARCHITECTURE.md) her oturumda model profili onayı ve uygulama öncesi plan/onay öngörüyor. Runtime bunu makine tarafından uygular: `ask` modunda plan ve etkili eylemler insan onaylıdır, `autonomous` modunda orchestrator'ın plan öz-onayı denetlenir ve gösterilir, headless run'da insan gerektiren her karar exit 3 ile durur; ücretli sağlayıcı değişikliği, bütçe artışı ve çalışma alanı güveni yalnız insan tarafından onaylanabilir ([ADR-08](../decisions/ADR-08-approval-policy.md), [ADR-15](../decisions/ADR-15-headless.md)).

## Sınır ilkesi

Harness, mevcut `syn` komutlarını zorunlu model bağımlılığına bağlamaz: runtime aynı paketin ayrı alt komutlarıdır ve yalnız o komutlarda yüklenir ([ADR-01](../decisions/ADR-01-package-boundary.md)). Runtime'ın tükettiği kanonik şemalar generator'ın kendi Zod şemalarıdır.
