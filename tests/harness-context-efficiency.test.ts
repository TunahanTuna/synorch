import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  blockTokens,
  compactSchema,
  createContextBuilder,
  createSkillContextRegistry,
  createSkillLoadCallback,
  foldForMatch,
  messageTokens,
  promptCacheKey,
  renderPacketView,
  selectTools,
  toolTokens,
  triggeredSkills,
  type ContextBuilderDependencies,
  type SkillCatalog,
  type SkillEntry,
} from "../src/harness/context/index.ts";
import {
  createId,
  digestText,
  EVENT_VERSIONS,
  modelRequestSchema,
  sha256,
  taskContextPacketSchema,
  type Actor,
  type AgentRole,
  type AttemptId,
  type ContextBuildInput,
  type EventStore,
  type ModelMessage,
  type ModelRequest,
  type SessionEventDraft,
  type SessionId,
  type TaskContextPacket,
  type TaskId,
  type ToolDescriptor,
  type ToolExecutionContext,
} from "../src/harness/contracts/index.ts";
import { compileTaskPacket } from "../src/harness/orchestration/index.ts";
import { createFakePolicyEngine, createMemoryBlobStore, createMemorySessionStore, createStaticToolRegistry, TEST_SANDBOX, testRoute } from "../src/harness/orchestration/testing.ts";

/**
 * ADR-20 (W1d): role-scoped, cacheable, compact model context. The last test replays the second
 * live run (run_01M35VYXAC79ST06QZBAFGWT1S) from its recorded envelopes and measures the request
 * count and estimated input tokens before and after.
 */

const FIXTURE = new URL("./fixtures/providers/live-run-2-replay.json", import.meta.url);

interface LiveSession {
  readonly messages: ModelMessage[];
  readonly before: {
    readonly requests: number;
    readonly estimated_tokens: number[];
    readonly fixed_prefix_tokens: number[];
    readonly provider_input_tokens: number[];
    readonly provider_cache_read_tokens: number[];
  };
}

interface LiveFixture {
  readonly instructions: { constitution: string; protocols: { id: string; text: string }[]; roles: Partial<Record<AgentRole, string>> };
  readonly skills: {
    catalog: Record<"orchestrator" | "implementer", SkillEntry[]>;
    primary: Record<"orchestrator" | "implementer", string[]>;
    bodies: Record<string, string>;
  };
  readonly tools: Record<"orchestrator" | "implementer", ToolDescriptor[]>;
  readonly packets: { attempt1: unknown; attempt2: unknown };
  readonly sessions: { orchestrator: LiveSession; attempt1: LiveSession; attempt2: LiveSession };
}

async function live(): Promise<LiveFixture> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as LiveFixture;
}

function liveCatalog(fixture: LiveFixture): SkillCatalog {
  const roleOf = (role: AgentRole | undefined) => (role === "orchestrator" ? "orchestrator" : "implementer");
  return {
    list: (role) => fixture.skills.catalog[roleOf(role)],
    load: async (name, role) => {
      const entry = fixture.skills.catalog[roleOf(role)].find((candidate) => candidate.name === name);
      // Skills the live run never loaded have no recorded body; a stand-in of realistic size replaces it.
      return entry === undefined ? undefined : (fixture.skills.bodies[name] ?? `# ${name}\n\n${entry.description}\n\n${entry.description}`);
    },
    primary: (role) => fixture.skills.primary[roleOf(role)],
  };
}

function policyFor(role: AgentRole, runId: ReturnType<typeof createId<"run">>, owned: string[] = []) {
  return createFakePolicyEngine().compute({
    mode: "autonomous",
    role,
    runId,
    taskId: undefined,
    workspaceRoot: "/w",
    taskScope: role === "orchestrator" ? undefined : { owned, read: [], forbidden: [] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: TEST_SANDBOX,
    grants: [],
  });
}

async function newSession() {
  const sessions = createMemorySessionStore();
  const blobs = createMemoryBlobStore();
  const sessionId: SessionId = createId("session");
  const store = await sessions.create({ session_id: sessionId, project_id: "proj-1234abcd" as never, workspace_root: "/w", created_at: "2026-09-23T00:00:00Z" });
  return { sessions, blobs, store, sessionId };
}

async function append(store: EventStore, type: SessionEventDraft["type"], data: unknown, actor: Actor, correlation: { runId: string; taskId?: TaskId; attemptId?: AttemptId }): Promise<void> {
  await store.append({
    type,
    data,
    event_version: EVENT_VERSIONS[type],
    actor,
    run_id: correlation.runId,
    ...(correlation.taskId === undefined ? {} : { task_id: correlation.taskId }),
    ...(correlation.attemptId === undefined ? {} : { attempt_id: correlation.attemptId }),
  } as SessionEventDraft);
}

function packetFor(options: { owned?: string[]; read?: string[]; objective?: string; decisions?: string[] } = {}): TaskContextPacket {
  const packet = compileTaskPacket({
    plan: {
      schema_version: 1,
      plan_id: createId("plan"),
      run_id: createId("run"),
      version: 1,
      goal: "g",
      risk: "standard",
      scope: ["src/**"],
      tasks: [],
      expected_external_effects: [],
      verification: [],
      budget: { max_wall_time_seconds: 60, max_steps: 10 },
      assumptions: [],
      created_at: "2026-09-22T10:00:00Z",
    } as never,
    planDigest: sha256("plan"),
    task: {
      key: "t",
      role: "implementer",
      objective: options.objective ?? "Fix add",
      depends_on: [],
      owned_paths: options.owned ?? ["src/**"],
      read_paths: options.read ?? ["docs/spec.md"],
      risk: "standard",
      model_tier: "complex_worker",
      acceptance_criteria: [{ id: "AC-1", statement: "works" }],
      verification: ["node check.mjs"],
    },
    taskId: createId("task"),
    createdAt: "2026-09-22T10:00:00Z",
    sources: [],
    findings: [],
    forbiddenPaths: [],
    preferWorktree: true,
  });
  return options.decisions === undefined ? packet : { ...packet, decisions: options.decisions };
}

function input(sessionId: SessionId, role: AgentRole, packet: TaskContextPacket | undefined, extra: Partial<ContextBuildInput> = {}): ContextBuildInput {
  const runId = extra.runId ?? createId("run");
  return {
    sessionId,
    runId,
    taskId: packet?.task_id,
    attemptId: undefined,
    role,
    route: testRoute("openai", "gpt-test"),
    policy: policyFor(role, runId, packet?.scope.owned_paths ?? []),
    packet,
    requestId: createId("request"),
    ...extra,
  };
}

const signal = new AbortController().signal;

function requestTokens(request: ModelRequest): { total: number; prefix: number; stable: number } {
  const system = request.system.reduce((sum, block) => sum + blockTokens(block), 0);
  const stable = request.system.slice(0, request.cache?.stable_system_blocks ?? 0).reduce((sum, block) => sum + blockTokens(block), 0);
  const tools = toolTokens(request.tools);
  return { total: system + tools + request.messages.reduce((sum, message) => sum + messageTokens(message), 0), prefix: system + tools, stable: stable + tools };
}

test("AC-d3 the cache key is <session>:<role> and the stable prefix is byte-identical across steps; variable blocks follow it", async () => {
  const fixture = await live();
  const { sessions, blobs, store, sessionId } = await newSession();
  const packet = packetFor();
  const deps: ContextBuilderDependencies = {
    readSession: (id) => sessions.openForRead(id),
    blobs,
    tools: createStaticToolRegistry(fixture.tools.implementer),
    instructions: fixture.instructions,
    skills: liveCatalog(fixture),
  };
  const builder = createContextBuilder(deps);
  const base = input(sessionId, "implementer", packet);
  const first = await builder.build(base, signal);
  const actor: Actor = { kind: "worker", role: "implementer" };
  await append(store, "message/recorded", { role: "user", message: { role: "user", content: [{ type: "text", text: "Task: fix add" }] } }, actor, { runId: base.runId, taskId: packet.task_id });
  await append(store, "message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading src/add.ts; a refresh fix might help." }] } }, actor, { runId: base.runId, taskId: packet.task_id });
  const second = await builder.build({ ...base, requestId: createId("request") }, signal);
  assert.ok(first.ok && second.ok);
  assert.ok(modelRequestSchema.safeParse(first.request).success);
  assert.deepEqual(first.request.cache, second.request.cache);
  assert.equal(first.request.cache?.key, `${sessionId}:implementer`);
  const stable = first.request.cache?.stable_system_blocks ?? 0;
  assert.ok(stable >= 4, `stable prefix covers harness, constitution, protocols, role and skills (${stable})`);
  const digests = (request: ModelRequest) => request.system.slice(0, stable).map((block) => block.digest);
  assert.deepEqual(digests(first.request), digests(second.request), "the cacheable prefix is byte-identical on the next step");
  assert.deepEqual(first.request.tools, second.request.tools, "the tool list is stable too");
  assert.ok(first.request.system.slice(0, stable).every((block) => ["harness", "constitution", "protocol", "role", "skill-catalog", "skill"].includes(block.source)));
  assert.ok(first.request.system.slice(stable).some((block) => block.source === "packet"), "the packet comes after the stable prefix");
  assert.equal(promptCacheKey("ses x/y", "implementer"), "ses-x-y:implementer");
  assert.ok(promptCacheKey(`ses_${"9".repeat(80)}`, "orchestrator").length <= 64);
});

test("AC-d4 protocols and tools are cut to the role and the task shape", async () => {
  const fixture = await live();
  const { sessions, blobs, sessionId } = await newSession();
  const all: ToolDescriptor[] = [...fixture.tools.orchestrator, ...fixture.tools.implementer.filter((tool) => !fixture.tools.orchestrator.some((other) => other.name === tool.name))];
  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(all), instructions: fixture.instructions, skills: liveCatalog(fixture) });
  const worker = await builder.build(input(sessionId, "implementer", packetFor({ owned: ["src-add.mjs"], read: ["src-add.mjs", "check.mjs"] })), signal);
  const globbed = await builder.build(input(sessionId, "implementer", packetFor()), signal);
  const orchestrator = await builder.build(input(sessionId, "orchestrator", undefined), signal);
  assert.ok(worker.ok && globbed.ok && orchestrator.ok);
  const protocols = (request: ModelRequest) => request.system.filter((block) => block.source === "protocol").map((block) => block.id);
  assert.deepEqual(protocols(worker.request), ["protocol:core.verification", "protocol:core.failure-recovery"]);
  assert.equal(protocols(orchestrator.request).length, 8, "the orchestrator keeps every protocol");
  const names = (request: ModelRequest) => request.tools.map((tool) => tool.name);
  assert.ok(!names(worker.request).includes("memory_propose"), "workers are not offered memory_propose");
  assert.ok(!names(worker.request).includes("list_dir") && !names(worker.request).includes("search"), "a named-files scope needs no discovery tools");
  assert.ok(names(globbed.request).includes("list_dir") && names(globbed.request).includes("search"), "a glob scope keeps discovery tools");
  assert.ok(names(orchestrator.request).includes("memory_propose"));
  const report = worker.request.tools.find((tool) => tool.name === "task_report");
  const original = fixture.tools.implementer.find((tool) => tool.name === "task_report");
  assert.ok(report !== undefined && original !== undefined);
  assert.ok(JSON.stringify(report).length < JSON.stringify(original).length * 0.9, "the task_report schema is compacted");
  assert.ok(!JSON.stringify(worker.request.tools).includes("$schema"));
});

test("compactSchema keeps structure, enums, patterns and required keys and drops only restated validation", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      default: { type: "string", minLength: 1 },
      minLength: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      tags: { type: "array", default: [], items: { type: "string", enum: ["a", "b"], pattern: "^[ab]$" } },
      limit: { type: "integer", minimum: 0, maximum: 10, default: 5 },
    },
    required: ["default"],
  };
  assert.deepEqual(compactSchema(schema), {
    type: "object",
    additionalProperties: false,
    properties: {
      default: { type: "string" },
      minLength: { type: "integer" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"], pattern: "^[ab]$" } },
      limit: { type: "integer", minimum: 0, maximum: 10, default: 5 },
    },
    required: ["default"],
  });
  const tools = selectTools([{ name: "load_skill", description: "d", input_schema: { type: "object" } }], { role: "implementer", packet: undefined, skillsLoadable: false });
  assert.deepEqual(tools, [], "load_skill is hidden when nothing is left to load");
});

test("AC-d5 skills are injected once: load_skill answers 'already in your context' or 'already loaded' without content", async () => {
  const fixture = await live();
  const { sessions, blobs, store, sessionId } = await newSession();
  const registry = createSkillContextRegistry();
  const catalog = liveCatalog(fixture);
  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(fixture.tools.implementer), skills: catalog, skillContext: registry });
  const packet = packetFor({ objective: "Fix add and run the verification commands" });
  const base = input(sessionId, "implementer", packet);
  const built = await builder.build(base, signal);
  assert.ok(built.ok);
  const skills = built.request.system.filter((block) => block.source === "skill").map((block) => block.id);
  assert.deepEqual(skills, ["skill:implementation", "skill:verification"], "the primary skill and the triggered one are injected");
  const catalogText = built.request.system.find((block) => block.source === "skill-catalog")?.text ?? "";
  assert.match(catalogText, /- implementation: \(in context below\)/);
  assert.match(catalogText, /- skill-creator: Use at task completion/);

  const load = createSkillLoadCallback({ skills: catalog, registry });
  const context = { runId: base.runId, taskId: base.taskId, attemptId: undefined, role: "implementer", toolCallId: createId("toolCall") } as unknown as ToolExecutionContext;
  const again = await load({ name: "implementation" }, context);
  assert.equal(again.status, "ok");
  assert.match(again.text, /already in your context/);
  assert.ok(again.text.length < 200, "no skill content is repeated");
  const triggered = await load({ name: "verification" }, context);
  assert.match(triggered.text, /already in your context/);
  const fresh = await load({ name: "skill-creator" }, context);
  assert.ok(fresh.status === "ok" && fresh.text.length > 200, "a catalog skill not yet in context is served in full");
  assert.match((await load({ name: "skill-creator" }, context)).text, /already loaded earlier/);
  const refused = await load({ name: "planning" }, context);
  assert.ok(refused.status === "error" && refused.error?.code === "invalid_arguments", "a skill outside the role catalog is refused");
  const standalone = await createSkillLoadCallback({ skills: catalog })({ name: "implementation" }, context);
  assert.match(standalone.text, /already in your context/, "without a registry the role's primary skill still counts as injected");

  // A duplicate answer in history does not count as a load, so the injected copy stays in context.
  const actor: Actor = { kind: "worker", role: "implementer" };
  const call = createId("toolCall");
  await append(store, "message/recorded", { role: "assistant", message: { role: "assistant", content: [{ type: "tool_call", provider_call_id: "p1", tool_call_id: call, name: "load_skill", arguments: { name: "implementation" } }] } }, actor, { runId: base.runId, taskId: packet.task_id });
  await append(store, "message/recorded", { role: "tool", message: { role: "tool", content: [{ type: "tool_result", provider_call_id: "p1", tool_call_id: call, is_error: false, text: `[#1] ${again.text}` }] } }, actor, { runId: base.runId, taskId: packet.task_id });
  const next = await builder.build({ ...base, requestId: createId("request") }, signal);
  assert.ok(next.ok && next.request.system.some((block) => block.id === "skill:implementation"));
});

test("AC-d5 an orchestrator turn after plan approval (triage) gets no skills and no load_skill", async () => {
  const fixture = await live();
  const { sessions, blobs, store, sessionId } = await newSession();
  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(fixture.tools.orchestrator), instructions: fixture.instructions, skills: liveCatalog(fixture) });
  const base = input(sessionId, "orchestrator", undefined);
  const planning = await builder.build(base, signal);
  assert.ok(planning.ok && planning.request.system.some((block) => block.id === "skill:planning"));
  await append(store, "plan/state_changed", { plan_id: createId("plan"), digest: sha256("plan"), from: "proposed", to: "approved", reason: "approved" }, { kind: "orchestrator", role: "orchestrator" }, { runId: base.runId });
  const triage = await builder.build({ ...base, requestId: createId("request") }, signal);
  assert.ok(triage.ok);
  assert.ok(!triage.request.system.some((block) => block.source === "skill" || block.source === "skill-catalog"));
  assert.ok(!triage.request.tools.some((tool) => tool.name === "load_skill"));
});

test("AC-d6 skill triggers fold Turkish dotted and dotless I safely", () => {
  const entries: SkillEntry[] = [
    { name: "implementation", description: "d", triggers: [] },
    { name: "ui-review", description: "d", triggers: ["İNCELE arayüzü"] },
  ];
  assert.equal(foldForMatch("İSTANBUL ıI"), "istanbul ii");
  assert.ok(!foldForMatch("İ").includes(String.fromCharCode(0x0307)));
  assert.deepEqual(triggeredSkills(entries, "IMPLEMENTATION adımı").map((entry) => entry.name), ["implementation"]);
  assert.deepEqual(triggeredSkills(entries, "implementatıon adımı").map((entry) => entry.name), ["implementation"]);
  assert.deepEqual(triggeredSkills(entries, "lütfen incele arayüzü").map((entry) => entry.name), ["ui-review"]);
  assert.deepEqual(triggeredSkills(entries, "nothing relevant").map((entry) => entry.name), []);
});

test("AC-d6 the packet view is compact and inlined sources arrive as an untrusted file block with their digest", async () => {
  const { sessions, blobs, sessionId } = await newSession();
  const content = "export function add(a, b) {\n  return a - b;\n}\n";
  const digest = digestText(content);
  const base = packetFor({ owned: ["src-add.mjs"], read: ["src-add.mjs", "check.mjs"], decisions: ["Keep the export.", "Keep the export."] });
  const packet = taskContextPacketSchema.parse({
    ...base,
    context: { ...base.context, sources: [{ path: "src-add.mjs", digest }], inline_sources: [{ path: "src-add.mjs", digest, content, truncated: false }] },
  });
  const view = renderPacketView(packet);
  for (const hidden of [packet.task_id, packet.run_id, packet.plan_id, packet.plan_digest, "expected_report", "created_at", "known_facts", "non_goals", "open_questions", digest]) {
    assert.ok(!view.includes(hidden), `the packet view leaves out ${hidden}`);
  }
  assert.match(view, /Objective: Fix add/);
  assert.match(view, /AC-1: works/);
  assert.match(view, /Verification commands:\n- node check\.mjs/);
  assert.equal(view.split("Keep the export.").length - 1, 1, "a decision is listed once");
  assert.ok(view.length < JSON.stringify(packet, null, 2).length / 2, "the view is at most half the size of the pretty JSON");

  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry() });
  const built = await builder.build(input(sessionId, "implementer", packet), signal);
  assert.ok(built.ok);
  const inline = built.request.system.find((block) => block.id === `packet-sources:${packet.task_id}`);
  assert.equal(inline?.trust, "untrusted", "repository file content never gains project trust");
  assert.match(inline?.text ?? "", new RegExp(`<source path="src-add.mjs" digest="${digest}">\\nexport function add`));
  assert.ok(!built.request.system.find((block) => block.source === "packet" && block.trust === "project")?.text.includes("return a - b"));
});

test("AC-d7 freshness uses ContextBuildInput.sources when given, the configured reader otherwise", async () => {
  const { sessions, blobs, sessionId } = await newSession();
  const content = "v1";
  const base = packetFor({ owned: ["src/**"], read: ["docs/spec.md"] });
  const packet = taskContextPacketSchema.parse({ ...base, context: { ...base.context, sources: [{ path: "docs/spec.md", digest: digestText(content) }] } });
  const mainTree = async () => digestText("main tree differs");
  const attemptTree = async () => digestText(content);
  const builder = createContextBuilder({ readSession: (id) => sessions.openForRead(id), blobs, tools: createStaticToolRegistry(), sources: mainTree });
  const stale = await builder.build(input(sessionId, "implementer", packet), signal);
  assert.ok(!stale.ok && stale.reason === "stale-sources");
  const fresh = await builder.build(input(sessionId, "implementer", packet, { sources: attemptTree }), signal);
  assert.equal(fresh.ok, true, "the attempt workspace reader decides freshness");
});

test("measurement: the live run 2 replay needs fewer, smaller requests and a small fixed prefix", async (t) => {
  const fixture = await live();
  const registry = createSkillContextRegistry();
  const catalog = liveCatalog(fixture);
  const load = createSkillLoadCallback({ skills: catalog, registry });
  const terminal = new Set(["task_report", "plan_propose", "task_triage", "review_report"]);

  const replay = async (session: LiveSession, role: AgentRole, packet: TaskContextPacket | undefined) => {
    const { sessions, blobs, store, sessionId } = await newSession();
    const builder = createContextBuilder({
      readSession: (id) => sessions.openForRead(id),
      blobs,
      tools: createStaticToolRegistry(fixture.tools[role === "orchestrator" ? "orchestrator" : "implementer"]),
      instructions: fixture.instructions,
      skills: catalog,
      skillContext: registry,
    });
    const runId = createId("run");
    const attemptId = role === "orchestrator" ? undefined : createId("attempt");
    const correlation = { runId, ...(packet === undefined ? {} : { taskId: packet.task_id }), ...(attemptId === undefined ? {} : { attemptId }) };
    const actor: Actor = role === "orchestrator" ? { kind: "orchestrator", role } : { kind: "worker", role, attempt_id: attemptId as AttemptId };
    const base = input(sessionId, role, packet, { runId, attemptId });
    const requests: ModelRequest[] = [];
    const pendingCalls = new Map<string, string>();
    let turnEnded = false;
    for (const original of session.messages) {
      let message = original;
      if (message.role === "user") {
        if (turnEnded && role === "orchestrator") {
          await append(store, "plan/state_changed", { plan_id: createId("plan"), digest: sha256("plan"), from: "proposed", to: "approved", reason: "approved" }, actor, correlation);
        }
        turnEnded = false;
      }
      if (message.role === "assistant") {
        if (turnEnded) continue; // F11: no request after a terminal tool succeeded.
        const built = await builder.build({ ...base, requestId: createId("request") }, signal);
        assert.ok(built.ok, "every replayed step builds");
        requests.push(built.request);
        for (const part of message.content) if (part.type === "tool_call") pendingCalls.set(part.provider_call_id, part.name);
      }
      if (message.role === "tool") {
        const content = [];
        for (const part of message.content) {
          if (part.type !== "tool_result") {
            content.push(part);
            continue;
          }
          const name = pendingCalls.get(part.provider_call_id);
          if (name !== undefined && terminal.has(name) && !part.is_error) turnEnded = true;
          if (name === "load_skill") {
            const call = session.messages.flatMap((entry) => entry.content).find((candidate) => candidate.type === "tool_call" && candidate.provider_call_id === part.provider_call_id);
            const skill = call?.type === "tool_call" ? String(call.arguments.name) : "";
            const result = await load({ name: skill }, { runId, taskId: packet?.task_id, attemptId, role, toolCallId: createId("toolCall") } as unknown as ToolExecutionContext);
            content.push({ ...part, text: result.text });
            continue;
          }
          content.push(part);
        }
        message = { role: "tool", content };
      }
      await append(store, "message/recorded", { role: message.role, message }, actor, correlation);
    }
    return requests;
  };

  const attemptPacket = (raw: unknown) => taskContextPacketSchema.parse(raw);
  const results = {
    orchestrator: await replay(fixture.sessions.orchestrator, "orchestrator", undefined),
    attempt1: await replay(fixture.sessions.attempt1, "implementer", attemptPacket(fixture.packets.attempt1)),
    attempt2: await replay(fixture.sessions.attempt2, "implementer", attemptPacket(fixture.packets.attempt2)),
  };
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  let before = 0;
  let after = 0;
  let beforeRequests = 0;
  let afterRequests = 0;
  for (const [name, requests] of Object.entries(results)) {
    const session = fixture.sessions[name as keyof typeof results];
    const measured = requests.map(requestTokens);
    before += sum(session.before.estimated_tokens);
    after += sum(measured.map((entry) => entry.total));
    beforeRequests += session.before.requests;
    afterRequests += requests.length;
    t.diagnostic(
      `${name}: requests ${session.before.requests} -> ${requests.length}; est. input ${sum(session.before.estimated_tokens)} -> ${sum(measured.map((entry) => entry.total))} tokens; ` +
        `fixed prefix (system+tools) ${session.before.fixed_prefix_tokens[0]} -> ${measured[0]?.prefix}; cacheable ${measured[0]?.stable}; provider-reported before ${sum(session.before.provider_input_tokens)}`,
    );
  }
  t.diagnostic(`total: requests ${beforeRequests} -> ${afterRequests}; est. input tokens ${before} -> ${after} (${Math.round((1 - after / before) * 100)}% less)`);

  assert.equal(results.orchestrator.length, fixture.sessions.orchestrator.before.requests - 2, "no request after plan_propose or task_triage");
  assert.equal(results.attempt1.length, fixture.sessions.attempt1.before.requests - 1, "no request after task_report");
  assert.equal(results.attempt2.length, fixture.sessions.attempt2.before.requests - 1);
  assert.ok(after <= before * 0.65, `the replay's estimated input drops by at least 35% (${before} -> ${after})`);

  // Fixed prefix of the implementer: the session-stable, cacheable part (system blocks before the
  // packet, plus tool schemas). Calibrated with the run's own provider counts (chars per token).
  const beforeChars = sum(Object.values(fixture.sessions).flatMap((session) => session.before.estimated_tokens)) * 4;
  const beforeProvider = sum(Object.values(fixture.sessions).flatMap((session) => session.before.provider_input_tokens));
  const charsPerToken = beforeChars / beforeProvider;
  const implementerFirst = results.attempt2[0];
  assert.ok(implementerFirst !== undefined);
  const stable = requestTokens(implementerFirst).stable;
  const calibrated = Math.round((stable * 4) / charsPerToken);
  t.diagnostic(`implementer cacheable prefix: ${stable} est. tokens (4 chars/token), ${calibrated} provider-calibrated (${charsPerToken.toFixed(2)} chars/token)`);
  assert.ok(stable <= 3_400, `implementer cacheable prefix (stable system + tools) is at most 3,400 est. tokens (was about 5,000; now ${stable})`);
  assert.ok(calibrated <= 2_900, `about 2.5-2.9k provider tokens (${calibrated})`);
  const system = implementerFirst.system.filter((block) => block.trust !== "untrusted").reduce((sum2, block) => sum2 + block.text.length, 0);
  const stableSystem = implementerFirst.system.slice(0, implementerFirst.cache?.stable_system_blocks ?? 0).reduce((sum2, block) => sum2 + block.text.length, 0);
  t.diagnostic(`implementer system prompt: ${system} characters (stable part ${stableSystem}); live run: 16,973`);
  assert.ok(system <= 11_200, `implementer system prompt is at most 11,200 characters (live run 16,973; now ${system})`);
  assert.ok(stableSystem <= 8_300, `its stable part is at most 8,300 characters (now ${stableSystem})`);
  for (const requests of Object.values(results)) {
    const keys = new Set(requests.map((request) => request.cache?.key));
    assert.equal(keys.size, 1, "one cache key per session and role");
  }
});
