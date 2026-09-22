# Açık kararlar ve ADR kuyruğu

> Statü: kuyruktaki bütün kararlar 2026-09-22'de ADR olarak kaydedildi ve `Accepted` statüsündedir; normatif metin [karar kayıtlarındadır](../decisions/README.md). Bu dosya kuyruğun tarihçesini ve ilk önerilerle verilen kararı yan yana tutar. `Accepted` kodun uygulandığı anlamına gelmez; `Implemented` statüsü kod/test kanıtıyla verilir.

| ID | Karar sorusu | İlk önerilen başlangıç | Karar | Kapatmak için kanıt |
| --- | --- | --- | --- | --- |
| ADR-01 | Runtime mevcut pakette mi ayrı workspace paketinde mi? | Aynı monorepoda ayrı runtime paketi | [Tek `synorch` paketi; runtime `src/harness/*` iç modülleri, yalnız `contracts` üzerinden bağlı; yeni komutlar dinamik import](../decisions/ADR-01-package-boundary.md) | Canonical şema paylaşımı, npm dağıtımı ve eski `syn` komut uyumu |
| ADR-02 | Agent loop/plugin sınırı | Sabit küçük loop + provider/tool/storage interface'leri | [Sabit `AgentDriver`; seam'ler `contracts` arayüzleri; dinamik plugin yok](../decisions/ADR-02-agent-loop-seams.md) | İkinci implementasyon ihtiyacı ve test seam'leri |
| ADR-03 | Session depolama | Yerel SQLite/WAL adayı; JSONL alternatifi | [Segmentli append-only JSONL + lease + içerik adresli blob](../decisions/ADR-03-session-store.md) | Windows crash/locking, replay, migration ve okunabilirlik deneyi |
| ADR-04 | Terminal renderer | Node TUI kütüphanesi veya minimal ANSI | [`@earendil-works/pi-tui@0.87.0` adapter arkasında; bağımlılıksız plain ve JSONL renderer](../decisions/ADR-04-terminal-renderer.md) | Windows/SSH/CI, screen reader, resize ve stream testi |
| ADR-05 | İlk provider ve resmi auth | Kullanıcının erişebildiği resmi API | [OpenAI ChatGPT OAuth + API key; Anthropic API key + Claude Code `cli-bridge`; doğrudan Claude OAuth yok](../decisions/ADR-05-provider-auth.md) | SDK şartları, cancellation, usage ve streaming deneyi |
| ADR-06 | Sandbox tabanı | OS bazlı probe + fail-closed policy | [Gateway policy enforcement + OS backend probe; Windows v1 `partial`, açıkça raporlanır](../decisions/ADR-06-sandbox.md) | Windows junction/hardlink, macOS/Linux test matrisi |
| ADR-07 | Worker izolasyonu | Yazabilen worker'a worktree; explorer read-only | [Git'te attempt başına worktree, aksi halde `scoped-dir`; okuyucular `shared-read-only`](../decisions/ADR-07-worker-isolation.md) | Merge maliyeti, untracked dosyalar, Windows performansı |
| ADR-08 | Approval sıklığı | Plan digest + etki kapsamı; aynı onayı tekrar isteme | [Varsayılan `autonomous`, prompt yok; hard rail'ler ret; `ask` açık sıkı mod](../decisions/ADR-08-approval-policy.md) | Mevcut "her görev onayı" kuralıyla uyum ve trivial iş UX testi |
| ADR-09 | Reviewer bağımsızlığı | Ayrı context ve sabit artifact; farklı model tercih | [Ayrı context, taze packet, `met` için reviewer kanıtı zorunlu](../decisions/ADR-09-reviewer-independence.md) | Maliyet ve bulgu kalitesi ölçümü |
| ADR-10 | Debugger yazma yetkisi | Varsayılan RCA-only | [Varsayılan `rca-only`; yazma yalnız açık `owned_paths` ile](../decisions/ADR-10-debugger-write.md) | Gerçek hata giderme akışları ve role policy testi |
| ADR-11 | Başlangıç compaction | Tek özet yöntemi + kaynak aralığı | [Tek yöntem `summary-v1`, orijinaller silinmez, thrash hatası](../decisions/ADR-11-compaction.md) | Replay ve uzun task kalite testi |
| ADR-12 | Plugin/extension dağıtımı | İlk sürümde yalnızca yerleşik adaptörler | [v1'de yalnız yerleşik adapter ve araçlar](../decisions/ADR-12-extensions.md) | Üçüncü taraf kod güvenliği ve sürüm uyumu |
| ADR-13 | MCP/ACP kapsamı | MCP tool client sonra, ACP host daha sonra | [Dahili MCP server yalnız köprü araç kanalı; MCP istemcisi Faz 4](../decisions/ADR-13-mcp-acp.md) | CLI kullanım talebi ve protokol uyumluluk testi |
| ADR-14 | Bütçe aşımı | Yeni istekleri durdur, aktif isteği politika ile bitir/iptal et | [Limitte yeni istek yok; %120'de aktif iptal; artırım insan-only](../decisions/ADR-14-budget.md) | Sağlayıcı usage gecikmesi ve maliyet simülasyonu |
| ADR-15 | Headless approval | Varsayılan `unavailable → deny` | [Headless da otonom; insan gereken her şey `unavailable` → exit 3; dış etkiler allowlist'e bağlı](../decisions/ADR-15-headless.md) | CI senaryosu ve makine API tasarımı |
| ADR-16 | Hafıza konumu | — (Obsidian belgesi açık kararı) | [Kişisel hafıza `~/.synorch/memory/<project-id>/`; repo içi ekip vault'u opt-in; Obsidian isteğe bağlı](../decisions/ADR-16-memory-location.md) | Obsidian olmadan çalışma ve gizlilik ayrımı |
| ADR-17 | Hafıza yazma politikası | — (Obsidian belgesi açık kararı) | [evidence/concept/assumption/question otomatik; decision/preference/çelişki review kuyruğu, orchestrator audit'li kabul](../decisions/ADR-17-memory-write-policy.md) | Kullanıcı geri alma oranı ve yanlış öneri testi |

## ADR şablonu

Her karar dosyasında şu alanlar bulunmalı: `Status`, `Date`, `Context`, `Decision`, `Alternatives`, `Consequences`, `Evidence`, `Verification`, `Revisit trigger`. Örnek karşılaştırma, tahmini performans yerine ölçülmüş veri içermeli. Yeni karar, eski tasarım metnindeki varsayımı değiştiriyorsa bağlantılı belgeler aynı değişiklikte güncellenmeli.

## Ürün sahibinden netleştirilen tercihler

1. **İlk kullanıcı:** Bireysel geliştiricinin yerel CLI'ı; headless/CI de otonom çalışır ([ADR-15](../decisions/ADR-15-headless.md)). — *Cevaplandı.*
2. **Sağlayıcı/model erişim yolu:** Abonelik girişi zorunlu: OpenAI ChatGPT aboneliği doğrudan OAuth ile, Claude aboneliği kullanıcının kendi Claude Code kurulumunu süren `cli-bridge` ile; iki sağlayıcıda da API key yedek ([ADR-05](../decisions/ADR-05-provider-auth.md)). — *Cevaplandı.*
3. **Terminal:** Arayüz Windows, macOS, Linux ve SSH'de çalışmalı; OMP yaklaşımı referans ([ADR-04](../decisions/ADR-04-terminal-renderer.md)). — *Cevaplandı.* ("Claude Code'daki sıkıntılar" listesi hâlâ hipotezdir.)
4. **Onay:** Orchestrator tam yetkili ve otonom; eylem başına onay yok; prompt olmayan hard rail'ler ve audit korunur; `ask` açık sıkı mod ([ADR-08](../decisions/ADR-08-approval-policy.md)). — *Cevaplandı.*
