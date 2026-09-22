# Markdown hafıza sözleşmesi

> Durum: `accepted`, 2026-09-22. Sahip: `src/harness/contracts/memory.ts`; uygulama: `src/harness/memory/` (I6). Kararlar: [ADR-16](../decisions/ADR-16-memory-location.md), [ADR-17](../decisions/ADR-17-memory-write-policy.md). Araştırma: [Obsidian ile yerel hafıza](../obsidian/README.md).

## 1. Konum ve sınır

- Kişisel hafıza varsayılanı `~/.synorch/memory/<project-id>/` (`DEFAULT_MEMORY_ROOT_SEGMENTS`); config `memory.root` ile değişir. Ekip vault'u repo içinde **opt-in**'dir (`memory.team_root`); orada decision/preference notları her zaman inceleme gerektirir.
- Yapılandırma bölümü `MemoryConfig` = `memoryConfigSchema` (`root?`, `team_root?`; strict). `root` bu projenin kişisel vault kökünü olduğu gibi değiştirir (`~` ev dizinine açılır, göreli yol ev dizinine göre çözülür). `team_root` v1'de kabul edilir ama okunmaz/yazılmaz (ayrılmış).
- Obsidian isteğe bağlı görüntüleyicidir; hiçbir runtime yolu Obsidian'ın açık/kurulu olmasına bağlı değildir. Synorch Obsidian'ın metadata cache'ine veya eklenti API'sine dayanmaz. Semantik katman ve Obsidian eklentisi v1 dışıdır.
- Event log kanıtın aslıdır; not, log'a/repo'ya işaret eden incelenebilir projection'dır. Ham tool çıktısı ve sohbet vault'a toplu kopyalanmaz; token, parola, anahtar ve ham env hiçbir zaman yazılmaz (yazmadan önce redaksiyon).

```text
<root>/
  README.md
  <kind>/<id>.md          decisions/, assumptions/, questions/, evidence/, concepts/, preferences/, project/
  queue/<proposal-id>.yaml   inceleme kuyruğu (MemoryProposal)
  .index/                 türetilmiş arama indeksi (silinebilir, `syn memory reindex` ile yeniden kurulur)
```

## 2. Not biçimi

Dosya = YAML frontmatter + `# Başlık` + gövde. Bağlantılar taşınabilirlik için standart Markdown bağlantısıdır; kalıcı referans `id`'dir (dosya taşınsa da çözülür).

| Alan | Kural |
| --- | --- |
| `schema_version` | `1` |
| `id` | `MemoryId`; önek türle eşleşir: `prj dec asm que evd cpt prf` |
| `kind` | `project`, `decision`, `assumption`, `question`, `evidence`, `concept`, `preference` |
| `status` | Türe göre: decision `proposed/accepted/superseded/rejected`; assumption `open/verified/invalidated`; question `open/resolved`; evidence `current/stale/unavailable`; concept `active/deprecated`; preference `active/revoked`; project `active/archived` |
| `project_id`, `scope (project\|branch\|user)`, `branch?` | `branch` yalnız ve zorunlu olarak `scope: branch` için |
| `created_at`, `updated_at?`, `reviewed_at?` | Takvim tarihi |
| `source_run?`, `source_task?`, `source_ref?`, `source_digest?` | Evidence için `source_ref` + `source_digest` zorunlu |
| `confidence` | `high`, `medium`, `low` |
| `owner` | `human` veya `synorch` |
| `relations[]{type, target}` | `supports`, `contradicts`, `depends_on`, `supersedes`, `affects`, `originated_from`; kendine ilişki yok |
| `tags?` | küçük harf |

Kural: Synorch'un yazdığı yetkili not (`decision: accepted`, `preference: active`) `reviewed_at` taşımak zorundadır; yani yalnız kuyruk kararından geçerek oluşabilir.

## 3. Yazma politikası (ADR-17)

| Tür | Yol |
| --- | --- |
| evidence, concept, assumption, question (`AUTO_PERSIST_KINDS`) | Doğrudan yazılır (`memory/persisted`); statüleri yetkisiz niteliktedir |
| decision, preference (`REVIEW_REQUIRED_KINDS`) | Kuyruğa öneri (`memory/proposed`) |
| contradiction, relation, status-change önerileri | Kuyruğa öneri |

Kuyruk kararı (`memory/proposal_decided`): kullanıcı veya — `autonomous` modda — orchestrator verir; orchestrator kararı `run_id` ile denetlenir ve kullanıcı geri alabilir. `MemoryProposal` = `proposal_id`, `kind (note|relation|contradiction|status-change)`, `note?`/`body?`/`target?`/`relation?`/`new_status?` (türe göre zorunlu), `rationale`, `evidence[]` (en az bir `EvidenceRef`), `created_by{run_id, task_id?}`, `created_at`, `state (pending|accepted|rejected|deferred)`, `decision?` (yalnız pending değilken).

`MemoryStore.decide(proposalId, decision, state) → MemoryDecisionOutcome`: store notu kalıcılaştırır ama olay yazmaz; dönen `decided` (`memory/proposal_decided` yükü), `persisted?` (kabul edilen öneri bir not oluşturduysa/değiştirdiyse `memory/persisted` yükü) ve `runId` (orchestrator kararında zorunlu; olayın `run_id`'si) çağıran (orchestration/CLI) tarafından session log'una eklenir.

## 4. Eşzamanlılık

`MemoryStore.persist(note, expectedDigest)`: dosyanın mevcut digest'i beklenenden farklıysa (kullanıcı Obsidian'da düzenlemiş) yazmaz, çakışma döner; kullanıcının serbest metni sessizce ezilmez. Yazma atomik (temp + rename). İndeks her zaman notlardan yeniden üretilebilir.

## 5. Geri çağırma

`search(query)` sırası: proje/branch/kapsam/durum filtresi → açık bağlantı + tam metin → (v1'de semantik yok). Her sonuç `reason` ve `stale` taşır. `superseded`/`rejected` kararlar yürütmeyi yönlendirmez; `source_digest` eşleşmeyen not `stale`'dir ve modele kesin gerçek gibi sunulmaz. ContextBuilder hafızayı `trust: untrusted`, `source: memory` blok olarak ekler.

## 6. Örnekler

```yaml example=memory-note
- schema_version: 1
  id: dec-0042
  kind: decision
  project_id: synorch-1a2b3c4d
  scope: project
  status: accepted
  created_at: "2026-09-22"
  reviewed_at: "2026-09-22"
  source_run: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3
  confidence: high
  owner: synorch
  relations:
    - { type: supports, target: cpt-memory-architecture }
    - { type: originated_from, target: evd-obsidian-storage }
- schema_version: 1
  id: evd-obsidian-storage
  kind: evidence
  project_id: synorch-1a2b3c4d
  scope: branch
  branch: harness
  status: current
  created_at: "2026-09-22"
  source_ref: docs/harness/obsidian/README.md
  source_digest: "sha256:1234123412341234123412341234123412341234123412341234123412341234"
  confidence: medium
  owner: synorch
  relations: []
  tags: [memory, obsidian]
```

Reddedilenler: incelemeden geçmemiş yetkili karar; önek/tür uyumsuzluğu; kaynaksız evidence; branch'siz branch kapsamı.

```yaml example=memory-note invalid
- { schema_version: 1, id: dec-0043, kind: decision, project_id: synorch-1a2b3c4d, scope: project, status: accepted, created_at: "2026-09-22", confidence: high, owner: synorch, relations: [] }
- { schema_version: 1, id: dec-0044, kind: preference, project_id: synorch-1a2b3c4d, scope: user, status: active, created_at: "2026-09-22", confidence: high, owner: human, relations: [] }
- { schema_version: 1, id: evd-0001, kind: evidence, project_id: synorch-1a2b3c4d, scope: project, status: current, created_at: "2026-09-22", confidence: low, owner: synorch, relations: [] }
- { schema_version: 1, id: cpt-0001, kind: concept, project_id: synorch-1a2b3c4d, scope: branch, status: active, created_at: "2026-09-22", confidence: low, owner: synorch, relations: [] }
```

```yaml example=memory-proposal
- schema_version: 1
  proposal_id: prop_01K5T3Q8Z4X9V2M6N7P0R1S2TJ
  kind: contradiction
  target: dec-0042
  relation: { type: contradicts, target: asm-memory-in-repo }
  rationale: "Assumption says memory lives in the repo; accepted decision puts it under ~/.synorch."
  evidence: [{ kind: file, ref: docs/harness/decisions/ADR-16-memory-location.md, produced_by: orchestrator }]
  created_by: { run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
  created_at: "2026-09-22T12:00:00Z"
  state: pending
- schema_version: 1
  proposal_id: prop_01K5T3Q8Z4X9V2M6N7P0R1S2TK
  kind: status-change
  target: asm-memory-in-repo
  new_status: invalidated
  rationale: Superseded by ADR-16.
  evidence: [{ kind: event, ref: "ses_01K5T3Q8Z4X9V2M6N7P0R1S2T4#120", produced_by: orchestrator }]
  created_by: { run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
  created_at: "2026-09-22T12:00:00Z"
  state: accepted
  decision: { by: orchestrator, at: "2026-09-22T12:01:00Z", reason: "autonomous mode; evidence is an accepted ADR", run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
```

```yaml example=memory-proposal invalid
- schema_version: 1
  proposal_id: prop_01K5T3Q8Z4X9V2M6N7P0R1S2TP
  kind: contradiction
  target: dec-0042
  relation: { type: supports, target: asm-memory-in-repo }
  rationale: Wrong relation type.
  evidence: [{ kind: file, ref: x, produced_by: orchestrator }]
  created_by: { run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
  created_at: "2026-09-22T12:00:00Z"
  state: pending
- schema_version: 1
  proposal_id: prop_01K5T3Q8Z4X9V2M6N7P0R1S2TM
  kind: status-change
  target: dec-0042
  new_status: superseded
  rationale: No evidence and an unaudited orchestrator decision.
  evidence: []
  created_by: { run_id: run_01K5T3Q8Z4X9V2M6N7P0R1S2T3 }
  created_at: "2026-09-22T12:00:00Z"
  state: accepted
  decision: { by: orchestrator, at: "2026-09-22T12:01:00Z", reason: silent }
```

```yaml example=memory-config
- { root: "~/vaults/synorch" }
- { root: /srv/memory/synorch, team_root: .ai/memory }
- {}
```

```yaml example=memory-config invalid
- { root: "" }
- { vault: "~/notes" }
```
