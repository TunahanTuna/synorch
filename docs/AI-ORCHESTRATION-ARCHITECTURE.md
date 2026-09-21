# Synorch — Mimari ve Uygulanan Yapı

> Durum: Çalıştırılabilir çekirdek uygulanmış durumda
> Son güncelleme: 2026-09-20  
> Amaç: Codex ve Claude Code üzerinde çalışan, orchestrator merkezli, agent/skill/protokol tabanlı ve token-verimli bir geliştirme organizasyonu kurmak.

## 1. Ürün Tanımı

Bu proje bir model runtime'ı, sürekli çalışan agent harness'i veya alternatif bir coding assistant değildir.

Ürün adı **Synorch**'tur. NPM paket adı `synorch`, birincil terminal komutu `syn`, keşfedilebilir uzun executable alias'ı ise `synorch` olarak tanımlanır.

Ürün; boş bir klasöre, mevcut bir repository'ye veya birden fazla repository içeren workspace'e çalıştırıldığında AI geliştirme çalışma sistemini kuran bir CLI'dır. Kurulumdan sonra günlük geliştirme doğrudan Codex veya Claude Code üzerinden devam eder.

CLI'nin sorumlulukları:

- Provider'dan bağımsız agent, skill ve protokol tanımlarını kurmak.
- Bu tanımları Codex ve Claude Code'un desteklediği yapılara uyarlamak.
- Boş klasör, mevcut repository ve çoklu-repository workspace senaryolarını desteklemek.
- Manuel tetiklenen keşif/senkronizasyon işlemleriyle yeni repository'leri sisteme kaydetmek.
- Yapının tutarlılığını ve provider kabiliyetlerini denetlemek.

CLI'nin sorumluluğunda olmayanlar:

- Geliştirme sırasında sürekli çalışan bir orchestration runtime'ı olmak.
- Kendi model konuşma döngüsünü veya tool-calling altyapısını işletmek.
- Kullanıcı istemeden proje mimarisi, framework veya teknoloji seçmek.
- Boş klasörde hayali proje bilgileri üretmek.
- Codex veya Claude Code'un desteklemediği özellikleri yalnızca prompt dosyalarıyla varmış gibi göstermek.

## 2. Temel Tasarım İlkeleri

1. **Tek karar merkezi:** Kullanıcı yalnızca orchestrator ile iletişim kurar.
2. **Orchestrator kod yazmaz:** Analiz, planlama, delegasyon, izleme ve nihai karar orchestrator'a; uygulama worker agent'lara aittir.
3. **Her iş planlanır:** Uygulama başlamadan önce analiz ve kullanıcıya sunulan bir plan bulunur.
4. **Kanıta dayalı çalışma:** Bilinmeyen bilgiler tahmin edilmez; gerçekler kaynaklarıyla kaydedilir.
5. **Progressive disclosure:** Bir agent yalnızca görevi için gerekli talimat ve context'i alır.
6. **Yeniden keşfi önleme:** Worker'lara göreve özel, kaynak gösteren bir context paketi aktarılır.
7. **Bağımsız doğrulama:** Implementasyonu yapan agent kendi işinin tek nihai denetçisi olamaz.
8. **Provider bağımsız çekirdek:** Roller ve protokoller ortak tanımlanır; Codex ve Claude Code için adapter'lar üretilir.
9. **Maliyet bilinçli model seçimi:** Güçlü model yalnızca güçlü muhakeme gerektiğinde kullanılır.
10. **Açık sınırlar:** Provider'ın teknik olarak garanti edemediği davranışlar `doctor` tarafından raporlanır.

## 3. Çalışma Kapsamları

### 3.1 Workspace modu

Ortak AI sistemi bir üst klasörde, repository'ler alt klasörlerde bulunur:

```text
workspace/
├── AGENTS.md
├── CLAUDE.md
├── .ai/
├── repo-a/
└── repo-b/
```

Agent Codex veya Claude Code ile workspace kökünde başlatıldığında ortak protokolleri ve skill'leri kullanır. Repository'ler birbirinden ayrı proje kayıtları olarak ele alınır.

### 3.2 Repository modu

AI yapısı doğrudan repository içinde bulunur:

```text
my-repo/
├── .git/
├── AGENTS.md
├── CLAUDE.md
├── .ai/
└── src/
```

Bu yapı Git ile paylaşılabilir ve ekip genelinde kullanılabilir.

### 3.3 Boş klasör davranışı

Boş klasörde proje analizi veya AI tabanlı mimari üretimi yapılmaz. Yalnızca generic orchestration çekirdeği kurulur ve workspace proje listesi boş başlar.

```yaml
schema_version: 1
scope: workspace
projects: []
```

## 4. CLI Yaşam Döngüsü

Uygulanan komutlar:

```text
syn inspect
syn init
syn sync [--force]
syn doctor
```

- `init`: Agent/skill/protokol çekirdeğini ve provider adapter'larını kurar.
- `inspect`: Yazma yapmadan önce kurulacak veya değişecek yapıyı gösterir.
- `sync`: Manuel olarak tetiklenir; modülleri ve kanıtları keşfeder, proje kayıtlarını ve skill registry'lerini senkronize eder. Farklılaştırılmış generated teknoloji skill'lerini varsayılan olarak korur; yalnızca açık `--force` ile yeniler.
- `doctor`: Canonical yapılandırmayı, proje → record → skill registry → skill dosyası referans zincirini ve dosya sistemi sınırlarını doğrular.

Arka planda çalışan watcher veya daemon planlanmamaktadır. Yeni bir repository eklendiğinde kullanıcı `sync` çalıştırabilir. Tam yeniden `init` gerekmez.

## 5. Uygulanan Başlangıç Dosya Yapısı

```text
.ai/
├── manifest.yaml
├── constitution.md
├── workspace.yaml
├── projects/
│   ├── <project-id>.yaml
│   └── <project-id>.skills.yaml
├── protocols/
│   ├── registry.yaml
│   ├── core/
│   │   ├── orchestration.md
│   │   ├── planning-and-approval.md
│   │   ├── delegation.md
│   │   ├── model-routing.md
│   │   ├── context-handoff.md
│   │   ├── verification.md
│   │   ├── failure-recovery.md
│   │   └── user-communication.md
├── agents/
│   ├── orchestrator/AGENT.md
│   ├── explorer/AGENT.md
│   ├── implementer/AGENT.md
│   ├── reviewer/AGENT.md
│   └── debugger/AGENT.md
├── skills/
│   ├── planning/SKILL.md
│   ├── project-discovery/SKILL.md
│   ├── codebase-exploration/SKILL.md
│   ├── implementation/SKILL.md
│   ├── verification/SKILL.md
│   ├── debugging/SKILL.md
│   ├── code-review/SKILL.md
│   └── technology/
│       └── <selected-skill>/SKILL.md
├── model-profiles/
│   ├── openai.yaml
│   └── claude.yaml
├── tasks/
│   └── .gitkeep
└── providers/
    ├── codex.md
    └── claude-code.md
```

`tasks/` çalışma kayıtlarının kalıcı mı, geçici mi ve Git'e dahil olup olmayacağı daha sonra kesinleştirilecektir.

## 6. Orchestrator Modeli

Orchestrator kontrol düzlemidir. Worker agent'lar uygulama düzlemidir.

```text
Kullanıcı
   │
   ▼
Orchestrator
   ├── Explorer
   ├── Implementer
   ├── Debugger
   └── Reviewer
```

### 6.1 Orchestrator'ın sorumlulukları

- Kullanıcıdan işi almak ve hedefi netleştirmek.
- Repository veya workspace hakkında gerekli analizi yapmak ya da explorer'a yaptırmak.
- Mimari ve uygulama kararlarını vermek.
- Her iş için plan hazırlamak ve kullanıcıya sunmak.
- İşi bağımsız görevlere bölmek ve bir görev bağımlılık grafiği oluşturmak.
- Her görev için doğru worker türünü ve model seviyesini seçmek.
- Worker'lara yeterli ve sınırlandırılmış context aktarmak.
- Paralel işleri koordine etmek ve dosya sahipliği çakışmalarını önlemek.
- Worker raporlarını, diff'leri ve doğrulama kanıtlarını değerlendirmek.
- Yalnızca `.ai/tasks/**` altındaki plan, context packet, karar günlüğü ve orchestration metadata'sını oluşturmak/güncellemek.
- Nihai sonucu yalnızca kendisinin kullanıcıya raporlaması.

### 6.2 Orchestrator'ın yasakları

- Üretim, test, config veya dokümantasyon kodunu doğrudan yazmak ya da düzenlemek.
- `.ai/tasks/**` dışındaki proje dosyalarına doğrudan yazmak.
- “İş küçük” gerekçesiyle worker rolünü üstlenmek.
- Kullanıcı onayı gereken planı sessizce uygulamaya geçirmek.
- Worker'ın iddiasını kanıt olmadan kabul etmek.
- Başarısız worker'ın işini kendisi tamamlamak.
- Uygulama worker'larını kullanıcıyla doğrudan iletişime yönlendirmek.

Orchestrator dosya okuyabilir, arama yapabilir, diff ve test sonuçlarını inceleyebilir ve kontrol-düzlemi artifact'larını `.ai/tasks/**` altında tutabilir. Ürün dosyalarına yazma yetkisinin prompt seviyesinde mi yoksa provider izinleriyle teknik olarak mı sınırlandırılabileceği adapter bazında belirlenecektir.

## 7. Ana Orchestration Protokolü

Ana protokol `constitutional` önceliğe sahip, zorunlu ve alt seviye protokoller tarafından geçersiz kılınamaz olmalıdır.

Örnek invariant'lar:

```yaml
id: core.orchestration
version: 1.0.0
priority: constitutional
mandatory: true
overridable: false

invariants:
  - orchestrator_never_writes_code
  - only_orchestrator_communicates_with_user
  - every_task_is_planned
  - execution_requires_user_approval
  - all_implementation_is_delegated
  - implementation_requires_independent_verification
  - worker_uncertainty_is_escalated_to_orchestrator
```

### 7.1 Görev durum makinesi

```text
SESSION_BOOTSTRAP
  ↓
MODEL_PROFILE_CONFIRMATION
  ↓
INTAKE
  ↓
DISCOVERY
  ↓
CLARIFICATION
  ↓
PLAN
  ↓
USER_APPROVAL
  ↓
DECOMPOSITION
  ↓
DISPATCH
  ↓
MONITORING
  ↓
VERIFICATION
  ↓
REVIEW
  ↓
FINAL_REPORT
```

`MODEL_PROFILE_CONFIRMATION` her yeni session'da ilk görev başlamadan önce zorunludur. Orchestrator aktif provider'ı, kendi modelini, worker model eşlemelerini, routing modunu ve geçerli override'ları kullanıcıya gösterir. Kullanıcı mevcut profille devam edebilir veya değişiklik isteyebilir.

Bu onay session başına bir kez alınır. Provider/model uygunluğu değişirse, session sırasında profile override uygulanırsa veya orchestrator modeliyle ilgili bir uyuşmazlık tespit edilirse kapı yeniden açılır.

Varsayılan onay politikası:

```yaml
approval:
  before_execution: always
```

## 8. Agent ve Skill Ayrımı

### 8.1 Agent

Agent “kim, hangi yetkiyle ve hangi sorumlulukla çalışıyor?” sorusunu cevaplar.

Agent tanımı şunları içerir:

- Rol ve amaç
- Yetkili/yasak işlemler
- Sahip olduğu sorumluluk
- Kullanabileceği skill'ler
- Delegasyon ve escalation sınırları
- Beklenen rapor formatı
- Tamamlama koşulları

Başlangıç rolleri:

- `orchestrator`: Karar, planlama ve koordinasyon.
- `explorer`: Salt-okunur araştırma ve kanıt toplama.
- `implementer`: Kendisine verilen kapsamda uygulama.
- `debugger`: Belirti, hipotez, kanıt ve kök neden analizi.
- `reviewer`: Uygulamadan bağımsız değerlendirme.

Yeni bir çalışma yöntemi gerekiyorsa önce skill oluşturulur. Ancak farklı yetki, bağımsızlık veya sorumluluk gerekiyorsa yeni agent tanımlanır.

### 8.2 Skill

Skill “belirli bir iş güvenilir ve tekrar edilebilir biçimde nasıl yapılır?” sorusunu cevaplar.

Her skill en az şunları içermelidir:

- Açık tetikleme koşulları
- Amaç ve kapsam dışı noktalar
- Gerekli girdiler
- Adım adım prosedür
- Kullanılabilecek araçlar
- Doğrulama yöntemi
- Durma ve escalation koşulları
- Beklenen çıktı sözleşmesi

Skill'ler ihtiyaç anında yüklenir; bütün skill içerikleri her oturuma dahil edilmez.

## 9. Protokol Sistemi

Protokol, agent'ların ve skill'lerin üzerinde çalışan organizasyon kuralıdır. Yeni protokoller sonradan eklenebilir.

Öngörülen öncelik:

```text
Platform ve güvenlik kuralları
        ↓
Constitution / core protokoller
        ↓
Kullanıcının onayladığı görev planı
        ↓
Domain ve custom protokoller
        ↓
Agent tanımları
        ↓
Skill prosedürleri
```

Başlangıçta zorunlu protokoller:

- Orchestration
- Planning and user approval
- Delegation and task ownership
- Model routing and budget
- Context handoff
- Verification and independent review
- Failure, retry and escalation
- User communication

## 10. Model Yönlendirme

Çekirdek protokoller doğrudan provider model adlarına bağımlı olmamalıdır. Bunun yerine yetenek seviyeleri kullanılır:

```yaml
model_tiers:
  orchestrator:
    requires:
      - strongest_reasoning
      - delegation
      - long_context

  complex_worker:
    requires:
      - strong_coding
      - autonomous_execution

  fast_worker:
    requires:
      - low_latency
      - low_cost
```

OpenAI için başlangıç eşlemesi:

```yaml
provider: openai
defaults:
  orchestrator: gpt-6-astra
  complex_worker: gpt-5.6-sol
  fast_worker: gpt-5.6-luna
```

Claude için kullanıcı tarafından belirlenen başlangıç eşlemesi:

```yaml
provider: claude
defaults:
  orchestrator: fable-5
  complex_worker: opus-5
  fast_worker: sonnet-5
```

Bu adlar canonical yapıdaki istenen logical model kimlikleridir. Adapter, kurulu provider'ın gerçek model ID'lerini ve bu modellerin erişilebilirliğini doğrulamalıdır. Bir model mevcut değilse sessiz fallback yapılamaz; kullanıcıya uyuşmazlık ve kullanılabilir alternatifler gösterilmelidir.

### 10.1 Yapılandırma katmanları

Model profilleri sonradan değiştirilebilir olmalıdır. Önerilen override önceliği:

```text
Session override
      ↓
Project override
      ↓
Workspace override
      ↓
Provider default
```

Örnek canonical yapılandırma:

```yaml
model_profiles:
  openai:
    orchestrator: gpt-6-astra
    complex_worker: gpt-5.6-sol
    fast_worker: gpt-5.6-luna

  claude:
    orchestrator: fable-5
    complex_worker: opus-5
    fast_worker: sonnet-5

routing:
  mode: automatic
  require_session_confirmation: true
  silent_fallback: false
```

Project veya workspace profilleri dosyada kalıcı olabilir. Session override yalnızca mevcut oturum için geçerlidir ve canonical default'u değiştirmez. Kullanıcı açıkça “varsayılan olarak kaydet” demedikçe geçici seçim kalıcı ayara yazılmaz.

### 10.2 Session model confirmation protokolü

İlk görevden önce orchestrator en az şu bilgileri göstermelidir:

```text
Aktif provider: OpenAI veya Claude
Orchestrator: <model>
Complex worker: <model>
Fast worker: <model>
Routing: automatic/manual
Fallback: disabled/enabled
Override kaynağı: default/workspace/project/session
```

Ardından kullanıcıya bu profille devam etmek veya değiştirmek isteyip istemediğini sorar. Onay verilmeden görev discovery/planlama aşamasına geçmez.

Ana session modeli bazı provider'larda oturum başladıktan sonra değiştirilemeyebilir. Böyle bir durumda orchestrator:

1. Mevcut aktif modeli doğru biçimde gösterir.
2. İstenen modelle uyuşmazlığı açıklar.
3. Gerekliyse yeni session/yeniden başlatma gerektiğini belirtir.
4. Değişiklik gerçekleşmiş gibi davranmaz.

Worker modelleri de yalnızca provider subagent başına model seçimini destekliyorsa uygulanabilir. Desteklenmeyen model routing'i `doctor` ve session confirmation sırasında capability eksikliği olarak gösterilir.

Temel routing ilkesi:

- Mimari analiz ve nihai karar: orchestrator.
- Karmaşık implementasyon/debugging: complex worker.
- Küçük, lokal ve düşük riskli değişiklik: fast worker.
- Küçük işlerde dahi orchestrator kod yazmaz; ekonomik worker seçer.

Provider adapter'ı aynı yetenek seviyelerini ilgili ortamın gerçek model kimliklerine eşler. Provider'ın model veya subagent seçimini desteklemediği durumlar sessizce taklit edilmez; `doctor` tarafından açıkça raporlanır.

## 11. Context Aktarım Mimarisi

### 11.1 Problem

Yeni başlatılan worker agent çoğunlukla ana oturumun context'ine sahip değildir. Worker'ın repository'yi yeniden taraması:

- Aynı tokenların tekrar tüketilmesine,
- Gecikmeye,
- Farklı agent'ların farklı sonuçlara ulaşmasına,
- Orchestrator kararlarının kaybolmasına,
- Gereksiz tool çağrılarına yol açar.

Diğer uçta bütün konuşma geçmişini her worker'a kopyalamak da pahalıdır ve gereksiz detaylarla dikkati dağıtır.

Hedef bütün context'i paylaşmak değil, **görev için yeterli en küçük kanıtlı context'i paylaşmaktır**.

### 11.2 Context katmanları

Context dört katmana ayrılır:

1. **Constitution context:** Değişmez orchestration ve güvenlik kuralları.
2. **Project context:** Stack, komutlar, mimari sınırlar ve doğrulanmış proje gerçekleri.
3. **Task context:** Kullanıcı hedefi, onaylanmış plan, görev kapsamı ve kabul kriterleri.
4. **Evidence context:** İlgili dosyalar, semboller, snippet'ler, komut çıktıları ve önceki worker raporları.

Worker'a constitution'ın gerekli özeti, ilgili project dilimi, kendi task context'i ve yalnızca gerekli evidence aktarılır.

### 11.3 Task Context Packet

Her delegasyon, serbest biçimli kısa bir mesaj yerine şemalı bir görev paketi taşımalıdır:

```yaml
task_id: auth-refresh-fix-implementation
parent_task_id: auth-refresh-fix
assigned_role: implementer
model_tier: complex_worker

objective: >
  Refresh token yenileme sırasında oluşan oturum kaybını düzelt.

why:
  user_goal: Kullanıcının aktif oturumunun beklenmedik şekilde kapanmaması
  plan_reference: .ai/tasks/auth-refresh-fix/plan.md

scope:
  owned_paths:
    - src/auth/**
    - tests/auth/**
  read_paths:
    - src/session/**
  forbidden_paths:
    - src/billing/**

known_facts:
  - statement: Token rotation refresh işleminde etkin
    source: src/auth/refresh-service.ts
    confidence: verified

decisions:
  - Public API sözleşmesi değiştirilmeyecek
  - Veritabanı migration'ı oluşturulmayacak

relevant_symbols:
  - file: src/auth/refresh-service.ts
    symbols:
      - rotateRefreshToken
      - revokeTokenFamily

acceptance_criteria:
  - Eski refresh token tekrar kullanıldığında mevcut token ailesi iptal edilir
  - Normal yenileme aktif oturumu sonlandırmaz
  - İlgili testler geçer

verification:
  commands:
    - pnpm test auth
    - pnpm typecheck

non_goals:
  - Auth API'sini yeniden tasarlamak
  - Session storage katmanını değiştirmek

open_questions: []
expected_report:
  - root_cause
  - changed_files
  - decisions_made
  - commands_run
  - verification_results
  - unresolved_risks
```

### 11.4 Context paketini kim üretir?

Orchestrator, discovery çıktıları ve onaylanmış plandan task packet'i derler. Orchestrator'ın ham konuşma geçmişini worker'a kopyalaması beklenmez.

İş akışı:

```text
Kullanıcı konuşması
      ↓
Orchestrator'ın canonical task ledger'ı
      ↓
Göreve özel context packet
      ↓
Worker
      ↓
Structured completion report
      ↓
Orchestrator task ledger güncellemesi
```

### 11.5 Worker keşif bütçesi

Worker'ın yeniden tam repository taraması varsayılan olarak yasaktır. Ancak doğruluk için kendisine verilen kritik bilgileri gerektiğinde yerinde doğrulayabilir.

Önerilen politika:

- Önce context packet kullanılmalıdır.
- Yalnızca görev kapsamındaki dosyalar okunmalıdır.
- Context yetersizse sınırsız keşif yerine orchestrator'dan ek context istenmelidir.
- Küçük lokal doğrulamalar serbesttir.
- Görev kapsamını değiştiren bulgu escalation gerektirir.
- Kritik veya geri döndürülmesi zor işlem öncesinde kaynak yeniden doğrulanır.

Bu denge, “worker hiçbir şey araştırmasın” ile “her worker her şeyi baştan okusun” uçlarının arasındadır.

### 11.6 Context paketinde içerik mi referans mı?

Her bilgi doğrudan pakete gömülmemelidir:

- Kısa ve kritik kararlar doğrudan pakete eklenir.
- Büyük dosyalar path ve sembol referansıyla verilir.
- Hassas birkaç kod satırı gerekiyorsa sınırlı snippet eklenir.
- Büyük terminal çıktıları özetlenir; ham çıktı artifact olarak referanslanır.
- Değişmeyen project context tekrar kopyalanmak yerine sürümlü kaynağa bağlanır.

### 11.7 Context freshness ve provenance

Her paket aşağıdaki bilgileri taşımalıdır:

```yaml
context:
  project_snapshot: project-api@sha256:...
  plan_version: 3
  created_at: 2026-09-20T00:00:00+03:00
  sources:
    - package.json
    - src/auth/refresh-service.ts
```

Worker, context'in dayandığı dosyaların belirgin biçimde değiştiğini fark ederse eski kararla devam etmez; orchestrator'a geri döner.

### 11.8 Delta handoff

Aynı worker'a takip işi verildiğinde bütün paket yeniden gönderilmez. Önceki `task_id` referans alınır ve yalnızca değişiklikler aktarılır:

```yaml
extends: auth-refresh-fix-implementation
delta:
  new_acceptance_criteria:
    - Eşzamanlı iki refresh isteği için regresyon testi ekle
  new_evidence:
    - tests/auth/refresh-race.test.ts
```

### 11.9 Worker completion packet

Worker'ın dönüşü de şemalı olmalıdır:

```yaml
task_id: auth-refresh-fix-implementation
status: completed
summary: Refresh rotation yarış durumu giderildi
changed_files:
  - src/auth/refresh-service.ts
  - tests/auth/refresh-service.test.ts
commands_run:
  - command: pnpm test auth
    result: passed
decisions_made: []
unresolved_risks: []
recommended_context_updates: []
```

Orchestrator bu raporu canonical task ledger'a işler ve reviewer için yeni, daraltılmış bir context packet üretir.

### 11.10 Provider adapter stratejisi

Provider'lar farklı context paylaşım kabiliyetlerine sahip olabilir:

- Tam konuşma geçmişini fork etme
- Son birkaç turu paylaşma
- Sıfır context ile subagent başlatma
- Görev prompt'una dosya veya artifact referansı verme
- Ortak workspace dosyalarını okuma

Varsayılan tercih, bütün geçmişi çoğaltmak yerine **sıfır/minimal inherited context + explicit task packet** olmalıdır. Bağlam açısından çok yoğun ve kısa sürecek işlerde son birkaç tur paylaşımı seçilebilir. Tam geçmiş fork'u istisnai olmalıdır.

Adapter, provider'ın desteklediği en ekonomik yöntemi seçer ancak task packet sözleşmesi değişmez.

## 12. Project Discovery ve Manuel Senkronizasyon

Uygulanan `sync`, repository veya workspace içindeki proje adaylarını ve modülleri deterministik olarak tarar. Manifest içeren modül dizinleri recursive keşfedilir; normal derinlik sınırının tipik Java kaynak ağacını kesmemesi için `src`, `test`, `tests` ve generated source ağaçları ayrı, limitli bir derin taramadan geçer. Güvenlik limitine ulaşılması sessiz, eksik snapshot üretmek yerine açık hata verir.

Her modül için aşağıdaki verified evidence türleri kaynak path'iyle kaydedilir:

- `manifest`
- `language`
- `framework`
- `package_manager`
- `build_tool`
- `dependency`

JavaScript/TypeScript manifestleri ile Maven ve Gradle tanımları ayrıştırılır; yorumlar ve yalnız dependency/plugin management altında duran koordinatlar aktif framework kanıtı sayılmaz. Modül komutları çalıştırılacak `cwd`, kaynak ve `verified` güven seviyesiyle tutulur.

```yaml
test:
  value: pnpm test
  cwd: frontend
  source: package.json
  confidence: verified
```

Her proje registry'si sekiz canonical base skill'i kaydeder:

- `planning`
- `project-discovery`
- `codebase-exploration`
- `implementation`
- `verification`
- `debugging`
- `code-review`
- `task-conductor`

Bunların yanında yalnız eşleşen verified evidence için teknoloji pack'i seçilir. Mevcut pack → skill eşlemeleri:

| Pack | Üretilen skill |
| --- | --- |
| TypeScript | `typescript-patterns` |
| React | `react-patterns`, Ingenium `react-modern`, `frontend-craft` |
| Java | `java-patterns`, Ingenium `java-backend` |
| Spring Boot | `spring-boot-patterns` |
| JPA/Hibernate | `jpa-patterns`, Ingenium `db-schema-craft`, `query-tuning` |
| Maven | `maven-build` |
| Gradle | `gradle-build` |
| Express/Fastify/NestJS | Ingenium `node-backend` |
| Vue/Nuxt | Ingenium `vue-modern`, `frontend-craft` |
| Tailwind CSS | Ingenium `tailwind-v4-tokens` |

Seçimler, gerekçeleri, source id ve matched evidence `.ai/projects/<project-id>.skills.yaml` içinde tutulur. Yerel teknoloji skill'leri `.ai/skills/technology/**`, bundled havuz ise `.ai/skills/library/<source-id>/**` altında materialize edilir. `.ai/skills/catalog.yaml`, skill açıklamalarını, aktivasyon biçimini ve source provenance/lisans bilgisini taşır. Registry'deki otomatik skill'ler önceliklidir; `on-demand` skill yalnız açıklaması mevcut görevle doğrudan eşleştiğinde yüklenir. Bütün havuz aynı anda context'e alınmaz.

İlk bundled kaynak, 32 available skill ve bunlara ait script/reference dosyalarını içeren proje-sahipli Ingenium snapshot'ıdır. Task Conductor bu snapshot'tan ayrılarak canonical base skill yapılmıştır. Anthropic Agent Skills, Superpowers ve Microsoft Agent Skills; repository URL, lisans ve sabit commit kimliğiyle `reference-only` kaynak olarak kataloglanır. Harici repository içeriği ayrı güvenlik ve lisans incelemesi olmadan otomatik import veya execute edilmez.

`sync`, kullanıcı tarafından değiştirilmiş herhangi bir generated skill/katalog dosyası gördüğünde durur; `sync --force` yalnız bu çakışan generated dosyayı canonical içerikle yenilemeye izin verir.

Aktivasyon sırası güvenlidir: teknoloji skill dosyaları, proje record'ları ve workspace kaydı hazırlandıktan sonra skill registry en son yazılır. Önkoşul yazımlarından biri başarısız olursa önceki aktif registry korunur.

Yeni repo eklendiğinde uygulanan akış:

```text
git clone
   ↓
syn sync
   ↓
deterministik keşif
   ↓
project record ve skill çözümleme
   ↓
teknoloji skill'leri, record ve workspace yazımı
   ↓
skill registry'nin en son aktive edilmesi
```

`doctor`; workspace entry'lerini, canonical `.ai/projects/<id>.yaml` record'larını, modül dizinlerini, manifest/source path'lerini, command `cwd` değerlerini, skill registry şemasını, canonical sekiz base skill kümesini ve seçili teknoloji skill dosyalarını uçtan uca doğrular. Kontroller hem lexical traversal/absolute path varyantlarını hem de `realpath` tabanlı symlink/junction kaçışlarını kapsar; eksik, bozuk, duplicate veya root dışına çıkan herhangi bir referans varken yapı `healthy` raporlanmaz.

## 13. Provider Uyumluluğu ve Sınırlar

Ortak yapı aynı davranış semantiğini hedefler; birebir aynı teknik çalıştırma biçimini garanti etmez.

- Codex adapter'ı ortak rolleri Codex'in agent, skill ve talimat mekanizmalarına çevirir.
- Claude Code adapter'ı aynı rolleri Claude Code'un desteklediği mekanizmalara çevirir.
- Ana modelin seçilmesi yalnızca bir markdown dosyasıyla garanti edilemez; oturum gerçekten doğru modelle başlatılmalıdır.
- Provider subagent başına model seçimini desteklemiyorsa bu eksiklik açıkça raporlanır.
- Codex'in Claude modellerini veya Claude Code'un OpenAI modellerini çağırması yalnızca yapı dosyalarıyla sağlanamaz. Böyle bir gereksinim ayrı bir runtime/bridge gerektirir ve mevcut ürün kapsamının dışındadır.

## 14. Token ve Zaman Optimizasyonu

- Root talimatları kısa tutulur.
- Skill'ler yalnızca tetiklendiklerinde yüklenir.
- Worker'lara tüm sohbet değil task packet gönderilir.
- Project context sürümlü ve tekrar kullanılabilir tutulur.
- Büyük içerikler kopyalanmaz; path/symbol/artifact referansı kullanılır.
- Takip görevleri delta handoff kullanır.
- Küçük işler fast worker'a, karmaşık işler complex worker'a yönlendirilir.
- Bağımsız olmayan işler yapay biçimde paralelleştirilmez.
- Aynı dosyaları değiştirecek worker'lar eşzamanlı başlatılmaz.
- Worker raporları şemalıdır; orchestrator ham konuşmaları yeniden özetlemek zorunda kalmaz.
- “Summary of summary” bilgi kaybını önlemek için canonical task ledger korunur.

## 15. Açık Tasarım Kararları

Henüz kesinleştirilmesi gereken noktalar:

1. Canonical tanımların kesin şeması ve dosya formatı.
2. Provider çıktılarının kopya, generated file veya referans olarak üretilmesi.
3. Orchestrator'ın yazma yasağının her provider'da teknik olarak ne kadar enforce edilebileceği.
4. Task ledger ve context packet dosyalarının Git'e dahil edilip edilmeyeceği.
5. Context paketleri için token bütçesi ve sıkıştırma eşikleri.
6. Worker'ın kendi başına yapabileceği lokal keşfin kesin sınırları.
7. User approval kapısının her görevde mi, yoksa yalnızca yeni ana işlerde mi uygulanacağı.
8. Reviewer modelinin risk seviyesine göre nasıl seçileceği.
9. Çoklu worker'lar için ortak çalışma ağacı ve worktree politikası.
10. Custom protokollerin core protokollerle çakışma çözümü.
11. Codex ve Claude Code feature-matrix'inin resmi olarak doğrulanması.

## 16. Önerilen Tasarım Sırası

1. Constitution ve ana orchestration protokolü
2. Protokol şeması ve öncelik sistemi
3. Task lifecycle ve kullanıcı onay kapısı
4. Context packet ve completion packet şemaları
5. Agent manifest standardı
6. Skill standardı
7. Model tier ve routing politikası
8. Verification/review protokolü
9. Failure/retry/escalation protokolü
10. Codex capability adapter'ı
11. Claude Code capability adapter'ı
12. CLI `init`, `sync`, `inspect` ve `doctor` komutları

## 17. Başarı Ölçütleri

Sistem başarılı sayılmalıdır eğer:

- Kullanıcı yalnızca orchestrator ile konuşarak işi baştan sona yürütebiliyorsa,
- Orchestrator hiçbir implementasyon kodu yazmadan işi sonuçlandırabiliyorsa,
- Her worker yalnızca gerekli context ile göreve başlayabiliyorsa,
- Worker'lar repository'yi gereksiz yere yeniden taramıyorsa,
- Model seçimi kalite/maliyet dengesine göre yapılabiliyorsa,
- Plan, karar, delegasyon ve doğrulama kanıtları izlenebiliyorsa,
- Aynı canonical yapı hem Codex hem Claude Code'a güvenilir biçimde uyarlanabiliyorsa,
- Provider kısıtları kullanıcıdan saklanmıyorsa.

## 18. Karar Günlüğü

### 2026-09-20 — Orchestration ve model profilleri

- Sistem standart bir coding assistant yapısı değil, merkezi orchestrator tarafından yönetilen hiyerarşik bir agent organizasyonu olacaktır.
- Orchestrator hiçbir ürün kodu yazmayacak; yalnızca analiz, planlama, karar, delegasyon, koordinasyon ve nihai raporlama yapacaktır.
- Orchestrator kontrol-düzlemi kayıtlarını yalnızca `.ai/tasks/**` altında oluşturabilecek veya güncelleyebilecektir.
- Worker'lar repository'yi baştan taramak yerine orchestrator tarafından hazırlanan sürümlü task context packet'larıyla çalışacaktır.
- Geniş keşif bir kez yapılacak, elde edilen kanıtlar birden fazla worker tarafından yeniden kullanılacaktır.
- Worker dönüşleri structured completion packet olarak orchestrator'a iletilecektir.
- OpenAI başlangıç profili: orchestrator `gpt-6-astra`, complex worker `gpt-5.6-sol`, fast worker `gpt-5.6-luna`.
- Claude başlangıç profili: orchestrator `fable-5`, complex worker `opus-5`, fast worker `sonnet-5`.
- Model profilleri provider, workspace, project ve session seviyelerinde yapılandırılabilir olacaktır.
- Her yeni session'ın ilk görevinden önce aktif model profili kullanıcıya gösterilecek ve açık onay alınacaktır.
- Session override'ları kullanıcı kalıcı kaydetmeyi açıkça istemedikçe canonical default'ları değiştirmeyecektir.
- Model bulunamadığında veya provider gerekli routing kabiliyetini desteklemediğinde sessiz fallback yapılmayacaktır.
- Ana orchestrator modeli oturum içinde değiştirilemiyorsa sistem bunu açıkça bildirecek ve gerekiyorsa yeni session başlatılmasını isteyecektir.

### 2026-09-20 — Node.js CLI çekirdeği

- CLI, Node.js 24+ ve strict TypeScript tabanlı ESM uygulaması olarak geliştirilecektir.
- Package manager olarak pnpm kullanılacaktır.
- Kaynak geliştirme ve test çalıştırması Node 24'ün yerleşik TypeScript type-stripping desteğini kullanacaktır; gereksiz runtime transpiler bağımlılığı taşınmayacaktır.
- İlk çalıştırılabilir dikey dilimde `inspect`, `init`, `sync` ve `doctor` komutları oluşturulmuştur.
- `inspect` yazma yapmadan üretim planını ve dosya çakışmalarını gösterir.
- `init` mevcut farklı dosyaları varsayılan olarak korur; yalnızca açık `--force` ile günceller.
- `sync` manuel tetiklemeyle repository/project gerçeklerini kanıt kaynaklarıyla kaydeder.
- `doctor` canonical yapı, model profilleri, session confirmation ve silent-fallback yasağını doğrular.
- Generated structure; constitution, sekiz core protokol, beş agent rolü, Task Conductor dahil sekiz canonical base skill, curated skill catalog, OpenAI/Claude model profilleri ve context/completion packet şemalarını içerir.

### 2026-09-20 — Recursive discovery, skill registry ve path güvenliği

- Repository içindeki manifest tabanlı modüller recursive keşfedilir; iç içe `src`/test source ağaçları ayrı güvenlik limitleriyle taranır.
- Dil, framework, package manager, build tool ve dependency seçimleri yalnız kaynak path'i taşıyan verified evidence üzerinden yapılır.
- Sekiz base skill her proje registry'sinde canonical ve eksiksiz tutulur; teknoloji skill'leri yalnız eşleşen pack kanıtıyla aktive edilir.
- `sync`, değiştirilmiş generated teknoloji skill'lerini açık `--force` olmadan ezmez ve aktif skill registry'sini önkoşul çıktılarından sonra en son yazar.
- `doctor`, workspace'ten skill dosyasına kadar referans bütünlüğünü, canonical base setini, modül/command path'lerini ve lexical + symlink/junction root containment kurallarını doğrular.

### 2026-09-20 — Curated skill kaynakları ve Ingenium havuzu

- Ingenium'un 32 skill ve 35 dosyadan oluşan proje-sahipli snapshot'ı destek script/reference dosyaları korunarak bundled kaynak haline getirilmiştir; Task Conductor bağımsız canonical base skill'e taşınmıştır.
- Skill kaynakları repository, revision, license ve trust seviyesiyle kataloglanır; generated projelerde katalog `.ai/skills/catalog.yaml` olarak yazılır.
- React, Java, Node, Vue, JPA/Hibernate ve Tailwind eşleşmeleri verified repository evidence üzerinden otomatik aktive edilir.
- Debugging, refactoring, dokümantasyon, release, performans, tasarım, oyun ve diğer uzmanlık skill'leri on-demand kalır; orchestrator açıklama eşleşmesi olmadan bunları yüklemez.
- Anthropic Agent Skills, Superpowers ve Microsoft Agent Skills araştırılmış, sabit commit kimlikleriyle `reference-only` kaydedilmiş ve otomatik üçüncü taraf kod/talimat çalıştırma kapsam dışında bırakılmıştır.
- Kaynak havuzunun tamamının context'e yüklenmesi yasaktır; katalog metadata'sı ucuz keşif, `SKILL.md` ve destek kaynakları progressive disclosure için kullanılır.

### 2026-09-21 — Orantılı yürütme ve canonical Task Conductor

- Optimizasyon; doğruluk sınırı korunarak token/context maliyeti ve geçen sürenin birlikte azaltılması olarak tanımlanır.
- Her görev uygulama öncesi `trivial`, `standard` veya `high-risk` sınıfına alınır; scope veya bulgular değişirse tier yükseltilir.
- Trivial işler bir fast worker, kompakt kullanıcı-onaylı plan ve claim-specific kanıtla yürür; broad discovery, full-project kontroller, reviewer ve browser varsayılan değildir.
- Standard işlerde targeted kontroller ve yalnız material/boundary-crossing değişikliklerde reviewer; high-risk işlerde complex worker, kapsamlı kanıt ve bağımsız review zorunludur.
- Headed browser kullanıcı talebi veya daha ucuz kanıtların çözemediği isimlendirilmiş bir kriter için ayrıca onay olmadıkça kullanılamaz.
- Task Conductor Ingenium snapshot'ından ayrılıp sekizinci canonical base skill yapılmıştır; non-trivial brief'lerde merkezi decomposition ve just-in-time skill routing sağlar.
- Skill durumu `available`, project registry ile `active` ve task context'inde `loaded` olarak ayrılır; bootstrap bütün kataloğu taramaz.

### 2026-09-20 — Synorch paketleme ve yayın güvenliği

- Ürün, npm üzerinde `synorch` paketi olarak; kurulum sonrasında `syn` ve `synorch` executable alias'larıyla dağıtılacaktır.
- İlk pre-stable sürüm `0.1.0` ve Git tag'i `v0.1.0` olarak tanımlanmıştır; sürüm geçmişi Keep a Changelog ve Semantic Versioning ile tutulacaktır.
- Her paketleme öncesinde typecheck, test ve build zorunlu `prepack` kapısından geçer; paket içeriği allowlist ile sınırlandırılır.
- CI ve npm publish workflow'ları salt-okunur varsayılan yetkiler, sabit action commit SHA'ları ve release-tag/sürüm eşleşme kontrolü kullanır.
- İlk npm yayını 2FA ile manuel yapılır; sonraki yayınlar GitHub Actions ile token saklamadan npm Trusted Publishing/OIDC üzerinden gerçekleştirilir.
- MIT lisansı, özel güvenlik bildirimi, changelog ve insan odaklı release notları public dağıtım sözleşmesinin parçasıdır.
