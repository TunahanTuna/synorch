import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModelStreamEvent } from "../src/harness/contracts/index.ts";
import {
  collectStream,
  createOpenAIChatGPTAdapter,
  createWebSearchRunner,
  WEB_SEARCH_SETUP_HINT,
  type HostedSearchObserved,
  type WebSearchSources,
} from "../src/harness/providers/index.ts";
import { fakeFetch, jsonResponse, sseResponse, staticCredential, testRequest, testRoute } from "../src/harness/providers/testing.ts";
import { parseClaudeSearch, searchViaClaudeCode } from "../src/harness/providers/web-search.ts";

const sse = (events: readonly Record<string, unknown>[]): string => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const HOSTED_SEARCH_STREAM = sse([
  { type: "response.output_item.done", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "vitest latest version" } } },
  { type: "response.output_text.delta", output_index: 1, delta: "Vitest 4.2 is the latest." },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Vitest 4.2 is the latest.",
          annotations: [{ type: "url_citation", url: "https://vitest.dev/blog", title: "Vitest blog", start_index: 0, end_index: 10 }],
        },
      ],
    },
  },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
]);

function sources(overrides: Partial<WebSearchSources> = {}): WebSearchSources {
  return {
    fetch: async () => {
      throw new Error("no network in tests");
    },
    chatgpt: async () => undefined,
    openaiApi: async () => undefined,
    anthropicApi: async () => undefined,
    claudeCode: async () => undefined,
    searchKey: async () => undefined,
    ...overrides,
  };
}

const request = { query: "vitest latest version", maxResults: 5, allowedDomains: [] };

test("web_search auto: the ChatGPT subscription answers first with a live hosted search sub-request carrying only the query", async () => {
  const fake = fakeFetch(() => sseResponse(HOSTED_SEARCH_STREAM, { chunkSize: 17 }));
  const runner = createWebSearchRunner({
    provider: () => undefined,
    sources: sources({ fetch: fake.fetch, chatgpt: async () => new Headers({ authorization: "Bearer subscription-token" }), anthropicApi: async () => new Headers({ "x-api-key": "k" }) }),
  });
  const answer = await runner(request, new AbortController().signal);
  assert.equal(answer.backend, "chatgpt");
  assert.deepEqual(answer.results.map((item) => [item.title, item.url, item.snippet]), [["Vitest blog", "https://vitest.dev/blog", "Vitest 4.2"]]);
  assert.equal(answer.answer, "Vitest 4.2 is the latest.");
  const sent = fake.requests[0];
  assert.equal(sent?.url, "https://chatgpt.com/backend-api/codex/responses");
  const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.tools, [{ type: "web_search", external_web_access: true }]);
  assert.equal(body.store, false);
  assert.equal(JSON.stringify(body.input).includes("vitest latest version"), true);
  assert.equal(sent?.headers.get("originator"), "synorch");
});

test("web_search: a configured provider is used alone and a failure names it (no silent fallback); no backend gives the setup hint", async () => {
  const brave = fakeFetch(() => jsonResponse(200, { web: { results: [{ title: "Vitest", url: "https://vitest.dev", description: "Next <b>generation</b> testing", age: "2 days ago" }] } }));
  const keyed = createWebSearchRunner({ provider: () => "brave", sources: sources({ fetch: brave.fetch, searchKey: async () => "brave-key-123456", chatgpt: async () => new Headers() }) });
  const answer = await keyed(request, new AbortController().signal);
  assert.equal(answer.backend, "brave");
  assert.deepEqual(answer.results[0], { title: "Vitest", url: "https://vitest.dev", snippet: "Next generation testing", page_age: "2 days ago" });
  assert.equal(brave.requests[0]?.headers.get("x-subscription-token"), "brave-key-123456");

  const failing = fakeFetch(() => jsonResponse(500, { error: { message: "upstream down" } }));
  const noFallback = createWebSearchRunner({ provider: () => undefined, sources: sources({ fetch: failing.fetch, chatgpt: async () => new Headers(), searchKey: async () => "brave-key-123456" }) });
  await assert.rejects(noFallback(request, new AbortController().signal), /^Error: chatgpt: HTTP 500 upstream down/);
  assert.equal(failing.requests.length, 1, "the keyed backend was not tried after the ChatGPT failure");

  const missing = createWebSearchRunner({ provider: () => "tavily", sources: sources() });
  await assert.rejects(missing(request, new AbortController().signal), /tavily: no tavily API key/);
  const none = createWebSearchRunner({ provider: () => undefined, sources: sources() });
  await assert.rejects(none(request, new AbortController().signal), (error: unknown) => error instanceof Error && error.message === WEB_SEARCH_SETUP_HINT);
});

test("web_search anthropic-api: server web_search results and citations become results with snippets", async () => {
  const fake = fakeFetch(() =>
    jsonResponse(200, {
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://a.example/x", title: "A", page_age: "1 day", encrypted_content: "..." }] },
        { type: "text", text: "A says yes.", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "A", cited_text: "yes indeed" }] },
      ],
    }),
  );
  const runner = createWebSearchRunner({ provider: () => "anthropic-api", sources: sources({ fetch: fake.fetch, anthropicApi: async () => new Headers({ "x-api-key": "sk-ant-test" }) }) });
  const answer = await runner(request, new AbortController().signal);
  assert.deepEqual(answer.results, [{ title: "A", url: "https://a.example/x", snippet: "yes indeed", page_age: "1 day" }]);
  const body = JSON.parse(fake.requests[0]?.body ?? "{}") as { tools: { type: string }[] };
  assert.equal(body.tools[0]?.type, "web_search_20250305");
});

test("web_search claude-code: a fake claude with only WebSearch returns the JSON the prompt asks for", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-fake-claude-search-"));
  const script = path.join(directory, "fake-claude-search.mjs");
  await writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const args = process.argv.slice(2);",
      "  const tools = args[args.indexOf('--tools') + 1];",
      "  if (tools !== 'WebSearch' || !input.includes('Search the web for: vitest latest version')) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'bad invocation ' + tools })); return; }",
      "  const result = 'Here: ' + JSON.stringify({ answer: 'Vitest 4.2', results: [{ title: 'Vitest', url: 'https://vitest.dev', snippet: 'testing' }] });",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }) + '\\n');",
      "});",
    ].join("\n"),
  );
  t.after(() => undefined);
  const answer = await searchViaClaudeCode({ executable: { command: process.execPath, args: [script] }, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "must-be-stripped" }, cwd: directory }, request, new AbortController().signal);
  assert.equal(answer.backend, "claude-code");
  assert.equal(answer.answer, "Vitest 4.2");
  assert.deepEqual(answer.results, [{ title: "Vitest", url: "https://vitest.dev", snippet: "testing" }]);
  assert.throws(() => parseClaudeSearch(JSON.stringify({ type: "result", is_error: true, result: "Login expired" }), 5), /Login expired/);
});

test("OpenAI native search: hosted web_search replaces Synorch's tool, searches are observed with their sources, citations stay visible", async () => {
  const fake = fakeFetch(() => sseResponse(HOSTED_SEARCH_STREAM));
  const observed: HostedSearchObserved[] = [];
  const adapter = createOpenAIChatGPTAdapter({ fetch: fake.fetch, hostedWebSearch: async () => true, onHostedSearch: (entry) => observed.push(entry) });
  const route = testRoute({ provider_id: "openai", model_id: "gpt-test", adapter_id: "openai-chatgpt", auth_method: "oauth-subscription" });
  const modelRequest = testRequest(route, {
    tools: [
      { name: "read_file", description: "Read", input_schema: { type: "object" } },
      { name: "web_search", description: "Search", input_schema: { type: "object" } },
    ],
  });
  const result = await collectStream(adapter.stream(modelRequest, staticCredential("openai", "sk-test-secret-value"), new AbortController().signal));
  const body = JSON.parse(fake.requests[0]?.body ?? "{}") as { tools: { type: string; name?: string }[] };
  assert.deepEqual(body.tools.map((tool) => tool.name ?? tool.type), ["read_file", "web_search"]);
  assert.deepEqual(body.tools[1], { type: "web_search", external_web_access: true });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0]?.queries, ["vitest latest version"]);
  assert.deepEqual(observed[0]?.sources, [{ title: "Vitest blog", url: "https://vitest.dev/blog" }]);
  const done = result.events.at(-1) as Extract<ModelStreamEvent, { type: "done" }>;
  assert.equal(done.type, "done");
  const text = done.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  assert.match(text, /Vitest 4\.2 is the latest\.\n\nSources:\n- \[Vitest blog\]\(https:\/\/vitest\.dev\/blog\)/);
});

test("OpenAI native search: an endpoint that refuses the hosted tool gets one resend with Synorch's tool, and later requests skip it", async () => {
  let calls = 0;
  const fake = fakeFetch((recorded) => {
    calls += 1;
    const tools = (JSON.parse(recorded.body) as { tools: { type: string }[] }).tools;
    if (tools.some((tool) => tool.type === "web_search")) return jsonResponse(400, { error: { type: "invalid_request_error", message: "Tool 'web_search' is not supported with this model" } });
    return sseResponse(sse([{ type: "response.output_text.delta", output_index: 0, delta: "ok" }, { type: "response.completed", response: {} }]));
  });
  let asked = 0;
  const adapter = createOpenAIChatGPTAdapter({ fetch: fake.fetch, hostedWebSearch: async () => {
    asked += 1;
    return true;
  } });
  const route = testRoute({ provider_id: "openai", model_id: "gpt-test", adapter_id: "openai-chatgpt", auth_method: "oauth-subscription" });
  const modelRequest = testRequest(route, { tools: [{ name: "web_search", description: "Search", input_schema: { type: "object" } }] });
  const first = await collectStream(adapter.stream(modelRequest, staticCredential("openai", "sk-test-secret-value"), new AbortController().signal));
  assert.equal(first.events.at(-1)?.type, "done");
  assert.equal(calls, 2);
  const second = await collectStream(adapter.stream({ ...modelRequest }, staticCredential("openai", "sk-test-secret-value"), new AbortController().signal));
  assert.equal(second.events.at(-1)?.type, "done");
  assert.equal(calls, 3);
  assert.equal(asked, 1, "the hosted tool is not offered again after a refusal");
  const lastTools = (JSON.parse(fake.requests.at(-1)?.body ?? "{}") as { tools: { type: string; name?: string }[] }).tools;
  assert.deepEqual(lastTools.map((tool) => tool.type), ["function"]);
});
