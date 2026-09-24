import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contentPartSchema, digestText, type ContentPart, type ModelAdapter, type ModelRequest } from "../src/harness/contracts/index.ts";
import { resolveAttachments } from "../src/harness/cli/attachments.ts";
import { withImageData } from "../src/harness/core/driver.ts";
import { collectStream, createAnthropicMessagesAdapter, createOpenAIChatGPTAdapter, createOpenAIResponsesAdapter } from "../src/harness/providers/index.ts";
import { fakeFetch, sseResponse, staticCredential, testRequest, testRoute } from "../src/harness/providers/testing.ts";
import { createBlobStore } from "../src/harness/store/index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngBase64 = PNG.toString("base64");
const imagePart = (data?: string): ContentPart => ({ type: "image", blob: { digest: digestText("png"), size_bytes: PNG.length, media_type: "image/png" }, ...(data === undefined ? {} : { data }) });

async function bodyOf(adapter: ModelAdapter, route: ReturnType<typeof testRoute>, fetch: ReturnType<typeof fakeFetch>, part: ContentPart) {
  const request = testRequest(route, { messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, part] }] });
  const credential = staticCredential(adapter.providerId, "sk-test-secret-value", adapter.providerId === "anthropic" ? "x-api-key" : "authorization");
  const result = await collectStream(adapter.stream(request, credential, new AbortController().signal));
  return { events: result.events, body: fetch.requests[0] === undefined ? undefined : (JSON.parse(fetch.requests[0].body) as Record<string, unknown>) };
}

test("image part: schema caps size and media type", () => {
  assert.ok(contentPartSchema.safeParse(imagePart()).success);
  assert.ok(!contentPartSchema.safeParse({ type: "image", blob: { digest: digestText("x"), size_bytes: 6 * 1024 * 1024, media_type: "image/png" } }).success);
  assert.ok(!contentPartSchema.safeParse({ type: "image", blob: { digest: digestText("x"), size_bytes: 10, media_type: "image/svg+xml" } }).success);
});

test("OpenAI Responses adapters send input_image data URLs (chatgpt and api key)", async () => {
  for (const [create, adapterId] of [[createOpenAIChatGPTAdapter, "openai-chatgpt"], [createOpenAIResponsesAdapter, "openai-responses"]] as const) {
    const fetch = fakeFetch(() => sseResponse(""));
    const route = testRoute({ provider_id: "openai", model_id: "gpt-test", adapter_id: adapterId, ...(adapterId === "openai-chatgpt" ? { auth_method: "oauth-subscription" as const } : {}) });
    const { body } = await bodyOf(create({ fetch: fetch.fetch }), route, fetch, imagePart(pngBase64));
    const input = body?.input as { content: Record<string, unknown>[] }[];
    assert.deepEqual(input.at(-1)?.content, [
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: `data:image/png;base64,${pngBase64}`, detail: "auto" },
    ]);
  }
});

test("Anthropic Messages adapter sends a base64 image block", async () => {
  const fetch = fakeFetch(() => sseResponse(""));
  const route = testRoute({ provider_id: "anthropic", model_id: "claude-api-model", adapter_id: "anthropic-messages" });
  const { body } = await bodyOf(createAnthropicMessagesAdapter({ fetch: fetch.fetch }), route, fetch, imagePart(pngBase64));
  const messages = body?.messages as { content: Record<string, unknown>[] }[];
  const image = messages.at(-1)?.content.find((block) => block.type === "image");
  assert.deepEqual(image?.source, { type: "base64", media_type: "image/png", data: pngBase64 });
});

test("an image part without bytes is refused before any request", async () => {
  const fetch = fakeFetch(() => sseResponse(""));
  const route = testRoute({ provider_id: "anthropic", model_id: "claude-api-model", adapter_id: "anthropic-messages" });
  const { events, body } = await bodyOf(createAnthropicMessagesAdapter({ fetch: fetch.fetch }), route, fetch, imagePart());
  assert.equal(body, undefined);
  const last = events.at(-1);
  assert.ok(last?.type === "error" && last.error.code === "invalid_request");
});

test("attachments store a clipboard image in the blob store, delete the temp file, and the driver hydrates it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-images-"));
  try {
    const temp = path.join(root, "clip.png");
    await writeFile(temp, PNG);
    const blobs = createBlobStore(path.join(root, "home"));
    const attachment = { id: "image-1", kind: "image" as const, label: "[image 1]", path: temp, displayPath: "clipboard image", mediaType: "image/png", bytes: PNG.length, source: "clipboard" as const, temporary: true };
    const result = await resolveAttachments("look [image 1]", [attachment], { workspaceRoot: root, model: "gpt-test", images: { send: true, reason: "", put: (bytes, type) => blobs.put(bytes, type) } });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]?.media_type, "image/png");
    assert.match(result.message, /<image name="\[image 1\]" index="1" media_type="image\/png"/);
    await assert.rejects(access(temp));
    const request = { messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image", blob: result.images[0] }] }] } as unknown as ModelRequest;
    const hydrated = await withImageData(blobs, request);
    const part = hydrated.messages[0]?.content[1];
    assert.ok(part?.type === "image" && part.data === pngBase64);
    assert.equal((request.messages[0]?.content[1] as { data?: string }).data, undefined, "the recorded request stays byte-free");

    await writeFile(temp, PNG);
    const refused = await resolveAttachments("look [image 1]", [attachment], { workspaceRoot: root, model: "claude", images: { send: false, reason: "images are not sent through the Claude Code bridge yet", put: () => Promise.reject(new Error("unused")) } });
    assert.equal(refused.images.length, 0);
    assert.ok(refused.notices.some((notice) => /Claude Code bridge/.test(notice.text)));
    await assert.rejects(readFile(temp));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
