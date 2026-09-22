# API key yolları (Anthropic Messages, OpenAI Responses)

> Statü: araştırma; runtime uygulanmadı. İnceleme: 2026-09-22. Her iki sağlayıcı için de **tamamen izinli, belgelenmiş ve kararlı** yol. Bu belge kısa tutuldu; uygulama sırasında SDK sürümüne göre resmi referans yeniden okunmalı.

## Anthropic Messages API (`@anthropic-ai/sdk`)

- Kimlik: `x-api-key: <ANTHROPIC_API_KEY>` + `anthropic-version: 2023-06-01`; SDK bunu `apiKey` ile yapar. Kurumsal alternatifler: Bedrock / Vertex / Foundry / Claude Platform on AWS istemcileri.
- Endpoint: `POST https://api.anthropic.com/v1/messages`, `stream: true`.
- Streaming olayları ([streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)): `message_start` (başlangıç usage: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `content_block_start` (`text` | `thinking` | `tool_use` | `redacted_thinking`), `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `content_block_stop`, `message_delta` (`stop_reason`, kümülatif `output_tokens`), `message_stop`, `ping`, `error`.
- Tool use ([tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)): istekte `tools: [{name, description, input_schema}]`; yanıtta `tool_use {id, name, input}`; sonraki `user` mesajında `tool_result {tool_use_id, content, is_error}`. `stop_reason: "tool_use"` döngüyü sürdürür. Thinking blokları imzalarıyla birlikte değiştirilmeden geri gönderilmeli.
- İptal: HTTP isteğini/stream'i `AbortController` ile kes; sunucu tarafı ayrı iptal çağrısı yok. Yarım tur transkripte "kesildi" olarak yazılmalı.
- Hatalar ([errors](https://platform.claude.com/docs/en/api/errors)): 400 `invalid_request_error`, 401 `authentication_error`, 403 `permission_error`, 404, 413, 429 `rate_limit_error` (`retry-after`), 500 `api_error`, 529 `overloaded_error`. Rate-limit header'ları `anthropic-ratelimit-*`.
- Prompt caching: `cache_control: {type:"ephemeral"}` blokları; usage'daki cache alanları maliyet raporuna girer.

## OpenAI Responses API (`openai` SDK)

- Kimlik: `Authorization: Bearer <OPENAI_API_KEY>`; opsiyonel `OpenAI-Organization`, `OpenAI-Project`.
- Endpoint: `POST https://api.openai.com/v1/responses`, `stream: true`. ChatGPT OAuth token'ı bu host'ta **geçersizdir** (401 / eksik API scope; openbench spike ve issue #36886 gözlemi) — iki yol ayrı adapter olmalı.
- Streaming olayları ([streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)): `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.function_call_arguments.delta` / `.done`, `response.reasoning_summary_text.delta`, `response.output_item.done`, `response.completed` (`usage: {input_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens}`), `response.failed`, `response.incomplete`, `error`.
- Tool use ([function calling](https://developers.openai.com/api/docs/guides/function-calling)): `tools: [{type:"function", name, description, parameters, strict}]`; çıktıda `function_call {call_id, name, arguments}`; sonraki istekte `function_call_output {call_id, output}`. Durumlu (`store: true` + `previous_response_id`) veya durumsuz (`store: false` + tam geçmiş + `include: ["reasoning.encrypted_content"]`) çalışabilir. **Öneri:** ChatGPT adapter'ıyla ortak kod için durumsuz mod.
- İptal: stream'i kes; `background: true` yanıtlar için `POST /v1/responses/{id}/cancel` ([cancel](https://developers.openai.com/api/reference/resources/responses/methods/cancel)).
- Hatalar: 401, 403, 404, 429 (`rate_limit_exceeded` veya `insufficient_quota`), 500/503; rate-limit header'ları `x-ratelimit-*`.

## Ortak öneriler

- API key ve abonelik yolları kullanıcı arayüzünde ayrı "hesap" olarak görünür; **sessiz fallback yok** (abonelik kotası dolunca API key'e geçmek kullanıcı onayı ister, çünkü maliyet doğurur).
- API key'ler de aynı credential store'da saklanır ([recommendation.md](./recommendation.md) §4); env değişkeni (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) yalnız okuma kaynağıdır, Synorch dosyaya yazmaz.
- Usage alanları normalize edilir: `input`, `cached_input`, `cache_write`, `output`, `reasoning`; kaynak (`provider-api` / `estimate`) audit'e yazılır ([sağlayıcı tasarımı](../../design/providers-and-configuration.md)).
