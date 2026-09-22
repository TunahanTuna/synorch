# Hafıza referansı (`src/harness/memory/`, I6)

> Durum: I6 uygulaması, 2026-09-22. Sözleşme: [memory.md](../contracts/memory.md). Kararlar: [ADR-16](../decisions/ADR-16-memory-location.md), [ADR-17](../decisions/ADR-17-memory-write-policy.md). Tasarım: [Obsidian ile yerel hafıza](../obsidian/README.md). Testler: `tests/harness-memory-store.test.ts`, `tests/harness-memory-command.test.ts`.

## 1. Dışa açık yüzey

| Sembol | Ne yapar |
| --- | --- |
| `createMemoryStore(root, { workspaceRoot?, now? })` | `MemoryStore` sözleşmesini düz Markdown vault üzerinde uygular (`MarkdownMemoryStore`). `workspaceRoot`, `source_ref` yollarının stale kontrolü için çözüldüğü çalışma köküdür. |
| `resolveMemoryRoot(config, projectId, home)` | ADR-16 kök çözümü (`config: MemoryConfig`, sözleşmedeki `memoryConfigSchema`). `config.root` doluysa o kullanılır (`~` ve göreli değerler `home`'a göre çözülür); yoksa `<home>/.synorch/memory/<project-id>/`. `home` enjekte edilir, testler gerçek ev dizinine dokunmaz. |
| `memoryCommand` / `createMemoryCommand(options)` | `syn memory ...` için `CommandHandler`. `options` ile `config`, `home`, `platform`, `obsidian` başlatıcısı ve saat enjekte edilir. |
| `MemoryConflictError` | `persist`/kabul yazımında dosya beklenen digest'ten farklıysa atılır; `code: store_write_failed`, `workspace_effect: none`. |
| `decide(...)` | Sözleşmedeki `MemoryDecisionOutcome`'u döndürür: `memory/proposal_decided` ve (varsa) `memory/persisted` olay yükleri ile orchestrator kararında `runId`. Olay günlüğüne yazmak çağıranın (I4/I5) işidir. |
| `candidates(id?)`, `candidateToProposal(...)` | Kural tabanlı ilişki/çelişki adayları ve bunları bekleyen kuyruk önerisine çeviren yardımcı. |
| `status()`, `related(id)`, `rebuildIndex()`, `sourceState(...)` | CLI'ın kullandığı okuma yardımcıları. |
| `redactSecrets(text)` | Diske gitmeden önce uygulanan sır redaksiyonu. |

Modül yalnız `../contracts/index.ts`, `src/domain/**`, `zod`, `yaml` ve `node:*` kullanır. `src/infrastructure/frontmatter.ts` boundary testi nedeniyle içe aktarılmaz; frontmatter ayrıştırması `yaml` ile modülün kendi içinde yapılır.

## 2. Vault yerleşimi

```text
<root>/
  README.md                 vault'u açıklayan kısa not (bir kez oluşturulur, sonra dokunulmaz)
  decisions/ assumptions/ questions/ evidence/ concepts/ preferences/ project/
    <id>.md                 not: YAML properties + "# Başlık" + gövde
  queue/<proposal-id>.yaml  inceleme kuyruğu (MemoryProposal), kararla birlikte saklanır
  views/decisions.base      örnek Obsidian Bases görünümü (kararlar)
  views/review-queue.base   örnek görünüm (proposed / open / stale notlar)
  .index/index.json         türetilmiş tam metin + bağlantı indeksi (silinebilir)
```

Kök zaten proje başınadır (`<project-id>`), bu yüzden Obsidian belgesindeki `projects/<id>/` ara katmanı sözleşmedeki düzen lehine kullanılmaz. `.obsidian/` hiçbir zaman oluşturulmaz; klasör Obsidian'da vault olarak doğrudan açılabilir. Not taranırken nokta ile başlayan klasörler, `queue/`, `views/` ve kökteki `README.md` atlanır. Kullanıcı bir notu alt klasöre taşıyabilir veya yeniden adlandırabilir: kalıcı referans `id`'dir, `get`/`persist` notu yeni yerinde bulur.

## 3. Not biçimi ve yazma

- Frontmatter `memoryNoteFrontmatterSchema` ile doğrulanır; alanlar sabit sırayla yazılır. Başlık tek satırdır. Bağlantılar standart Markdown bağlantısıdır (`[metin](../concepts/cpt-x.md)`).
- `persist(note, expectedDigest)` yalnız `AUTO_PERSIST_KINDS` (evidence, concept, assumption, question) kabul eder; `decision`, `preference` ve `project` `policy_denied` ile reddedilir (ADR-17).
- Çakışma kuralı: diskteki içeriğin digest'i (`digestText`, satır sonları normalize) `expectedDigest`'e eşit değilse hiçbir şey yazılmaz. Yeni not için `expectedDigest` `undefined` olmalıdır; dosya varsa çakışmadır. Silinmiş bir nota eski digest ile yazmak da çakışmadır.
- Yazma atomiktir: aynı klasörde geçici dosya (`wx`) + `rename`.
- Redaksiyon: başlık, gövde ve tüm frontmatter/öneri metinleri yazmadan önce taranır (özel anahtar blokları, `sk-ant-`/`sk-` anahtarları, GitHub/Slack token'ları, AWS/Google anahtarları, JWT, `Bearer`, URL içi kimlik bilgisi, `password=`/`api_key:` gibi atamalar). Eşleşen değer `[REDACTED]` olur.
- Ham tool çıktısı saklanmaz: kontrol/ANSI karakteri içeren gövde reddedilir; gövde `MAX_NOTE_BODY_CHARS` (16 000) ile sınırlıdır. Not, çıktının kendisini değil `source_ref` + `source_digest` işaretçisini taşır.

## 4. İnceleme kuyruğu

- `propose` öneriyi şemaya göre doğrular, redakte eder ve `queue/<proposal_id>.yaml` olarak yazar; yeni öneri `pending` olmalıdır, aynı id ikinci kez yazılamaz.
- `pending()` `pending` ve `deferred` önerileri oluşturulma sırasıyla döndürür.
- `decide(id, decision, state)`: karar birleşik olarak şemadan geçer; orchestrator kararı `run_id` olmadan reddedilir. `accepted` ise önce not uygulanır, sonra kuyruk dosyası güncellenir; uygulama başarısızsa öneri `pending` kalır.
  - `note`: not yazılır, `reviewed_at` karar tarihiyle dolar, `source_run` yoksa önerinin `run_id`'si yazılır; `decision` + `proposed` kabulde `accepted` olur.
  - `relation` / `contradiction`: hedef notun `relations` listesine eklenir.
  - `status-change`: durum, türün izinli durumları içinde değiştirilir; `reviewed_at` ve `updated_at` dolar.
  - `rejected` hiçbir notu değiştirmez. Kabul/ret edilmiş öneri yeniden karara bağlanamaz.

## 5. İndeks, arama ve stale

- İndeks her okumada dosya listesiyle (yol, boyut, mtime) karşılaştırılır; eksik, bozuk veya eskiyse notlardan yeniden kurulur. Obsidian'ın metadata cache'ine bakılmaz.
- İndeks kırık bağlantıları (var olmayan `.md` hedefi, var olmayan ilişki `id`'si), geçersiz notları ve yinelenen id'leri kaydeder; `reindex()` `{ notes, broken_links }` döner.
- `search(query)` sırası: proje → tür → branch/kapsam → durum filtresi → tam metin puanı (tam id eşleşmesi > başlık > etiket > id parçası > gövde; her sorgu terimi eşleşmelidir).
- `scope: branch` not, sorgunun branch'i farklıysa (veya branch bilinmiyorsa) dönmez. `includeInactive: true` ile döner ama `stale: true` ve "not current here" gerekçesiyle, güncel notlardan sonra sıralanır.
- Pasif durumlar (`superseded`, `rejected`, `invalidated`, `unavailable`, `deprecated`, `revoked`, `archived`, `resolved`) yalnız `includeInactive` ile ve `stale: true`, "historical only" gerekçesiyle döner.
- `source_ref` + `source_digest` taşıyan not için kaynak `workspaceRoot` altında okunur: digest farklıysa veya dosya yoksa `stale: true`. Olay referansları (`ses_...#120`) ve kök dışı yollar "doğrulanamaz" sayılır, gerekçede belirtilir.

## 6. Kural tabanlı adaylar

| Kural | Aday |
| --- | --- |
| `mentions-id` | Not gövdesi başka bir notun id'sini anıyor ama ilişki yok → `affects` ilişki adayı. |
| `same-source` | İki not aynı `source_ref` yolunu gösteriyor. İkisi de bağlayıcıysa (decision accepted/proposed, preference active) çelişki adayı; biri evidence ise `originated_from`, değilse `affects`. |
| `shared-affects` | Aynı türde iki bağlayıcı not aynı hedefi `affects` ediyor → çelişki adayı. |

Adaylar yalnız gösterilir veya `candidateToProposal` ile kuyruğa girer; hiçbir aday kendiliğinden nota yazılmaz.

## 7. `syn memory` komutları

| Komut | Davranış |
| --- | --- |
| `status` | Vault yolu, proje/branch, "N geçerli karar, N açık varsayım, N açık soru, N olası çelişki" özeti, tür/durum sayıları, bekleyen öneri, stale notlar, kırık bağlantı, geçersiz/yinelenen notlar. |
| `search <metin...> [--kind k]... [--all] [--limit n]` | Sonuç başına id, tür/durum, `[STALE]`, başlık, yol ve gerekçe. |
| `show <id>` | Özellikler, kaynak ve tazelik durumu, ilişkiler, mutlak yol ve not içeriği. |
| `related <id>` | İlişkiler, geri referanslar, bağlantılar, backlink'ler ve incelenmemiş adaylar. |
| `review` | `pending`/`deferred` öneriler, gerekçe ve kanıt. |
| `accept <proposal-id> [--reason metin]`, `reject ...` | Kullanıcı kararı (`by: user`). |
| `open <id> [--in obsidian]` | Bayraksız: notu CLI'da gösterir. `--in obsidian`: `obsidian://open?path=<kodlanmış mutlak yol>` URI'sini işletim sisteminin URL işleyicisine verir; Obsidian kurulu görünmüyorsa veya başlatılamazsa URI'yi yazar ve notu CLI'da gösterir. Obsidian API'si, eklentisi, CLI'ı veya ağ çağrısı yoktur. |
| `reindex` | İndeksi yeniden kurar; kırık bağlantıları, geçersiz notları ve yinelenen id'leri listeler. |

Ortak seçenekler: `--root <dizin>` (vault kökünü geçersiz kılar), `--branch <ad>` (varsayılan: `cwd`'deki Git checkout'unun `HEAD`'i; worktree `.git` dosyası desteklenir). Proje kimliği `deriveProjectId(cwd, platform)` ile türetilir. Çıkış kodları: başarı `0`, kullanım hatası `2`, bilinmeyen not `1`, `HarnessError` kendi `exitCode`'u.

## 8. Bilinen sınırlar

- `memory.team_root` (ekip vault'u) bu dilimde çözülmez; ekip vault'unda da decision/preference zaten yalnız kuyruk yoluyla yazılabilir.
- Kullanıcının orchestrator kararını geri alması için ayrı bir komut yoktur; ters yönde bir `status-change` önerisiyle yapılır.
- Digest kontrolü ile `rename` arasında küçük bir yarış penceresi vardır; aynı milisaniyede aynı boyutta yapılan dış düzenleme indeksi bir okuma boyunca eski bırakabilir (yazma güvenliği etkilenmez, çünkü çakışma kontrolü her zaman dosyanın kendisinden hesaplanır).

## 9. Sözleşme değişiklik istekleri (Dalga 2a sonucu)

| # | İstek | Karar |
| --- | --- | --- |
| 1 | `MemoryStore.decide` audit sonucunu döndürsün (`decideWithAudit` yerine) | **Çözüldü:** `decide(...) → MemoryDecisionOutcome` (`proposal`, `decided`, `persisted?`, `runId`); yükler `memory/proposal_decided` ve `memory/persisted` olaylarının `data` tipindedir. `decideWithAudit` ve yerel `ProposalDecidedAudit`/`PersistedAudit` silindi. |
| 2 | `MemoryConfig` sözleşmeye | **Çözüldü:** `memoryConfigSchema` (`root?`, `team_root?`, strict) ve örnekleri; yerel arayüz silindi. `team_root` hâlâ ayrılmış (okunmaz/yazılmaz). |
