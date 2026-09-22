import assert from "node:assert/strict";
import { test } from "node:test";
import { createId, digestOf, normalizedActionSchema, type NormalizedAction, type SandboxReport } from "../src/harness/contracts/index.ts";
import { classifyCommand, createPolicyEngine, DESTRUCTIVE_COMMAND_RULES, EXTERNAL_WRITE_RULES } from "../src/harness/policy/index.ts";

/** AC-3: every example in the destructive-command table is a hard-rail denial in every mode and shell form. */

const engine = createPolicyEngine();
const FULL: SandboxReport = { backend: "bubblewrap", platform: "linux", enforcement: "full", filesystem: "full", network: "full", process: "full", notes: [] };
const SCOPE = { cwd: ".", writeScope: ["src/auth/**"], forbidden: ["src/billing/**"] };
const SHELLS = new Set(["bash", "sh", "cmd", "powershell", "pwsh"]);

function policy(mode: "autonomous" | "ask") {
  return engine.compute({
    mode,
    role: "implementer",
    runId: createId("run"),
    taskId: createId("task"),
    workspaceRoot: "/w",
    taskScope: { owned: ["src/auth/**"], read: [], forbidden: ["src/billing/**"] },
    userConfig: { policy: { external_write_allowlist: ["git push *", "npm publish", "docker push *"] } },
    workspaceConfig: undefined,
    sandbox: FULL,
    grants: [],
  });
}

function exec(argv: readonly string[]): NormalizedAction {
  return normalizedActionSchema.parse({
    tool_name: "exec",
    tool_version: "1.0.0",
    effect: "exec",
    role: "implementer",
    args_digest: digestOf({ argv }),
    paths: [{ path: ".", access: "read" }],
    command: { argv, cwd: "." },
    network_hosts: [],
    destructive: false,
  });
}

function posixQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

function wrappedForms(argv: readonly [string, ...string[]]): (readonly string[])[] {
  if (SHELLS.has(argv[0].toLowerCase())) return [];
  const posix = argv.map(posixQuote).join(" ");
  const plain = argv.join(" ");
  const encoded = Buffer.from(plain, "utf16le").toString("base64");
  return [
    ["bash", "-c", posix],
    ["sh", "-lc", `cd /tmp && ${posix}`],
    ["cmd.exe", "/d", "/s", "/c", plain],
    ["powershell", "-NoProfile", "-Command", plain],
    ["pwsh", "-EncodedCommand", encoded],
    ["env", "FOO=1", ...argv],
    ["timeout", "30", ...argv],
    ["C:\\Windows\\System32\\cmd.exe", "/c", `echo start && ${plain}`],
  ];
}

for (const mode of ["autonomous", "ask"] as const) {
  test(`AC-3: every destructive table example is denied with destructive-command in ${mode} mode`, () => {
    const effective = policy(mode);
    let checked = 0;
    for (const rule of DESTRUCTIVE_COMMAND_RULES) {
      assert.ok(rule.examples.length > 0, `${rule.code} has examples`);
      for (const example of rule.examples) {
        const decision = engine.evaluate(exec(example), effective);
        assert.equal(decision.decision, "deny", `${rule.code}: ${example.join(" ")}`);
        assert.equal(decision.rail, "destructive-command", `${rule.code}: ${example.join(" ")}`);
        assert.ok(decision.reasons.some((reason) => reason.code === rule.code), `${rule.code} named for ${example.join(" ")}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 60, `table covers ${checked} examples`);
  });

  test(`AC-3: bash, cmd, PowerShell, encoded and prefix-wrapped forms of every example are denied in ${mode} mode`, () => {
    const effective = policy(mode);
    for (const rule of DESTRUCTIVE_COMMAND_RULES) {
      for (const example of rule.examples) {
        for (const wrapped of wrappedForms(example)) {
          const decision = engine.evaluate(exec(wrapped), effective);
          assert.equal(decision.rail, "destructive-command", `${rule.code}: ${JSON.stringify(wrapped)}`);
        }
      }
    }
  });
}

test("AC-3: program names are matched case-insensitively and by basename with executable suffixes", () => {
  for (const argv of [
    ["RM", "-RF", "/"],
    ["/bin/rm", "-rf", "/"],
    ["C:\\Program Files\\Git\\usr\\bin\\rm.exe", "-rf", "C:\\"],
    ["GIT.EXE", "push", "--force"],
    ["remove-item", "-recurse", "C:\\"],
  ]) {
    assert.equal(classifyCommand(argv, SCOPE).destructive, true, argv.join(" "));
  }
});

test("AC-3: recursive deletes inside the owned paths are not destructive; the same command elsewhere is", () => {
  for (const argv of [
    ["rm", "-rf", "src/auth/tmp"],
    ["rm", "-r", "src/auth/cache", "src/auth/dist"],
    ["Remove-Item", "-Recurse", "-Force", "src/auth/tmp"],
    ["rd", "/s", "/q", "src\\auth\\tmp"],
    ["rimraf", "src/auth/build"],
    ["find", "src/auth", "-name", "*.tmp", "-delete"],
    ["chmod", "-R", "u+w", "src/auth"],
  ]) {
    assert.equal(classifyCommand(argv, SCOPE).destructive, false, argv.join(" "));
  }
  for (const argv of [
    ["rm", "-rf", "src/auth/../billing"],
    ["rm", "-rf", "src/auth", "src/billing"],
    ["rm", "-rf", "src/auth/.git"],
    ["rm", "-rf", "src/*"],
    ["rm", "-rf", "$HOME"],
    ["rm", "-rf", "%USERPROFILE%"],
    ["bash", "-c", "find . | xargs rm -rf"],
  ]) {
    assert.equal(classifyCommand(argv, SCOPE).destructive, true, argv.join(" "));
  }
});

test("AC-3: ordinary commands are not destructive (negative table)", () => {
  for (const argv of [
    ["rm", "notes.txt"],
    ["rm", "-f", "notes.txt"],
    ["Remove-Item", "-Force", "notes.txt"],
    ["del", "notes.txt"],
    ["git", "status"],
    ["git", "diff", "--", "."],
    ["git", "reset", "--soft", "HEAD~1"],
    ["git", "clean", "-n", "-d"],
    ["git", "checkout", "-b", "feature"],
    ["git", "restore", "--staged", "."],
    ["git", "branch", "-d", "merged"],
    ["git", "push", "origin", "main"],
    ["npm", "install"],
    ["pnpm", "test"],
    ["node", "--test"],
    ["docker", "ps"],
    ["systemctl", "status", "nginx"],
    ["curl", "-fsSL", "https://example.com/data.json", "-o", "src/auth/data.json"],
    ["bash", "-c", "ls -la && echo done"],
    ["powershell", "-Command", "Get-ChildItem -Recurse src"],
  ]) {
    const classification = classifyCommand(argv, SCOPE);
    assert.equal(classification.destructive, false, `${argv.join(" ")}: ${JSON.stringify(classification.findings)}`);
  }
});

test("AC-3: normal git push and other publishing commands are external-write, not exec", () => {
  for (const rule of EXTERNAL_WRITE_RULES) {
    for (const example of rule.examples) {
      assert.equal(classifyCommand(example, SCOPE).effect, "external-write", example.join(" "));
    }
  }
  assert.equal(classifyCommand(["bash", "-c", "git push origin main"], SCOPE).effect, "external-write");
  assert.equal(classifyCommand(["git", "status"], SCOPE).effect, "exec");
});

test("AC-3: an allowlisted external write stays denied when it is also destructive", () => {
  const effective = policy("autonomous");
  assert.equal(engine.evaluate(exec(["git", "push", "origin", "main"]), effective).decision, "allow");
  const forced = engine.evaluate(exec(["git", "push", "--force", "origin", "main"]), effective);
  assert.equal(forced.decision, "deny");
  assert.equal(forced.rail, "destructive-command");
  assert.equal(engine.evaluate(exec(["npm", "publish"]), effective).rail, "destructive-command");
});

test("AC-3: commands hidden in git config aliases/hooks and find -exec are classified too", () => {
  for (const argv of [
    ["git", "-c", "alias.st=!rm -rf /", "st"],
    ["git", "-c", "core.sshCommand=rm -rf ~", "fetch"],
    ["git", "-c", "core.pager=powershell -c Remove-Item -Recurse C:\\", "log"],
    ["find", ".", "-exec", "sh", "-c", "rm -rf /", ";"],
    ["find", "src/auth", "-execdir", "rm", "-rf", "../../..", "+"],
  ]) {
    assert.equal(classifyCommand(argv, SCOPE).destructive, true, argv.join(" "));
  }
  assert.equal(classifyCommand(["find", "src/auth", "-name", "*.tmp", "-exec", "rm", "-rf", "{}", "+"], SCOPE).destructive, false);
  assert.equal(classifyCommand(["git", "-c", "color.ui=always", "log"], SCOPE).destructive, false);
});

test("AC-3: unclassifiable nesting fails closed", () => {
  let script = "rm -rf /";
  for (let depth = 0; depth < 8; depth += 1) script = `bash -c ${posixQuote(script)}`;
  assert.equal(classifyCommand(["bash", "-c", script], SCOPE).destructive, true);
});
