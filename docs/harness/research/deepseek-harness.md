# DeepSeek Harness incelemesi

> İncelenen kaynak: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) ve [resmi mimari](https://deepseek-harness.github.io/deepseek-harness/en/reference/), 2026-09-22. Proje geliştirici önizlemesinde; uyumluluk kıran değişiklikler bekleniyor.

## Ürün bileşimi

DeepSeek Harness, Cordis üstünde model adaptörü, tool registry, session log ve agent loop dahil kabiliyetleri plugin olarak kuruyor. `web`, `headless`, `sdk`, `sdk-minimal`, `acp` gibi profiller paket/bundle katmanlarıyla birleşiyor; config patch bir plugin satırının tüm config'ini değiştirebiliyor. Bu mimari son derece esnek ama Synorch CLI MVP'si için tam kopyası büyük bir bakım alanı yaratır. [Mimari](https://deepseek-harness.github.io/deepseek-harness/en/reference/).

## Çekirdekten alınan teknik dersler

1. **Agent API ile loop implementasyonu ayrımı.** `core/agent` handle ve olayları, `core/agent-loop` varsayılan sürücüyü sağlıyor; UI ve extension'lar loop'a değil handle'a dayanıyor. Synorch'ta da orchestrator, CLI ve hook kodu model döngüsünün iç sınıflarına bağımlı olmamalı. [Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core).
2. **Model görünürlüğü yeniden üretilebilir olmalı.** Session append-only tipli olay günlüğü; request history logdan türetiliyor. Araç sonuçları ve injected context kalıcı olay olarak kaydediliyor. Synorch'ta aynı girdilerle “model ne gördü?” sorusu cevaplanabilmeli. [Session](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session).
3. **Turn/step ayrımı.** Bir step model isteği ve onun araç çağrıları; bir turn sıfır veya daha fazla step. Bu sayede timeout, tool sonrası tekrar istek ve iptal ayrı izlenir. [Mimari turn flow](https://deepseek-harness.github.io/deepseek-harness/en/reference/).
4. **Araç hattı tek giriş noktası.** Registry, görünürlük ve dispatch tek resolver üzerinden; pre/execute/post aşamaları var. Synorch'ta bütün araçlar aynı policy ve audit hattından geçmeli. [Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools).
5. **Onay sonucu kapalı küme ve fail-closed.** Tek eylemlik izin, ret, iptal, cevaplayıcı yok durumları ayrı; `unavailable` geçiş izni değil. [Approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval).
6. **Sandbox uygulanma düzeyi raporlanıyor.** `full`/`partial` ayrımı ve platform farkları açık; dosya erişim modu ağ/process izolasyonu anlamına gelmiyor. Synorch bunu capability probe ve CLI çıktısına taşımayı hedeflemeli. [Sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox).

## Dokümantasyon mimarisi dersi

DeepSeek'in [doküman standardı](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) mimari harita, subsystem referansı, paket kontratı, karar gerekçesi, cookbook ve üretilmiş referansı ayırıyor. Bir bilginin tek sahibi olması, büyüyen harness belgelerinde drift'i azaltır. Bu dizinde de araştırma, tasarım, teslim ve açık kararlar ayrı tutuldu.

## Synorch için sınır

Plugin mimarisi *opsiyonel değiştirilebilirlik* için yararlıdır; ilk sürümde her primitive'in plugin olmasını gerektirmez. Özellikle persistence, policy, tool dispatcher ve provider adaptörü sınırları açık interface olmalı; dynamic plugin unload/HMR ve web client kompozisyonu daha sonraki ihtiyaç olarak değerlendirilmelidir. Kaynak kodu doğrudan taşınacaksa lisans ve bağımlılık incelemesi ayrıca yapılır.
