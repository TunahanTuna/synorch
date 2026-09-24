import { SYNORCH_VERSION } from "../../domain/product.ts";
import { ANTHROPIC_API_BASE_URL, ANTHROPIC_VERSION } from "./anthropic-messages.ts";
import { bridgeEnvironment, spawnBackend, terminate, type ExecutableSpec } from "./claude-code/process.ts";
import type { FetchLike } from "./http-stream.ts";
import { CHATGPT_CODEX_BASE_URL, OPENAI_API_BASE_URL, SYNORCH_ORIGINATOR } from "./responses.ts";
import { readSse, parseSseJson } from "./sse.ts";

/**
 * K4.1 `web_search` backends (orchestrator decisions 2026-09-24): a separate, short sub-request
 * that carries only the query (never the session history, files or system prompt).
 *
 * - `chatgpt`: the ChatGPT subscription's Codex Responses endpoint with the hosted `web_search`
 *   tool, live (`external_web_access: true`); no extra key, it counts against the subscription.
 * - `claude-code`: the user's logged-in Claude Code with only its WebSearch tool enabled.
 * - `openai-api` / `anthropic-api`: the hosted search of the Responses / Messages API (API key).
 * - `brave` / `tavily` / `exa`: the user's own search API key (credential store or environment).
 *
 * `auto` picks the first available in that order; a configured provider is used alone. A failed
 * search never falls back to another backend silently: the error names the backend and a fix.
 */

export const WEB_SEARCH_PROVIDERS = ["auto", "chatgpt", "claude-code", "openai-api", "anthropic-api", "brave", "tavily", "exa"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
export type WebSearchBackend = Exclude<WebSearchProvider, "auto">;
/** Backends that need the user's own search API key. */
export const KEYED_SEARCH_BACKENDS = ["brave", "tavily", "exa"] as const;
export type KeyedSearchBackend = (typeof KEYED_SEARCH_BACKENDS)[number];
export const SEARCH_KEY_ENV: { readonly [B in KeyedSearchBackend]: string } = { brave: "BRAVE_API_KEY", tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY" };

/** Cheap models for the sub-request; a "model not supported" answer retries the next one (same backend only). */
export const CHATGPT_SEARCH_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-6-astra"] as const;
export const OPENAI_API_SEARCH_MODEL = "gpt-6-luna";
export const ANTHROPIC_SEARCH_MODEL = "claude-haiku-4-5";

export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly allowedDomains: readonly string[];
}

export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly page_age?: string;
}

export interface SearchAnswer {
  readonly backend: WebSearchBackend;
  readonly results: readonly SearchResultItem[];
  readonly answer?: string;
}

export class WebSearchError extends Error {
  public readonly backend: WebSearchBackend | undefined;
  public constructor(backend: WebSearchBackend | undefined, message: string) {
    super(backend === undefined ? message : `${backend}: ${message}`);
    this.backend = backend;
  }
}

const SEARCH_INSTRUCTIONS =
  "You are a web search helper. Search the web for the user's query, then answer in at most five sentences, citing the pages you used. Do not ask questions.";

function userAgent(): string {
  return `synorch/${SYNORCH_VERSION}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function dedupe(items: readonly SearchResultItem[], limit: number): SearchResultItem[] {
  const seen = new Map<string, SearchResultItem>();
  for (const item of items) {
    if (!/^https?:\/\//i.test(item.url)) continue;
    const existing = seen.get(item.url);
    if (existing === undefined) seen.set(item.url, item);
    else if (existing.snippet === "" && item.snippet !== "") seen.set(item.url, { ...existing, snippet: item.snippet });
  }
  return [...seen.values()].slice(0, limit);
}

async function failureText(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  let message = body.slice(0, 400);
  try {
    const parsed = record(JSON.parse(body));
    const error = record(parsed?.error) ?? parsed;
    message = text(error?.message) ?? text(parsed?.detail) ?? message;
  } catch {
    // not JSON
  }
  return `HTTP ${response.status}${message === "" ? "" : ` ${message.slice(0, 400)}`}`;
}

export interface ResponsesSearchOptions {
  readonly fetch: FetchLike;
  /** Headers carrying the credential (subscription OAuth or API key). */
  readonly headers: Headers;
  readonly subscription: boolean;
  readonly baseUrl?: string;
  readonly models: readonly string[];
}

/** One search through the Responses API's hosted `web_search` tool (ChatGPT subscription or API key). */
export async function searchViaResponses(options: ResponsesSearchOptions, request: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
  const backend: WebSearchBackend = options.subscription ? "chatgpt" : "openai-api";
  const base = (options.baseUrl ?? (options.subscription ? CHATGPT_CODEX_BASE_URL : OPENAI_API_BASE_URL)).replace(/\/+$/, "");
  let lastError = "no model accepted the search";
  for (const model of options.models) {
    const tool: Record<string, unknown> = { type: "web_search" };
    if (options.subscription) tool.external_web_access = true;
    if (request.allowedDomains.length > 0) tool.filters = { allowed_domains: request.allowedDomains.slice(0, 20) };
    const body = {
      model,
      instructions: SEARCH_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: request.query }] }],
      tools: [tool],
      tool_choice: "auto",
      store: false,
      stream: true,
    };
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    headers.set("user-agent", userAgent());
    if (options.subscription) {
      headers.set("originator", SYNORCH_ORIGINATOR);
      headers.set("OpenAI-Beta", "responses=experimental");
    }
    let response: Response;
    try {
      response = await options.fetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error: unknown) {
      throw new WebSearchError(backend, `request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      lastError = await failureText(response);
      if ((response.status === 400 || response.status === 404) && /model/i.test(lastError)) continue;
      throw new WebSearchError(backend, lastError);
    }
    if (response.body === null) throw new WebSearchError(backend, "empty response body");
    return parseResponsesSearch(backend, response.body as unknown as AsyncIterable<Uint8Array>, request.maxResults);
  }
  throw new WebSearchError(backend, lastError);
}

/** Parses a Responses SSE stream of a hosted search into results (url_citation annotations, search sources) and the answer text. */
export async function parseResponsesSearch(backend: WebSearchBackend, body: AsyncIterable<Uint8Array>, limit: number): Promise<SearchAnswer> {
  let answer = "";
  let finalText: string | undefined;
  const cited: SearchResultItem[] = [];
  const sources: SearchResultItem[] = [];
  for await (const message of readSse(body)) {
    const payload = parseSseJson(message.data);
    if (payload === undefined) continue;
    const type = text(payload.type) ?? message.event ?? "";
    if (type === "response.output_text.delta") answer += text(payload.delta) ?? "";
    else if (type === "response.output_item.done") {
      const item = record(payload.item);
      if (text(item?.type) === "message" && Array.isArray(item?.content)) {
        for (const rawPart of item.content) {
          const part = record(rawPart);
          const partText = text(part?.text) ?? "";
          finalText = (finalText ?? "") + partText;
          for (const rawAnnotation of Array.isArray(part?.annotations) ? part.annotations : []) {
            const annotation = record(rawAnnotation);
            if (text(annotation?.type) !== "url_citation") continue;
            const url = text(annotation?.url) ?? "";
            const start = typeof annotation?.start_index === "number" ? annotation.start_index : undefined;
            const end = typeof annotation?.end_index === "number" ? annotation.end_index : undefined;
            const snippet = start !== undefined && end !== undefined && end > start ? partText.slice(start, end) : "";
            cited.push({ title: text(annotation?.title) ?? hostOf(url), url, snippet: snippet.replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "").trim() });
          }
        }
      } else if (text(item?.type) === "web_search_call") {
        const action = record(item?.action);
        for (const rawSource of Array.isArray(action?.sources) ? action.sources : []) {
          const url = text(record(rawSource)?.url);
          if (url !== undefined) sources.push({ title: text(record(rawSource)?.title) ?? hostOf(url), url, snippet: "" });
        }
      }
    } else if (type === "response.failed" || type === "error") {
      const error = record(record(payload.response)?.error) ?? record(payload.error) ?? payload;
      throw new WebSearchError(backend, text(error.message) ?? "the search failed");
    } else if (type === "response.incomplete") {
      break;
    }
  }
  const results = dedupe([...cited, ...sources], limit);
  const full = (finalText ?? answer).trim();
  return { backend, results, ...(full === "" ? {} : { answer: full }) };
}

export interface AnthropicSearchOptions {
  readonly fetch: FetchLike;
  readonly headers: Headers;
  readonly baseUrl?: string;
  readonly model?: string;
}

/** One search through the Messages API's server `web_search` tool (API key). */
export async function searchViaAnthropic(options: AnthropicSearchOptions, request: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
  const base = (options.baseUrl ?? ANTHROPIC_API_BASE_URL).replace(/\/+$/, "");
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("user-agent", userAgent());
  const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
  if (request.allowedDomains.length > 0) tool.allowed_domains = request.allowedDomains.slice(0, 20);
  const body = {
    model: options.model ?? ANTHROPIC_SEARCH_MODEL,
    max_tokens: 1024,
    system: SEARCH_INSTRUCTIONS,
    messages: [{ role: "user", content: request.query }],
    tools: [tool],
  };
  let response: Response;
  try {
    response = await options.fetch(`${base}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (error: unknown) {
    throw new WebSearchError("anthropic-api", `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new WebSearchError("anthropic-api", await failureText(response));
  const parsed = record(await response.json().catch(() => undefined));
  const results: SearchResultItem[] = [];
  const snippets = new Map<string, string>();
  let answer = "";
  for (const rawBlock of Array.isArray(parsed?.content) ? parsed.content : []) {
    const block = record(rawBlock);
    const type = text(block?.type);
    if (type === "web_search_tool_result" && Array.isArray(block?.content)) {
      for (const rawResult of block.content) {
        const result = record(rawResult);
        if (text(result?.type) !== "web_search_result") continue;
        const url = text(result?.url) ?? "";
        const age = text(result?.page_age);
        results.push({ title: text(result?.title) ?? hostOf(url), url, snippet: "", ...(age === undefined ? {} : { page_age: age }) });
      }
    } else if (type === "web_search_tool_result") {
      const error = record(block?.content);
      if (text(error?.type) === "web_search_tool_result_error") throw new WebSearchError("anthropic-api", `search error ${text(error?.error_code) ?? "unknown"}`);
    } else if (type === "text") {
      answer += text(block?.text) ?? "";
      for (const rawCitation of Array.isArray(block?.citations) ? block.citations : []) {
        const citation = record(rawCitation);
        const url = text(citation?.url);
        const cited = text(citation?.cited_text);
        if (url !== undefined && cited !== undefined && !snippets.has(url)) snippets.set(url, cited);
      }
    }
  }
  const merged = results.map((item) => ({ ...item, snippet: snippets.get(item.url) ?? item.snippet }));
  return { backend: "anthropic-api", results: dedupe(merged, request.maxResults), ...(answer.trim() === "" ? {} : { answer: answer.trim() }) };
}

export interface KeyedSearchOptions {
  readonly fetch: FetchLike;
  readonly apiKey: string;
}

/** Brave / Tavily / Exa with the user's own key. */
export async function searchViaKeyed(backend: KeyedSearchBackend, options: KeyedSearchOptions, request: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
  const query = request.allowedDomains.length > 0 && backend === "brave" ? `${request.query} ${request.allowedDomains.map((domain) => `site:${domain}`).join(" OR ")}` : request.query;
  let response: Response;
  try {
    if (backend === "brave") {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, request.maxResults)}`;
      response = await options.fetch(url, { method: "GET", headers: { accept: "application/json", "x-subscription-token": options.apiKey, "user-agent": userAgent() }, signal });
    } else if (backend === "tavily") {
      response = await options.fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, "user-agent": userAgent() },
        body: JSON.stringify({ query, max_results: request.maxResults, include_answer: true, ...(request.allowedDomains.length > 0 ? { include_domains: request.allowedDomains } : {}) }),
        signal,
      });
    } else {
      response = await options.fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": options.apiKey, "user-agent": userAgent() },
        body: JSON.stringify({ query, numResults: request.maxResults, contents: { text: { maxCharacters: 400 } }, ...(request.allowedDomains.length > 0 ? { includeDomains: request.allowedDomains } : {}) }),
        signal,
      });
    }
  } catch (error: unknown) {
    throw new WebSearchError(backend, `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new WebSearchError(backend, await failureText(response));
  const parsed = record(await response.json().catch(() => undefined));
  const items: SearchResultItem[] = [];
  let answer: string | undefined;
  if (backend === "brave") {
    for (const raw of Array.isArray(record(parsed?.web)?.results) ? (record(parsed?.web)?.results as unknown[]) : []) {
      const item = record(raw);
      const age = text(item?.age);
      items.push({ title: text(item?.title) ?? "", url: text(item?.url) ?? "", snippet: (text(item?.description) ?? "").replace(/<[^>]+>/g, ""), ...(age === undefined ? {} : { page_age: age }) });
    }
  } else if (backend === "tavily") {
    answer = text(parsed?.answer);
    for (const raw of Array.isArray(parsed?.results) ? parsed.results : []) {
      const item = record(raw);
      items.push({ title: text(item?.title) ?? "", url: text(item?.url) ?? "", snippet: text(item?.content) ?? "" });
    }
  } else {
    for (const raw of Array.isArray(parsed?.results) ? parsed.results : []) {
      const item = record(raw);
      const age = text(item?.publishedDate);
      items.push({ title: text(item?.title) ?? "", url: text(item?.url) ?? "", snippet: text(item?.text) ?? "", ...(age === undefined ? {} : { page_age: age }) });
    }
  }
  return { backend, results: dedupe(items, request.maxResults), ...(answer === undefined || answer.trim() === "" ? {} : { answer }) };
}

export interface ClaudeCodeSearchOptions {
  readonly executable: ExecutableSpec;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

/** `claude -p` with only WebSearch enabled and no settings, MCP or session history. */
export function claudeSearchArgs(): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "WebSearch",
    "--allowedTools",
    "WebSearch",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--max-turns",
    "4",
    "--model",
    "haiku",
  ];
}

/** One search through the user's logged-in Claude Code (subscription), WebSearch only. */
export function searchViaClaudeCode(options: ClaudeCodeSearchOptions, request: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
  const prompt = [
    `Search the web for: ${request.query}`,
    request.allowedDomains.length > 0 ? `Only use results from: ${request.allowedDomains.join(", ")}.` : "",
    `Then reply with ONLY one JSON object, no prose and no code fence: {"answer": "<at most five sentences>", "results": [{"title": "...", "url": "...", "snippet": "..."}]} with at most ${request.maxResults} results.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return new Promise((resolve, reject) => {
    const platform = options.platform ?? process.platform;
    let child;
    try {
      child = spawnBackend(options.executable, claudeSearchArgs(), { cwd: options.cwd, env: bridgeEnvironment(options.env, {}, platform), platform });
    } catch (error: unknown) {
      reject(new WebSearchError("claude-code", `claude could not be started: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    const stop = (): void => terminate(child, "SIGTERM", platform);
    const timer = setTimeout(stop, options.timeoutMs ?? 120_000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-512 * 1024);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(prompt);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new WebSearchError("claude-code", `claude could not be started: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) {
        reject(new WebSearchError("claude-code", "the search was cancelled"));
        return;
      }
      try {
        resolve(parseClaudeSearch(stdout, request.maxResults));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new WebSearchError("claude-code", `${detail}${code === 0 ? "" : ` (exit ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(-300)}`})`}`));
      }
    });
  });
}

/** Reads `claude -p --output-format json` output: the `result` text holds the JSON object the prompt asked for. */
export function parseClaudeSearch(stdout: string, limit: number): SearchAnswer {
  const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
  let envelope: Record<string, unknown> | undefined;
  for (const line of [stdout.trim(), ...lines.reverse()]) {
    try {
      const parsed = record(JSON.parse(line));
      if (parsed !== undefined && (parsed.type === "result" || "result" in parsed)) {
        envelope = parsed;
        break;
      }
    } catch {
      continue;
    }
  }
  if (envelope === undefined) throw new Error("claude returned no result");
  if (envelope.is_error === true) throw new Error(text(envelope.result) ?? "claude reported an error");
  const resultText = text(envelope.result) ?? "";
  const start = resultText.indexOf("{");
  const end = resultText.lastIndexOf("}");
  let payload: Record<string, unknown> | undefined;
  if (start !== -1 && end > start) {
    try {
      payload = record(JSON.parse(resultText.slice(start, end + 1)));
    } catch {
      payload = undefined;
    }
  }
  if (payload === undefined) {
    const urls = [...resultText.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((match) => match[0]);
    return { backend: "claude-code", results: dedupe(urls.map((url) => ({ title: hostOf(url), url, snippet: "" })), limit), ...(resultText.trim() === "" ? {} : { answer: resultText.trim() }) };
  }
  const items: SearchResultItem[] = [];
  for (const raw of Array.isArray(payload.results) ? payload.results : []) {
    const item = record(raw);
    items.push({ title: text(item?.title) ?? "", url: text(item?.url) ?? "", snippet: text(item?.snippet) ?? "" });
  }
  const answer = text(payload.answer);
  return { backend: "claude-code", results: dedupe(items, limit), ...(answer === undefined || answer.trim() === "" ? {} : { answer: answer.trim() }) };
}

/** What the composition root knows how to provide for each backend (undefined: not available now). */
export interface WebSearchSources {
  readonly fetch: FetchLike;
  /** Headers with the ChatGPT subscription credential, or undefined when not logged in. */
  chatgpt(signal: AbortSignal): Promise<Headers | undefined>;
  openaiApi(signal: AbortSignal): Promise<Headers | undefined>;
  anthropicApi(signal: AbortSignal): Promise<Headers | undefined>;
  /** The Claude Code executable when the bridge is enabled and installed. */
  claudeCode(signal: AbortSignal): Promise<ClaudeCodeSearchOptions | undefined>;
  /** A user search API key (credential store or environment). */
  searchKey(backend: KeyedSearchBackend): Promise<string | undefined>;
}

export interface WebSearchRunnerOptions {
  /** `web.search.provider` (user layer); `auto` or undefined picks the first available backend. */
  readonly provider: () => WebSearchProvider | undefined;
  /** `web.search.model`: the model of the ChatGPT / OpenAI API sub-request. */
  readonly model?: () => string | undefined;
  readonly sources: WebSearchSources;
}

export const WEB_SEARCH_SETUP_HINT =
  "no web search backend is set up. Any one of: log in to ChatGPT (syn login openai), enable the Claude Code bridge (syn login anthropic --method cli-bridge), set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use your own search key (syn config set web.search.provider brave|tavily|exa, then syn config set web.search.api_key <key>, which goes to the credential store)";

/** The `web_search` runner: resolves the backend per call (auto order or the configured one) and runs it, never falling back silently. */
export function createWebSearchRunner(options: WebSearchRunnerOptions): (request: SearchRequest, signal: AbortSignal) => Promise<SearchAnswer> {
  const { sources } = options;
  const run = async (backend: WebSearchBackend, request: SearchRequest, signal: AbortSignal, required: boolean): Promise<SearchAnswer | undefined> => {
    const missing = (what: string): undefined => {
      if (required) throw new WebSearchError(backend, `${what} (web.search.provider is ${backend}; unset it to pick a backend automatically)`);
      return undefined;
    };
    const model = options.model?.();
    switch (backend) {
      case "chatgpt": {
        const headers = await sources.chatgpt(signal);
        if (headers === undefined) return missing("not logged in to ChatGPT; run syn login openai");
        return searchViaResponses({ fetch: sources.fetch, headers, subscription: true, models: model === undefined ? CHATGPT_SEARCH_MODELS : [model] }, request, signal);
      }
      case "openai-api": {
        const headers = await sources.openaiApi(signal);
        if (headers === undefined) return missing("no OpenAI API key; set OPENAI_API_KEY or run syn login openai --method api-key");
        return searchViaResponses({ fetch: sources.fetch, headers, subscription: false, models: [model ?? OPENAI_API_SEARCH_MODEL] }, request, signal);
      }
      case "anthropic-api": {
        const headers = await sources.anthropicApi(signal);
        if (headers === undefined) return missing("no Anthropic API key; set ANTHROPIC_API_KEY or run syn login anthropic --method api-key");
        return searchViaAnthropic({ fetch: sources.fetch, headers }, request, signal);
      }
      case "claude-code": {
        const claude = await sources.claudeCode(signal);
        if (claude === undefined) return missing("the Claude Code bridge is not enabled or claude is not installed; run syn login anthropic --method cli-bridge");
        return searchViaClaudeCode(claude, request, signal);
      }
      case "brave":
      case "tavily":
      case "exa": {
        const key = await sources.searchKey(backend);
        if (key === undefined) return missing(`no ${backend} API key; run syn config set web.search.api_key <key> (credential store) or set ${SEARCH_KEY_ENV[backend]}`);
        return searchViaKeyed(backend, { fetch: sources.fetch, apiKey: key }, request, signal);
      }
    }
  };
  return async (request, signal) => {
    const configured = options.provider();
    if (configured !== undefined && configured !== "auto") {
      const answer = await run(configured, request, signal, true);
      if (answer === undefined) throw new WebSearchError(configured, "unavailable");
      return answer;
    }
    for (const backend of ["chatgpt", "claude-code", "openai-api", "anthropic-api", ...KEYED_SEARCH_BACKENDS] as const) {
      const answer = await run(backend, request, signal, false);
      if (answer !== undefined) return answer;
    }
    throw new WebSearchError(undefined, WEB_SEARCH_SETUP_HINT);
  };
}
