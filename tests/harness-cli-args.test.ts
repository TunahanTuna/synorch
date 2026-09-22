import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createId, jsonlFrameSchema, splitJsonlLines, validateFrameSequence } from "../src/harness/contracts/index.ts";
import {
  commandHelp,
  HARNESS_COMMANDS,
  isHarnessInvocation,
  parseHarnessArgs,
  requestsJsonl,
  resolveTerminalSettings,
  runHarnessCommand,
  terminalSettingsFor,
  UsageError,
  type HarnessProcessIO,
  type TerminalFacts,
} from "../src/harness/cli/index.ts";

/**
 * I5 stage A: runtime command parsing, help and exit codes are final; renderer and colour selection
 * follows the contract (AC-2); `src/cli.ts` reaches the runtime only for runtime commands.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SES = createId("session");
const RUN = createId("run");

function usage(argv: readonly string[]): string {
  try {
    parseHarnessArgs(argv);
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected a usage error for ${argv.join(" ")}`);
    return error.message;
  }
  assert.fail(`expected a usage error for ${argv.join(" ")}`);
}

function capture(stdoutIsTTY = false, env: Record<string, string | undefined> = {}): { io: HarnessProcessIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env,
      cwd: "/work",
      stdinIsTTY: stdoutIsTTY,
      stdout: { isTTY: stdoutIsTTY, hasColors: () => true, write: (chunk) => (out.push(chunk), true) },
      stderr: { isTTY: false, write: (chunk) => (err.push(chunk), true) },
    },
  };
}

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("every contract command and flag parses into a typed invocation", () => {
  assert.deepEqual(parseHarnessArgs(["agent"]), {
    kind: "agent",
    common: { target: undefined, plain: false, color: "auto" },
    session: { policy: "autonomous", profiles: [] },
    resume: undefined,
    fork: undefined,
  });
  const agent = parseHarnessArgs(["agent", "--fork", `${SES}@12`, "--policy", "ask", "--profile", "complex_worker=openai/gpt-5.5", "--profile", "fast_worker=anthropic/haiku", "-t", "repo", "--plain", "--color", "never"]);
  assert.ok(agent.kind === "agent");
  assert.deepEqual(agent.fork, { sessionId: SES, upToSeq: 12 });
  assert.equal(agent.session.policy, "ask");
  assert.deepEqual(agent.session.profiles.map((profile) => profile.tier), ["complex_worker", "fast_worker"]);
  assert.deepEqual(agent.common, { target: "repo", plain: true, color: "never" });
  assert.equal(parseHarnessArgs(["agent", "--resume", SES]).kind, "agent");

  const run = parseHarnessArgs(["run", "fix the failing test", "--mode", "jsonl", "--stream-deltas"]);
  assert.ok(run.kind === "run");
  assert.equal(run.goal, "fix the failing test");
  assert.equal(run.jsonl, true);
  assert.equal(run.streamDeltas, true);
  const alias = parseHarnessArgs(["run", "--json", "x"]);
  assert.ok(alias.kind === "run" && alias.jsonl);
  const stdin = parseHarnessArgs(["run", "-"]);
  assert.ok(stdin.kind === "run" && stdin.goalFromStdin);

  assert.deepEqual(parseHarnessArgs(["runs", "--json"]), { kind: "runs", common: { target: undefined, plain: false, color: "auto" }, json: true });
  const show = parseHarnessArgs(["show", RUN, "--json"]);
  assert.ok(show.kind === "show" && show.id === RUN && show.json);
  assert.equal(parseHarnessArgs(["show", SES]).kind, "show");
  const doctor = parseHarnessArgs(["doctor", "--runtime", "--probe-model", "--json"]);
  assert.ok(doctor.kind === "doctor-runtime" && doctor.probeModel && doctor.json);

  const login = parseHarnessArgs(["login", "openai", "--method", "oauth-subscription", "--profile", "work", "--device-code"]);
  assert.ok(login.kind === "login");
  assert.equal(login.provider, "openai");
  assert.equal(login.method, "oauth-subscription");
  assert.equal(login.profile, "work");
  assert.deepEqual(login.args, ["openai", "--method", "oauth-subscription", "--profile", "work", "--device-code"]);
  const logout = parseHarnessArgs(["logout", "anthropic", "--profile", "personal"]);
  assert.ok(logout.kind === "logout" && logout.profile === "personal");
  assert.deepEqual(parseHarnessArgs(["auth", "status", "--json"]), { kind: "auth-status", common: { target: undefined, plain: false, color: "auto" }, json: true, args: ["status", "--json"] });
  assert.deepEqual(parseHarnessArgs(["memory", "search", "retry policy", "--limit", "5"]), { kind: "memory", subcommand: "search", args: ["search", "retry policy", "--limit", "5"] });
  for (const command of ["agent", "run", "runs", "show", "login", "logout", "auth", "memory"]) {
    assert.deepEqual(parseHarnessArgs([command, "--help"]), { kind: "help", command });
  }
  assert.deepEqual(parseHarnessArgs(["doctor", "--runtime", "-h"]), { kind: "help", command: "doctor" });
});

test("invalid invocations are usage errors with actionable messages", () => {
  assert.match(usage(["agent", "--resume", SES, "--fork", SES]), /cannot be combined/);
  assert.match(usage(["agent", "--resume", "abc"]), /ses_<ULID>/);
  assert.match(usage(["agent", "--fork", `${SES}@0`]), /positive seq/);
  assert.match(usage(["agent", "stray"]), /Unexpected positional/);
  assert.match(usage(["agent", "--policy", "yolo"]), /Invalid --policy: yolo/);
  assert.match(usage(["agent", "--profile", "boss=x"]), /Invalid --profile/);
  assert.match(usage(["agent", "--profile", "fast_worker=a", "--profile", "fast_worker=b"]), /more than once/);
  assert.match(usage(["agent", "--color", "sometimes"]), /Invalid --color/);
  assert.match(usage(["agent", "--bogus"]), /Unknown option '--bogus'$/);
  assert.match(usage(["run"]), /requires a goal/);
  assert.match(usage(["run", "a", "b"]), /quote the goal/);
  assert.match(usage(["run", "  "]), /must not be empty/);
  assert.match(usage(["run", "x", "--mode", "rpc"]), /only machine mode is jsonl/);
  assert.match(usage(["run", "x", "--stream-deltas"]), /requires --mode jsonl/);
  assert.match(usage(["run", "x", "--json", "--plain"]), /cannot be combined/);
  assert.match(usage(["runs", "extra"]), /Unexpected positional/);
  assert.match(usage(["show"]), /exactly one/);
  assert.match(usage(["show", "task_01K5T3Q8Z4X9V2M6N7P0R1S2T6"]), /run_<ULID> or ses_<ULID>/);
  assert.match(usage(["doctor", "--json"]), /requires --runtime/);
  assert.match(usage(["login"]), /requires a provider/);
  assert.match(usage(["login", "Open AI"]), /kebab-case/);
  assert.match(usage(["login", "openai", "--method", "password"]), /Invalid --method/);
  assert.match(usage(["login", "openai", "--profile", "My Profile"]), /kebab-case/);
  assert.match(usage(["auth"]), /requires a sub-command: status/);
  assert.match(usage(["auth", "list"]), /Expected status/);
  assert.match(usage(["memory", "delete"]), /Unknown memory sub-command/);
});

test("routing matches cli.ts: runtime command names and doctor --runtime only", async () => {
  for (const command of HARNESS_COMMANDS) assert.equal(isHarnessInvocation([command]), true);
  assert.equal(isHarnessInvocation(["doctor", "--runtime"]), true);
  assert.equal(isHarnessInvocation(["doctor", "--json", "--runtime"]), true);
  for (const legacy of [["doctor"], ["doctor", "--json"], ["doctor", "--", "--runtime"], ["inspect"], ["init"], ["sync"], ["--help"], [], ["bogus"], ["--target", "x", "run"]]) {
    assert.equal(isHarnessInvocation(legacy), false, legacy.join(" "));
  }
  const source = await readFile(CLI, "utf8");
  const list = /HARNESS_COMMAND_NAMES: readonly string\[\] = \[([^\]]+)\]/.exec(source)?.[1];
  assert.deepEqual(list?.split(",").map((name) => name.trim().replaceAll('"', "")), [...HARNESS_COMMANDS], "src/cli.ts routes exactly HARNESS_COMMANDS");
  assert.equal(requestsJsonl(["run", "x", "--json"]), true);
  assert.equal(requestsJsonl(["run", "x", "--mode", "jsonl"]), true);
  assert.equal(requestsJsonl(["run", "--mode=jsonl"]), true);
  assert.equal(requestsJsonl(["run", "--", "--json"]), false);
  assert.equal(requestsJsonl(["runs", "--json"]), false);
});

test("renderer selection: non-TTY, pipe, TERM=dumb, --plain and SYN_PLAIN are plain; --mode jsonl is jsonl (AC-2)", () => {
  const tty: TerminalFacts = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, stdoutHasColors: true, stderrHasColors: false };
  const settings = (request: { jsonl?: boolean; plain?: boolean; color?: "always" | "never" | "auto" }, facts: Partial<TerminalFacts> = {}) =>
    resolveTerminalSettings({ jsonl: request.jsonl ?? false, plain: request.plain ?? false, color: request.color ?? "auto" }, { ...tty, ...facts });

  assert.deepEqual(settings({}), { kind: "tui", color: true });
  assert.equal(settings({}, { stdoutIsTTY: false }).kind, "plain", "stdout piped");
  assert.equal(settings({}, { stdinIsTTY: false }).kind, "plain", "stdin piped");
  assert.equal(settings({}, { env: { TERM: "dumb" } }).kind, "plain");
  assert.equal(settings({ plain: true }).kind, "plain");
  assert.equal(settings({}, { env: { SYN_PLAIN: "1" } }).kind, "plain");
  assert.equal(settings({}, { env: { SYN_PLAIN: "0" } }).kind, "tui");
  assert.equal(settings({}, { env: { CI: "true" } }).kind, "tui", "CI alone never changes the mode");
  assert.equal(settings({ jsonl: true }).kind, "jsonl");
  assert.equal(settings({ jsonl: true }, { stdoutIsTTY: false }).kind, "jsonl");

  assert.equal(settings({}, { env: { NO_COLOR: "1" } }).color, false);
  assert.equal(settings({}, { env: { NO_COLOR: "" } }).color, true, "an empty NO_COLOR keeps colour");
  assert.equal(settings({ color: "always" }, { env: { NO_COLOR: "1" } }).color, true, "--color always beats NO_COLOR");
  assert.equal(settings({ color: "never" }, { env: { FORCE_COLOR: "3" } }).color, false, "--color never beats FORCE_COLOR");
  assert.equal(settings({}, { env: { FORCE_COLOR: "0" } }).color, false);
  assert.equal(settings({}, { stdoutIsTTY: false, stdoutHasColors: false, env: { FORCE_COLOR: "3" } }).color, true);
  assert.equal(settings({ jsonl: true }).color, false, "JSONL colours only stderr, which is not a colour terminal here");

  const piped = capture(false);
  assert.deepEqual(terminalSettingsFor(parseHarnessArgs(["run", "x"]), piped.io), { kind: "plain", color: false });
  const terminal = capture(true);
  assert.deepEqual(terminalSettingsFor(parseHarnessArgs(["agent"]), terminal.io), { kind: "tui", color: true });
  assert.deepEqual(terminalSettingsFor(parseHarnessArgs(["agent", "--plain"]), terminal.io), { kind: "plain", color: true });
  assert.equal(terminalSettingsFor(parseHarnessArgs(["runs"]), terminal.io), undefined);
});

test("runHarnessCommand: help exits 0, usage errors exit 2, unwired commands exit 1 on stderr", async () => {
  const help = capture();
  assert.equal(await runHarnessCommand(["run", "--help"], help.io), 0);
  assert.equal(help.out.join(""), commandHelp("run"));
  assert.match(help.out.join(""), /--mode jsonl \(alias --json\)/);
  assert.deepEqual(help.err, []);

  const bad = capture();
  assert.equal(await runHarnessCommand(["show", "nope"], bad.io), 2);
  assert.equal(bad.err.join(""), "Error: Invalid id: nope. Expected run_<ULID> or ses_<ULID>.\nRun `syn show --help` for usage.\n");
  assert.deepEqual(bad.out, []);

  const stub = capture();
  assert.equal(await runHarnessCommand(["auth", "status"], stub.io), 1);
  assert.match(stub.err.join(""), /^Error \[internal\]: syn auth status is not wired to the runtime yet/);
  assert.deepEqual(stub.out, []);
});

test("JSONL mode reports even usage errors as a valid frame sequence on stdout (AC-2)", async () => {
  for (const [argv, code, exit] of [
    [["run", "x", "--json", "--plain"], "usage_invalid", 2],
    [["run", "fix", "--mode", "jsonl"], "internal", 1],
  ] as const) {
    const { io, out, err } = capture();
    assert.equal(await runHarnessCommand(argv, io), exit);
    const { lines, rest } = splitJsonlLines(out.join(""));
    assert.equal(rest, "");
    const frames = lines.map((line) => jsonlFrameSchema.parse(JSON.parse(line)));
    assert.deepEqual(validateFrameSequence(frames), []);
    const last = frames.at(-1);
    assert.ok(last?.type === "error" && last.data.code === code && last.data.exit_code === exit);
    assert.deepEqual(err, []);
  }
});

test("the real binary routes runtime commands and keeps stdout free of escapes in a pipe (AC-2)", () => {
  const jsonl = cli(["run", "fix the build", "--mode", "jsonl"]);
  assert.equal(jsonl.status, 1);
  const { lines } = splitJsonlLines(jsonl.stdout);
  assert.deepEqual(validateFrameSequence(lines.map((line) => jsonlFrameSchema.parse(JSON.parse(line)))), []);
  assert.doesNotMatch(jsonl.stdout, /\r|\x1b/);

  const plain = cli(["run", "fix the build"], { FORCE_COLOR: "0" });
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, "");
  assert.doesNotMatch(plain.stderr, /\x1b/);

  const help = cli(["agent", "--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, commandHelp("agent"));

  const doctorRuntime = cli(["doctor", "--runtime", "--json"]);
  assert.equal(doctorRuntime.status, 1);
  assert.match(doctorRuntime.stderr, /syn doctor --runtime is not wired/);

  const usageError = cli(["login"]);
  assert.equal(usageError.status, 2);
  assert.match(usageError.stderr, /^Error: syn login requires a provider/);
});

test("the plain and JSONL paths never load pi-tui", () => {
  const hook = [
    "import { registerHooks } from 'node:module';",
    "registerHooks({ resolve(specifier, context, next) {",
    "  if (specifier.includes('pi-tui')) process.stderr.write('LOADED ' + specifier + '\\n');",
    "  return next(specifier, context);",
    "} });",
  ].join("\n");
  for (const args of [["run", "x"], ["run", "x", "--json"], ["runs"], ["inspect", "--help"]]) {
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, CLI, ...args], { encoding: "utf8" });
    assert.doesNotMatch(result.stderr, /LOADED/, `${args.join(" ")} loaded pi-tui`);
  }
  const control = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, "--input-type=module", "-e", `await import(${JSON.stringify(new URL("../src/harness/tui/pi-tui-renderer.ts", import.meta.url).href)});`],
    { encoding: "utf8" },
  );
  assert.match(control.stderr, /LOADED @earendil-works\/pi-tui/, "the hook detects a real pi-tui load");
});
