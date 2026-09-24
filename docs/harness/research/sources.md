# Kaynaklar ve araştırma yöntemi

> Web incelemesi: 2026-09-22. Öncelik: projenin kendi deposu ve resmi belgeleri. `main`/`master` bağlantıları hareketlidir; uygulama öncesi commit SHA sabitlenmeli.

## Temel kaynaklar

| ID | Kaynak | Kanıt değeri |
| --- | --- | --- |
| OMP-1 | [Oh My Pi resmi depo ve README](https://github.com/can1357/oh-my-pi) | Açık kaynak ürün yüzeyi |
| OMP-2 | [Agent döngüsü paketi](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/README.md) | Tool/agent API |
| OMP-3 | [Session storage](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md) | JSONL, ağaç ve replay |
| OMP-4 | [Compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) | Bağlam bakımı |
| OMP-5 | [Task/subagent aracı](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) | Paralellik, yaşam döngüsü, izolasyon |
| OMP-6 | [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) ve [approval mode](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md) | Genişletme ve yetki sınırı |
| OMP-7 | [RPC protokolü](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) | Stdio ile host entegrasyonu |
| DSH-1 | [DeepSeek Harness resmi depo](https://github.com/deepseek-ai/deepseek-harness) ve [mimari](https://deepseek-harness.github.io/deepseek-harness/en/reference/) | Plugin bileşimi ve ürün statüsü |
| DSH-2 | [Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core), [session](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session), [tool](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools) | Döngü, kalıcı olaylar, araç hattı |
| DSH-3 | [Subagent](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent), [approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval), [sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox) | Yetki ve izolasyon |
| DSH-4 | [Compaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction) ve [geliştirici doküman standardı](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) | Replay ve belgelerin hiyerarşisi |
| CC-1 | [Claude Code nasıl çalışır](https://code.claude.com/docs/en/how-claude-code-works) | Resmi davranış tarifi |
| CC-2 | [Permissions](https://code.claude.com/docs/en/permissions), [sandboxing](https://code.claude.com/docs/en/sandboxing), [hooks](https://code.claude.com/docs/en/hooks) | Yetki ve yaşam döngüsü |
| CC-3 | [Subagents](https://code.claude.com/docs/en/sub-agents), [headless](https://code.claude.com/docs/en/headless) | Delegasyon ve CLI otomasyonu |
| CC-4 | [Anthropic'in Claude Code deposu](https://github.com/anthropics/claude-code) | Resmi dağıtım/depo yüzeyi; CLI çekirdeği için kaynak referansı değil |
| STD-1 | [Model Context Protocol mimarisi](https://modelcontextprotocol.io/specification/2025-06-18/architecture) | Harici araç entegrasyonu için protokol referansı |

## Kanıt kuralları

1. Dokümante edilen dış davranış, kaynak kodu görülen iç davranış ve bizim tasarım çıkarımımız ayrı belirtilir.
2. GitHub issue'ları bir risk hipotezi kurabilir; tek başına yaygın ürün kusuru kanıtı değildir.
3. Yıldız sayısı, benchmark iddiası veya tanıtım metni mimari seçim için kanıt sayılmaz.
4. Lisans doğrulaması kod taşıma kararından önce ayrı yapılır. Bu dosya **tasarım incelemesidir**, kod kopyalama izni vermez.
5. Sürüm/özellik bilgisi oynaktır; uygulama sprintinde ilgili upstream commit ve doküman tarihi kaydedilir.

## Araştırma sınırı

Claude Code'un resmi GitHub deposu CLI çekirdeğinin kaynak ağacı değil; bu nedenle özel iç implementasyonuna dair iddia yok. OMP ve DeepSeek için yayımlanmış kod ve kendi mimari belgeleri kullanıldı. Synorch'a ilişkin tespitler yerel çalışma ağacından yapıldı.

- TUI ve agent döngüsü araştırması (2026-09-22; pi `27c072e`, OMP `8cd6f8c`, Ink `02ae1e5`): [TUI araştırması ve ADR-04 önerisi](./tui/README.md), [pi/OMP agent kalıpları](./tui/pi-agent-patterns.md), [çapraz platform kontrol listesi](./tui/cross-platform-checklist.md).
- Sağlayıcı kimlik doğrulama araştırması (2026-09-22; codex `d93909a`, hermes-agent `71a2fe3`, pi `27c072e`, OMP `8cd6f8c`, opencode `2406400`): [abonelik OAuth, CLI köprüleri ve API key özeti](./provider-auth/README.md), [öneri](./provider-auth/recommendation.md).
- Yetenek boşluğu araştırması, K4.0 (2026-09-24; codex `35aaa5d9`/`27c05a52`, OMP `c0d0ad76`): [bulgular, boşluk matrisi ve kaynaklar](./capabilities/README.md), [K4 önerisi: internet, eksik araçlar, güvenlik tasarımı](./capabilities/recommendation.md).
