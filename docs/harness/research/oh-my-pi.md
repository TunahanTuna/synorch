# Oh My Pi incelemesi

> İncelenen kaynak: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), 2026-09-22. Bu dosyadaki ürün davranışları upstream'e aittir; Synorch özellikleri değildir.

## Neden önemli?

OMP, Pi tabanlı açık kaynak bir kodlama agent'ı; terminal arayüzü, agent/tool paketi, çok sağlayıcılı model erişimi, LSP/DAP, extension, session ve child-agent mekanizmaları birlikte sunuyor. [README](https://github.com/can1357/oh-my-pi) ve [agent paketi](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/README.md) mimarinin iki başlangıç noktası.

## İncelenen mekanizmalar

| Mekanizma | Upstream bulgu | Synorch çıkarımı |
| --- | --- | --- |
| Oturum | Append-only JSONL; `id`/`parentId` ve etkin `leafId` ile ağaç; branch geçmişi silmez. [Session](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md) | Event log + branch/replay temel primitive olsun; görüntülenen transkript ile modele gönderilen geçmiş ayrı projection olsun. |
| Bağlam bakımı | Compaction ve branch summary ayrı kayıt türleri; birden fazla trigger ve provider-native yollar var. [Compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md) | İlk sürümde tek, test edilebilir compaction yöntemi; özetin kaynağı ve kesim noktası kalıcı. |
| Child agent | Batch/async, semaphore ile concurrency, idle/park/revive, izolasyon/merge stratejileri açıklanmış. [Task](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) | Child bir fonksiyon çağrısı değil; kimliği, scope'u, bütçesi, lease'i ve sonuç protokolü olan görev. |
| Extension | Olaylar, tool/command kaydı, durumun session entry ile saklanması mümkün. [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) | Extension API versiyonlu olmalı; callback hatası ve yetki genişlemesi açık yönetilmeli. |
| İzin | Tool `read/write/exec` tier'ları, mod ve pattern politika; belge bash pattern'ının containment olmadığını söylüyor. [Approval](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md) | İzin kararı, process izolasyonu ve kullanıcı onayı üç ayrı katman. |
| Host entegrasyonu | Stdio üzerinden newline-delimited JSON RPC modu mevcut. [RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) | Terminal insan modu ve makine protokolü farklı çıktılar/kararlılık vaat etmeli. |

## Özel dikkat: child yaşam döngüsü

[Task referansı](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) eşzamanlılık sınırı, background job kaydı, başarısız child'ın sorgulanabilir kalması, idle/park/revive, izole işte patch veya branch merge gibi çok sayıda uç durum anlatıyor. Synorch'ta bunları tek sprintte almak gerekmiyor; fakat task ledger şeması daha sonra eklenmelerine engel olmamalı. İlk sürümde önerilen durumlar: `queued`, `running`, `waiting_for_approval`, `completed`, `failed`, `cancelled`, `interrupted`. Child'ın sonuç paketi alınmadan `completed` yazılmamalı.

## Özel dikkat: extension güven sınırı

OMP'nin [extension belgesi](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) in-process extension'ların izole olmadığını ve kontrolsüz arka plan callback hatasının process'i düşürebildiğini açıkça belirtir. Synorch için ilk plugin API'si metadata ve dar tool adaptörlerinden başlamalı. Üçüncü taraf kodu aynı process'e yükleme kararı, sandbox ve crash izolasyonu tasarlanmadan verilmemeli.

## Benimsenmeyecek başlangıç kapsamı

OMP'nin geniş built-in araç kümesi, IDE/debugger entegrasyonları ve birden fazla bağlam/compaction stratejisi olgun bir ürünün sonucudur. Synorch MVP için bunlar zorunlu değildir. İlk milestone'da dosya okuma/arama, kontrollü patch, shell, git durumu, görev ve onay akışı yeterli olabilir; diğerleri ölçülmüş ihtiyaçla eklenir.
