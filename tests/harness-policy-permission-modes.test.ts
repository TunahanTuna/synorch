import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createId,
  digestOf,
  effectivePolicySchema,
  nextPermissionMode,
  normalizedActionSchema,
  type AgentRole,
  type NormalizedAction,
  type PermissionMode,
  type PolicyInputs,
  type SandboxReport,
} from "../src/harness/contracts/index.ts";
import { createPolicyEngine } from "../src/harness/policy/index.ts";
import { actionChoices, suggestedCommandPrefix } from "../src/harness/tui/index.ts";

/** ADR-08 owner revision (2026-09-24): ask / auto / full / plan for the conversation agent, hard rails in every mode. */

const PARTIAL: SandboxReport = { backend: "policy-only", platform: "win32", enforcement: "partial", filesystem: "partial", network: "unavailable", process: "partial", notes: [] };

function session(permissionMode: PermissionMode | undefined, overrides: Partial<PolicyInputs> = {}, trusted = false) {
  const engine = createPolicyEngine({ workspaceTrusted: () => trusted });
  const policy = engine.compute({
    mode: "autonomous",
    role: "session",
    runId: undefined,
    taskId: undefined,
    workspaceRoot: "/w",
    taskScope: undefined,
    userConfig: undefined,
    workspaceConfig: undefined,
    sandbox: PARTIAL,
    grants: [],
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...overrides,
  });
  return { engine, policy };
}

function action(fields: Partial<NormalizedAction> & Pick<NormalizedAction, "tool_name" | "effect">, role: AgentRole = "session"): NormalizedAction {
  return normalizedActionSchema.parse({ tool_version: "1.0.0", role, args_digest: digestOf(fields), paths: [], network_hosts: [], destructive: false, ...fields });
}
const exec = (argv: string[], role: AgentRole = "session") => action({ tool_name: "exec", effect: "exec", command: { argv, cwd: "." }, paths: [{ path: ".", access: "read" }] }, role);
const write = (target: string) => action({ tool_name: "write_file", effect: "workspace-write", paths: [{ path: target, access: "write" }] });

function decide(mode: PermissionMode | undefined, subject: NormalizedAction, trusted = false): string {
  const { engine, policy } = session(mode, {}, trusted);
  return engine.evaluate(subject, policy).decision;
}

test("auto acts autonomously (owner revision 3): any workspace command runs, outward writes ask; default-deny (headless) still refuses", () => {
  assert.equal(decide(undefined, exec(["python", "tools/gen.py"])), "deny");
  assert.equal(decide("auto", exec(["python", "tools/gen.py"])), "allow", "no allowlist prompts in auto");
  assert.equal(decide("auto", exec(["pnpm", "test"])), "allow", "repository code runs without a trust prompt");
  assert.equal(decide("auto", exec(["pnpm", "add", "zod"])), "allow", "installs run in auto");
  assert.equal(decide("auto", exec(["rm", "-rf", "dist"])), "allow", "deleting inside the workspace runs");
  assert.equal(decide("auto", exec(["git", "push", "origin", "main"])), "ask", "an external write asks");
  assert.equal(decide("auto", exec(["curl", "-X", "POST", "https://api.example.com/x"])), "ask", "an HTTP write asks");
  assert.equal(decide("auto", write("src/a.ts")), "allow", "edits run in auto");
});

test("auto: a plain git push asks once per session, then runs; force push still asks", () => {
  let approved = false;
  const engine = createPolicyEngine({ gitPushApproved: () => approved });
  const { policy } = session("auto");
  assert.equal(engine.evaluate(exec(["git", "push", "origin", "main"]), policy).decision, "ask");
  approved = true;
  assert.equal(engine.evaluate(exec(["git", "push", "origin", "main"]), policy).decision, "allow");
  assert.equal(engine.evaluate(exec(["git", "push", "--force", "origin", "main"]), policy).decision, "ask");
  assert.equal(engine.evaluate(exec(["npm", "publish"]), policy).decision, "ask");
});

test("auto: the web-content shield still asks before an outward action after a web read", () => {
  const engine = createPolicyEngine({ gitPushApproved: () => true, webContentRead: () => true });
  const { policy } = session("auto");
  assert.equal(engine.evaluate(exec(["git", "push", "origin", "main"]), policy).decision, "ask");
  assert.equal(engine.evaluate(exec(["pnpm", "test"]), policy).decision, "allow", "local commands are not shielded");
});

test("full allows everything in the workspace without prompts; ask asks for edits and commands; plan is read-only", () => {
  assert.equal(decide("full", exec(["python", "tools/gen.py"])), "allow");
  assert.equal(decide("full", exec(["git", "push", "origin", "main"])), "allow");
  assert.equal(decide("ask", write("src/a.ts")), "ask");
  assert.equal(decide("ask", exec(["python", "tools/gen.py"])), "ask");
  assert.equal(decide("plan", write("src/a.ts")), "deny");
  assert.equal(decide("plan", exec(["pnpm", "test"]), true), "deny");
});

test("hard rails and hard refusals deny in every mode", () => {
  for (const mode of ["ask", "auto", "full", "plan", undefined] as const) {
    assert.equal(decide(mode, write(".git/config")), "deny", `.git internals (${mode})`);
    assert.equal(decide(mode, exec(["git", "commit", "-m", "x"])), "deny", `git integration (${mode})`);
    assert.equal(decide(mode, exec(["node", "--require", "evil.js", "x.js"])), "deny", `module injection (${mode})`);
    const escape = action({ tool_name: "write_file", effect: "workspace-write", paths: [], escapes: [{ requested: "../outside.txt", access: "write", reason: "outside-workspace" }] });
    assert.equal(decide(mode, escape), "deny", `write escape (${mode})`);
  }
});

test("destructive commands ask in every interactive mode (full included), deny headless and in plan (owner decision 2026-09-24)", () => {
  for (const mode of ["ask", "auto", "full"] as const) {
    assert.equal(decide(mode, exec(["rm", "-rf", "/"])), "ask", `destructive outside (${mode})`);
    assert.equal(decide(mode, exec(["git", "push", "--force", "origin", "main"])), "ask", `force push (${mode})`);
    assert.equal(decide(mode, exec(["npm", "publish"])), "ask", `publish (${mode})`);
  }
  for (const mode of ["plan", undefined] as const) {
    assert.equal(decide(mode, exec(["git", "push", "--force", "origin", "main"])), "deny", `force push (${mode})`);
    assert.equal(decide(mode, exec(["rm", "-rf", "/"])), "deny", `destructive outside (${mode})`);
  }
  const { engine, policy } = session("full");
  const prompt = engine.evaluate(exec(["git", "push", "--force"]), policy);
  assert.equal(prompt.rail, undefined, "a prompt carries no rail");
  assert.ok(prompt.reasons.some((reason) => reason.code === "destructive-prompt"));
  assert.ok(prompt.reasons.some((reason) => reason.code === "git-force-push"), "the card says why");
  assert.equal(decide("full", exec(["git", "push", "origin", "main"])), "allow", "plain push stays allowed in full");
  assert.equal(decide("auto", exec(["git", "push", "origin", "main"])), "ask", "plain push asks in auto");
});

test("workers follow the session's auto mode (revision 3 applies to workers): scaffolding and installs run, outward writes ask, read-only roles stay read-only", () => {
  const engine = createPolicyEngine({ permissionMode: () => "auto" });
  const worker = (role: AgentRole) =>
    engine.compute({ mode: "autonomous", role, runId: createId("run"), taskId: createId("task"), workspaceRoot: "/w", taskScope: { owned: role === "reviewer" ? [] : ["**/*"], read: [], forbidden: [] }, userConfig: undefined, workspaceConfig: undefined, sandbox: PARTIAL, grants: [] });
  const implementer = worker("implementer");
  assert.equal(implementer.permission_mode, "auto");
  assert.equal(implementer.exec_confinement, "allowlist", "confinement stays informational");
  for (const argv of [["npm", "create", "vite@latest", ".", "--", "--template", "react"], ["npm", "install"], ["npx", "tsc", "--noEmit"], ["python", "gen.py"]]) {
    assert.equal(engine.evaluate(exec(argv, "implementer"), implementer).decision, "allow", argv.join(" "));
  }
  assert.equal(engine.evaluate(exec(["git", "push", "origin", "main"], "implementer"), implementer).decision, "ask", "a remote push asks the user");
  assert.equal(engine.evaluate(exec(["curl", "-X", "POST", "https://api.example.com/x"], "implementer"), implementer).decision, "ask", "an outward write asks");
  assert.equal(engine.evaluate(exec(["npm", "publish"], "implementer"), implementer).decision, "ask", "publishing asks");
  assert.equal(worker("reviewer").permission_mode, undefined);
  assert.equal(engine.evaluate(exec(["npm", "install"], "reviewer"), worker("reviewer")).decision, "deny", "read-only roles never inherit");
  const ask = createPolicyEngine({ permissionMode: () => "ask" });
  assert.equal(ask.compute({ mode: "autonomous", role: "implementer", runId: createId("run"), taskId: createId("task"), workspaceRoot: "/w", taskScope: { owned: ["src/**"], read: [], forbidden: [] }, userConfig: undefined, workspaceConfig: undefined, sandbox: PARTIAL, grants: [] }).permission_mode, undefined);
});

test("a repository layer that asks narrows auto and full to ask; workers inherit auto and full; read-only roles never", () => {
  const narrowed = session("full", { workspaceConfig: { policy: { mode: "ask" } } }).policy;
  assert.equal(narrowed.permission_mode, "ask");
  assert.equal(narrowed.mode, "ask");

  const engine = createPolicyEngine({ permissionMode: () => "full" });
  const worker = (role: AgentRole) =>
    engine.compute({ mode: "autonomous", role, runId: createId("run"), taskId: createId("task"), workspaceRoot: "/w", taskScope: { owned: role === "reviewer" ? [] : ["src/**"], read: [], forbidden: [] }, userConfig: undefined, workspaceConfig: undefined, sandbox: PARTIAL, grants: [] });
  assert.equal(worker("implementer").permission_mode, "full");
  assert.equal(engine.evaluate(exec(["python", "gen.py"], "implementer"), worker("implementer")).decision, "allow");
  assert.equal(worker("reviewer").permission_mode, undefined);
  assert.equal(engine.evaluate(exec(["python", "gen.py"], "reviewer"), worker("reviewer")).decision, "deny");
  assert.equal(createPolicyEngine({ permissionMode: () => "auto" }).compute({ mode: "autonomous", role: "implementer", runId: createId("run"), taskId: createId("task"), workspaceRoot: "/w", taskScope: { owned: ["src/**"], read: [], forbidden: [] }, userConfig: undefined, workspaceConfig: undefined, sandbox: PARTIAL, grants: [] }).permission_mode, "auto");
});

test("the schema keeps modes honest: plan is read-only, workers carry only auto or full, the mode matches", () => {
  const { policy } = session("auto");
  assert.throws(() => effectivePolicySchema.parse({ ...policy, permission_mode: "plan" }), /plan mode is read-only/);
  assert.throws(() => effectivePolicySchema.parse({ ...policy, permission_mode: "ask" }), /computes in ask mode/);
  assert.equal(nextPermissionMode("ask"), "auto");
  assert.equal(nextPermissionMode("plan"), "ask");
});

test("the action prompt offers Always allow <prefix> for commands, never for git or a bare shell", () => {
  assert.equal(suggestedCommandPrefix(["npm", "run", "lint", "--fix"]), "npm run lint");
  assert.equal(suggestedCommandPrefix(["python", "tools/gen.py", "a", "b"]), "python tools/gen.py a");
  assert.equal(suggestedCommandPrefix(["git", "push"]), undefined);
  assert.equal(suggestedCommandPrefix(["bash"]), undefined);
  const request = {
    approval_id: createId("approval"),
    subject_kind: "action" as const,
    subject_digest: digestOf("x"),
    summary: "exec",
    effect: "exec" as const,
    scope: "once" as const,
    command: ["cargo", "clippy"],
    requested_at: new Date().toISOString(),
  };
  assert.deepEqual(actionChoices(request).map((choice) => `${choice.key} ${choice.label}`), ["1 Allow once", "2 Always allow `cargo clippy` in this folder", "3 Deny", "4 Deny and tell Synorch why"]);
});
