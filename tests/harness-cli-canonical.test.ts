import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createId, sha256, type EffectivePolicy, type PolicyInputs } from "../src/harness/contracts/index.ts";
import { loadCanonicalStructure, narrowPolicy, runHarnessCommand, withRoleDefinitions } from "../src/harness/cli/index.ts";
import { createPolicyEngine } from "../src/harness/policy/index.ts";
import { createScriptedAdapter } from "../src/harness/providers/index.ts";
import { createStructureFiles } from "../src/templates/structure-templates.ts";
import { call, capture, createSandbox, overridesFor, planArguments, taskReport, TEST_SANDBOX, text, writeConfig } from "./fixtures/cli/runtime/support.ts";

/**
 * Gap closure: the target repository's canonical `.ai/` structure drives the runtime. Constitution
 * and core protocols become trusted-order instruction blocks, agent manifests become role
 * definitions that only narrow policy, skills become a role-scoped catalog whose bodies load on
 * trigger, and model profiles become router hints. Without `.ai/` the built-in defaults apply.
 */

async function writeCanonical(root: string, edits: Readonly<Record<string, (text: string) => string>> = {}): Promise<void> {
  for (const file of createStructureFiles("repository")) {
    if (!file.relativePath.startsWith(".ai/")) continue;
    const target = path.join(root, ...file.relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const edit = edits[file.relativePath];
    await writeFile(target, edit === undefined ? file.content : edit(file.content));
  }
}

function inputs(role: PolicyInputs["role"], owned: readonly string[]): PolicyInputs {
  return {
    mode: "autonomous",
    role,
    runId: createId("run"),
    taskId: createId("task"),
    workspaceRoot: process.cwd(),
    taskScope: { owned, read: ["**"], forbidden: [] },
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: TEST_SANDBOX,
    grants: [],
  };
}

test("without .ai/ the runtime uses the built-in canonical defaults in trust and priority order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-canonical-"));
  try {
    const canonical = await loadCanonicalStructure(root);
    assert.equal(canonical.origin, "builtin");
    assert.match(canonical.instructions.constitution ?? "", /^# AI Development Constitution/);
    assert.equal(canonical.protocolIds[0], "core.orchestration", "the constitutional protocol comes first");
    assert.equal(canonical.protocolIds.length, 8);
    assert.deepEqual([...canonical.roles.keys()], ["orchestrator", "explorer", "implementer", "debugger", "reviewer"]);
    assert.ok([...canonical.roles.values()].every((role) => role.origin === "builtin" && role.source.startsWith("builtin:.ai/agents/")));
    assert.equal(canonical.roles.get("reviewer")?.modelTier, "complex_worker");
    assert.match(canonical.instructions.roles?.orchestrator ?? "", /- implementer: model tier any, may write its owned paths/);
    assert.equal(canonical.skillEntries.length, 9);
    assert.deepEqual(canonical.profiles.find((hint) => hint.profile === "claude" && hint.tier === "orchestrator")?.provider, "anthropic");

    const orchestratorSkills = (await canonical.skills.list("orchestrator")).map((entry) => entry.name);
    assert.ok(orchestratorSkills.includes("planning") && !orchestratorSkills.includes("implementation"), "the catalog follows allowed/forbidden skills");
    assert.equal(await canonical.skills.load("implementation", "orchestrator"), undefined, "a forbidden skill body is never loaded");
    assert.match((await canonical.skills.load("implementation", "implementer")) ?? "", /^Skill implementation \(builtin:\.ai\/skills\/implementation\/SKILL\.md\):/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository manifests narrow the effective policy and can never widen it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-canonical-"));
  try {
    await writeCanonical(root, {
      ".ai/constitution.md": () => "# House constitution\n\nShip small, verified changes.\n",
      ".ai/agents/implementer/AGENT.md": (text) => text.replace("writes_product_files: true", "writes_product_files: false"),
      ".ai/agents/reviewer/AGENT.md": (text) => text.replace("writes_product_files: false", "writes_product_files: true"),
      ".ai/agents/orchestrator/AGENT.md": (text) => text.replace("control_plane_write_scope: .ai/tasks/**", "control_plane_write_scope: .ai/tasks/reports/**"),
      ".ai/agents/explorer/AGENT.md": (text) => text.replace("model_tier: fast_worker", "model_tier: galaxy_brain"),
    });
    const canonical = await loadCanonicalStructure(root);
    assert.equal(canonical.origin, "repository");
    assert.equal(canonical.instructions.constitution, "# House constitution\n\nShip small, verified changes.");
    assert.ok(canonical.diagnostics.some((line) => /reviewer never writes product files in the harness; ignored \(manifests cannot widen policy\)/.test(line)));
    assert.ok(canonical.diagnostics.some((line) => /\.ai\/agents\/explorer\/AGENT\.md is not a valid agent manifest .*the built-in explorer manifest is used/.test(line)));
    assert.equal(canonical.roles.get("explorer")?.origin, "builtin");
    assert.equal(canonical.roles.get("debugger")?.origin, "repository");
    assert.equal(canonical.roles.get("reviewer")?.writesProductFiles, false);

    const engine = withRoleDefinitions(createPolicyEngine(), canonical.roles);
    const implementer = engine.compute(inputs("implementer", ["src/**"]));
    assert.deepEqual(implementer.write_scope, [], "writes_product_files: false removes the write scope");
    assert.equal(implementer.effects["workspace-write"], "deny");
    assert.equal(implementer.effects.exec, "allow", "narrowing touches only what the manifest restricts");
    assert.deepEqual(implementer.layers.at(-1), { layer: "role", source: ".ai/agents/implementer/AGENT.md", digest: canonical.roles.get("implementer")?.digest });

    const orchestrator = engine.compute({ ...inputs("orchestrator", [".ai/tasks/**"]), taskId: undefined });
    assert.deepEqual(orchestrator.write_scope, [".ai/tasks/reports/**"]);
    const reviewer = engine.compute(inputs("reviewer", []));
    assert.deepEqual(reviewer.write_scope, []);
    assert.equal(reviewer.effects["workspace-write"], "deny");

    const debuggerPolicy = engine.compute(inputs("debugger", [".ai/agents/**", "src/**"]));
    const edit = engine.evaluate(
      {
        tool_name: "write_file",
        tool_version: "1",
        effect: "workspace-write",
        role: "debugger",
        args_digest: sha256("x"),
        paths: [{ path: ".ai/agents/debugger/AGENT.md", access: "write" }],
        network_hosts: [],
        destructive: false,
      },
      debuggerPolicy,
    );
    assert.equal(edit.decision, "deny");
    assert.equal(edit.rail, "policy-self-modification", "the role manifest in force is a policy source no tool may rewrite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrowPolicy refuses a definition for another role and never adds permissions", async () => {
  const canonical = await loadCanonicalStructure(await mkdtemp(path.join(os.tmpdir(), "syn-canonical-")));
  const base = createPolicyEngine().compute(inputs("explorer", []));
  const implementerDefinition = canonical.roles.get("implementer");
  assert.equal(narrowPolicy(base, implementerDefinition), base, "a definition for another role is ignored");
  const narrowed: EffectivePolicy = narrowPolicy(base, canonical.roles.get("explorer"));
  assert.deepEqual(narrowed.effects, base.effects);
  assert.deepEqual(narrowed.write_scope, []);
});

test("a run feeds the repository constitution, protocols, role manifest and skill catalog to the model", async () => {
  const sandbox = await createSandbox({ "README.md": "# Canon\n\nteh\n", "src/app.ts": "export const x = 1;\n" });
  try {
    await writeCanonical(sandbox.workspace, {
      ".ai/constitution.md": () => "# House constitution\n\nRule CANON-7: every change cites its evidence.\n",
      ".ai/agents/implementer/AGENT.md": (text) => text.replace("writes_product_files: true", "writes_product_files: false"),
    });
    await writeConfig(sandbox.home, [
      { tier: "orchestrator", adapter: "plan-script", model: "planner" },
      { tier: "complex_worker", adapter: "worker-script", model: "worker" },
      { tier: "fast_worker", adapter: "worker-script", model: "worker" },
    ]);
    const orchestrator = createScriptedAdapter(
      [call("plan_propose", () => planArguments("Fix README", [{ key: "fix", risk: "trivial", owned: ["README.md"], read: ["README.md"], tier: "fast_worker" }])), text("planned")],
      { adapterId: "plan-script" },
    );
    const worker = createScriptedAdapter(
      [call("write_file", () => ({ path: "README.md", content: "# Canon\n\nthe\n", expected_digest: sha256("# Canon\n\nteh\n") })), taskReport((ids) => [{ criterion: "AC-1", ref: ids.at(-1) ?? "" }]), text("done")],
      { adapterId: "worker-script" },
    );
    const run = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "Fix README", "--plain"], run.io, overridesFor(sandbox, { adapters: [orchestrator, worker], limits: { maxRetries: 0 } }));
    assert.match(run.stdout(), /\[tool\] write_file denied: README\.md is outside the write scope/);
    assert.match(run.stdout(), /notice: canonical \.ai: .*\.ai \(constitution loaded, 8 core protocol\(s\), 5 role manifest\(s\), 9 skill\(s\) in the catalog\)/);

    const planning = orchestrator.requests[0];
    assert.ok(planning !== undefined);
    const ids = planning.system.map((block) => `${block.source}:${block.trust}`);
    assert.equal(ids[0], "harness:harness", "harness instructions stay first and alone at harness trust");
    assert.equal(planning.system[1]?.id, "constitution");
    assert.equal(planning.system[1]?.trust, "project");
    assert.match(planning.system[1]?.text ?? "", /Rule CANON-7/);
    const protocols = planning.system.filter((block) => block.source === "protocol").map((block) => block.id);
    assert.deepEqual(protocols.slice(0, 2), ["protocol:core.orchestration", "protocol:core.planning-and-approval"]);
    assert.ok(planning.system.some((block) => block.id === "role:orchestrator" && /# Orchestrator/.test(block.text)));
    const catalog = planning.system.find((block) => block.id === "skill-catalog");
    assert.match(catalog?.text ?? "", /- planning: /);
    assert.doesNotMatch(catalog?.text ?? "", /- implementation: /, "the orchestrator's catalog honours its manifest's forbidden skills");

    const implementerTools = worker.requests[0]?.tools.map((tool) => tool.name) ?? [];
    assert.ok(!implementerTools.includes("write_file") && !implementerTools.includes("apply_patch"), "the repository manifest removed the implementer's write tools");
    assert.ok(worker.requests[0]?.system.some((block) => block.id === "role:implementer"));
    assert.equal(code, 5, `the denied write leaves the task unverified\n${run.stdout()}`);
  } finally {
    await sandbox.cleanup();
  }
});

test("a missing orchestrator route suggests the canonical model profile", async () => {
  const sandbox = await createSandbox({ "README.md": "# p\n" });
  try {
    const io = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["run", "anything", "--plain"], io.io, overridesFor(sandbox));
    assert.equal(code, 2);
    assert.match(io.stderr(), /the canonical model profiles suggest openai\/gpt-6-astra or anthropic\/fable-5/);
  } finally {
    await sandbox.cleanup();
  }
});
