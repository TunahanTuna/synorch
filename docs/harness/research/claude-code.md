# Claude Code incelemesi

> “CloudCode” ifadesi Claude Code olarak yorumlandı. Kanıt düzeyi: Anthropic'in resmi ürün belgeleri; CLI iç kaynak kodu değil.

## Belgelenen davranış

Claude Code, bağlam toplama → eylem → doğrulama çevrimini; dosya, shell, web ve harici araçlarla yürütüyor. Kullanıcı çalışma sırasında interrupt/steer edebiliyor. Oturumlar yerel JSONL'ye kaydediliyor; resume/fork, checkpoint, compaction ve ayrık subagent context pencereleri belgelenmiş. [Nasıl çalışır](https://code.claude.com/docs/en/how-claude-code-works).

[Permissions](https://code.claude.com/docs/en/permissions) belgelediği gibi izin kuralı prompt'tan ayrı ve runtime tarafından uygulanıyor; `deny → ask → allow` önceliği var. [Sandboxing](https://code.claude.com/docs/en/sandboxing), shell erişimi için ayrı bir sınır. [Hooks](https://code.claude.com/docs/en/hooks), session, turn, tool, child, compaction gibi olaylarda komut/HTTP/MCP/prompt/agent handler çalıştırabiliyor. [Subagents](https://code.claude.com/docs/en/sub-agents) ayrı bağlamla delegasyonu, [headless](https://code.claude.com/docs/en/headless) programatik CLI kullanımını tarif ediyor.

## Kaynak kodu sınırı

[Anthropic'in resmi GitHub deposu](https://github.com/anthropics/claude-code), CLI iç mimarisini incelemek için tam kaynak ağacı sunmuyor. Bu nedenle gizli sınıflar, algoritmalar veya dosya yapısı üzerine iddia kurulmamalı. Açık belge yüzeyi, davranış ve CLI ergonomisi için referanstır. Bir GitHub issue'su bu eksikliği ayrıca dile getiriyor; issue'nun kendisi resmi mimari sözleşmesi değildir: [#47465](https://github.com/anthropics/claude-code/issues/47465).

## Synorch'un çözmek istediği sürtünmeler

Bunlar Claude Code'a doğrulanmış genel kusur atfı değil; Synorch için ürün gereksinimidir:

- **Görünür yetki:** Kullanıcı hangi rolün hangi dosya/araç/ağa ulaşabildiğini komuttan görebilmeli.
- **Kanıtlı delegasyon:** Worker'ın giriş paketi, dosya sahipliği, çıktı paketi ve reviewer'ın bağımsız kanıtı kalıcı olmalı.
- **Açıklanabilir bağlam:** Compaction ve dosya okuma sonrasında modele gönderilen mesaj seti denetlenebilmeli.
- **Kontrollü toparlanma:** Timeout, iptal, crash, rate limit ve provider değişimi sessizce “başarılı” görünmemeli.
- **Maliyet sınırı:** Token/çağrı/zaman/worker bütçesi task bazında uygulanmalı; gerçek provider ölçümü ile tahmin ayrılmalı.
- **Az tekrar:** Aynı plan veya profili gereksiz yere yeniden onaylatmayan ama yetki değişince durabilen açık karar mantığı olmalı.

## Tasarımda neye bakılmalı?

Claude Code'un terminal yanıt verme hızı, streaming durumu, `Esc` ile kesme, çalışırken yönlendirme, komut yardım metni, resume ve headless mod ergonomisi deneyim benchmark'ı olarak alınabilir. Yetki ve otomasyon sınırlarında ise kopya davranış yerine Synorch'un kendi [güvenlik sözleşmesi](../design/tools-and-security.md) uygulanmalı.
