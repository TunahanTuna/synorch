# Harness karşılaştırması ve Synorch'a aktarılacak dersler

> Bu tablo özellik yarışı değil, tasarım referansıdır. Kaynak ayrıntıları [kaynak dizininde](./sources.md).

| Konu | Oh My Pi | DeepSeek Harness | Claude Code | Synorch için öneri |
| --- | --- | --- | --- | --- |
| Çekirdek | Pi temelli agent loop, zengin kod araçları | Cordis ile plugin bileşimi; loop dahil değiştirilebilir | Resmi belgede agentic loop; iç kaynak kapalı | Küçük ve sabit loop, sürümlü capability arayüzleri |
| Oturum | JSONL, append-only ağaç, leaf ve branch | Tipli append-only event log; model geçmişi logdan türetilir | Yerel JSONL, resume/fork ve checkpoint | Tipli olay günlüğü + projection, crash recovery |
| Araçlar | Zengin built-in set, extension/tool API | Registry + pre/execute/post hattı | Dosya, shell, web, MCP ve hook | Az sayıda güvenilir çekirdek araç; ek araçları capability olarak |
| Delegasyon | Kalıcı/park edilebilir child, concurrency ve izolasyon seçenekleri | Agent handle, subagent capability | Ayrı context pencereli subagents | Synorch task packet + sahiplik + reviewer bağımsızlığı |
| Güvenlik | Approval tier/pattern; kendi belgesi bunun containment olmadığını açıkça belirtir | Ayrı approval seam ve sandbox enforcement raporu | Permission mode, rule ve sandbox | Prompt dışı policy; gerçek sandbox durumu açık; fail-closed |
| Genişletme | İn-process extension ve hook olayları | Her kabiliyet plugin; bundle/profile | Hook, skill, MCP ve subagent | Başta dar eklenti sınırı, lifecycle ve izolasyon şartı |
| Arayüz | Terminal + RPC/ACP modları | Web, headless, SDK/ACP profilleri | CLI, headless ve diğer yüzeyler | Terminal ilk ürün; makine modu ayrı, sürümlü JSONL |

## Alınacak tasarım fikirleri

1. **DSH'den:** Modelin gördüğü bilgi kalıcı logdan yeniden kurulabilir olmalı. İç olay ile model görünürlüğü birbirine karıştırılmamalı. [Mimari](https://deepseek-harness.github.io/deepseek-harness/en/reference/).
2. **OMP'den:** Branch/replay, kontrol edilebilir compaction ve child yaşam döngüsü açık sözleşme gerektirir. Özellikle child'ın yeniden canlanması ve izolasyon birer durum geçişidir. [Session](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md), [task](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md).
3. **Claude Code'dan:** Terminalde interrupt/steer/resume, kullanıcıya görünür izin akışı ve hook olayları ürün deneyimi için referanstır. [Nasıl çalışır](https://code.claude.com/docs/en/how-claude-code-works).
4. **Synorch'un farkı:** Rol ve protokollerin sadece prompt'ta bulunması yerine task DAG, dosya sahipliği, model yönlendirmesi, onay ve bağımsız inceleme runtime tarafından doğrulanır. [Bugünkü temel](../foundation/current-state.md).

## Kopyalanmaması gereken varsayımlar

- “Her şey plugin” yaklaşımı küçük CLI için otomatik fayda sağlamaz. Plugin yükleme, sürümleme, yetki ve hata alanı maliyeti vardır. Önce core seam'ler belirlenmeli.
- Çok sayıda built-in tool modele sürekli gösterilmemeli. Araç keşfi ve bağlam maliyeti ölçülmeli.
- Approval paterni process sandbox yerine geçmez; OMP belgesi de bunu açıkça söylüyor. [Approval mode](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md).
- Claude Code davranışı belgelenmiş olsa bile kapalı çekirdek üzerine uyumluluk garantisi kurulamaz. [Resmi repo](https://github.com/anthropics/claude-code).
- Bir modelin “bitti” demesi teslim için yeterli değildir; kanıt ve reviewer zinciri gerekir.

## Seçim ölçütü

Bir upstream fikri ancak şu soruları cevapladığında Synorch'a alınmalı: kullanıcı problemi nedir, hangi runtime invariant'ı gerekir, hangi veri kalıcıdır, kimin yetkisi vardır, nasıl test edilir, hata sonrası ne olur, eski Synorch dosyalarıyla uyumu nedir?
