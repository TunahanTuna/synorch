import { FORBIDDEN_CREDENTIAL_SOURCES, type HardRail } from "../contracts/index.ts";
import {
  DEPENDENCY_MUTATION_CODE,
  dependencyMutation,
  DESTRUCTIVE_COMMAND_RULES,
  DOWNLOAD_PROGRAMS,
  DOWNLOAD_REFERENCE,
  EXTERNAL_WRITE_RULES,
  gitInvocation,
  INTERPRETER_PROGRAMS,
  ruleApplies,
  type CommandScope,
} from "./command-rules.ts";
import { carriesSecret } from "./secret-patterns.ts";
import { inlineScriptOf, parseShellScript, programName, shellDialect, type ShellDialect } from "./shell-parser.ts";

export interface CommandFinding {
  readonly rail: HardRail;
  readonly code: string;
  readonly message: string;
}

export interface CommandClassification {
  /** True when any `destructive-command` finding exists. */
  readonly destructive: boolean;
  /** `external-write` when the command publishes to a system outside the workspace. */
  readonly effect: "exec" | "external-write";
  /** True when the command may write files; read-only roles may not run it. */
  readonly mutating: boolean;
  /** Hard-rail findings: destructive commands, secret egress, credential access. */
  readonly findings: readonly CommandFinding[];
  readonly external: readonly { readonly code: string; readonly message: string }[];
}

interface Analysis {
  readonly findings: CommandFinding[];
  readonly external: { code: string; message: string }[];
  mutating: boolean;
}

const MAX_SHELL_DEPTH = 4;
const MAX_WRAPPER_LAYERS = 8;

const EGRESS_PROGRAMS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
  "start-bitstransfer",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "ssh",
]);
const FILE_READERS = new Set(["cat", "type", "get-content", "gc", "less", "more", "head", "tail", "base64", "xxd", "od", "strings"]);

const FOREIGN_CREDENTIAL_MARKERS = FORBIDDEN_CREDENTIAL_SOURCES.map((source) =>
  source.replace(/^~\//, "").replace(/^keychain:/, "").toLowerCase(),
);

const MUTATING_PROGRAMS = new Set([
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "rmdir",
  "tee",
  "dd",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "install",
  "patch",
  "unlink",
  "shred",
  "rimraf",
  "new-item",
  "ni",
  "md",
  "set-content",
  "sc",
  "add-content",
  "ac",
  "out-file",
  "copy-item",
  "cpi",
  "copy",
  "move-item",
  "mi",
  "move",
  "rename-item",
  "ren",
  "rni",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "clear-content",
  "clc",
  "set-item",
  "mklink",
  "xcopy",
  "robocopy",
  "icacls",
  "takeown",
  "attrib",
  "tar",
  "unzip",
  "expand-archive",
  "compress-archive",
]);
const GIT_MUTATING = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "apply",
  "am",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "push",
  "pull",
  "fetch",
  "tag",
  "rm",
  "mv",
  "init",
  "clone",
  "config",
  "worktree",
  "submodule",
  "gc",
  "update-ref",
  "notes",
  "filter-branch",
  "filter-repo",
  "reflog",
]);
const PACKAGE_MUTATING = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "ci",
  "link",
  "unlink",
  "publish",
  "init",
  "create",
  "dlx",
  "exec",
  "x",
  "rebuild",
  "prune",
  "dedupe",
  "patch",
  "pack",
  "import",
]);
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "eval"],
  deno: ["eval"],
  python: ["-c"],
  python3: ["-c"],
  py: ["-c"],
  perl: ["-e", "-E", "-i"],
  ruby: ["-e"],
  php: ["-r"],
  sed: ["-i", "--in-place"],
};

/**
 * Classifies one argv, looking through shell wrappers (`bash -c`, `cmd /c`, `powershell
 * -Command`, `-EncodedCommand`), prefix wrappers (`env`, `xargs`, `timeout`, `npx`, `wsl`) and
 * every command of every pipeline inside an inline script. The classification never grants:
 * callers treat any finding as a hard-rail denial.
 */
export function classifyCommand(argv: readonly string[], scope: CommandScope): CommandClassification {
  const analysis: Analysis = { findings: [], external: [], mutating: false };
  analyzeArgv(argv, scope, 0, analysis);
  const destructive = analysis.findings.some((finding) => finding.rail === "destructive-command");
  return {
    destructive,
    effect: analysis.external.length > 0 ? "external-write" : "exec",
    mutating: analysis.mutating || destructive,
    findings: dedupe(analysis.findings),
    external: dedupe(analysis.external),
  };
}

function analyzeArgv(argv: readonly string[], scope: CommandScope, depth: number, analysis: Analysis): void {
  let current = argv;
  for (let layer = 0; layer < MAX_WRAPPER_LAYERS && current.length > 0; layer += 1) {
    const program = programName(current[0] ?? "");
    const args = current.slice(1);
    applyRules(program, args, scope, analysis);
    inspectCredentials(program, current, analysis);
    if (scope.dependencyLinks === true) {
      const mutation = dependencyMutation(program, args);
      if (mutation !== undefined) analysis.findings.push({ rail: "write-outside-scope", code: DEPENDENCY_MUTATION_CODE, message: mutation });
    }
    const script = inlineScriptOf(program, args);
    if (script !== undefined) {
      analysis.mutating = true;
      if (script.kind === "script") analyzeScript(script.text, shellDialect(program), scope, depth + 1, analysis);
      else if (script.kind === "opaque") {
        analysis.findings.push({ rail: "destructive-command", code: "opaque-script", message: `${program} runs a script that cannot be read: ${script.reason}` });
      }
      return;
    }
    if (isMutatingLeaf(program, args)) analysis.mutating = true;
    for (const embedded of embeddedScripts(program, args)) analyzeScript(embedded, "posix", scope, depth + 1, analysis);
    for (const nested of embeddedCommands(program, args)) analyzeArgv(nested, scope, depth + 1, analysis);
    const inner = unwrapPrefix(program, args);
    if (inner === undefined) return;
    current = inner;
  }
  if (current.length > 0) {
    analysis.findings.push({ rail: "destructive-command", code: "wrapper-depth", message: "too many nested command wrappers to classify" });
  }
}

function analyzeScript(script: string, dialect: ShellDialect, scope: CommandScope, depth: number, analysis: Analysis): void {
  if (depth > MAX_SHELL_DEPTH) {
    analysis.findings.push({ rail: "destructive-command", code: "nested-shell", message: "shell nesting is too deep to classify" });
    return;
  }
  const parsed = parseShellScript(script, dialect);
  if (parsed.redirection) analysis.mutating = true;
  const programs: string[] = [];
  for (const pipeline of parsed.pipelines) {
    const names = pipeline.map((command) => programName(command[0] ?? ""));
    programs.push(...names);
    for (const command of pipeline) analyzeArgv(command, scope, depth, analysis);
    if (names.some((name, index) => DOWNLOAD_PROGRAMS.has(name) && names.slice(index + 1).some((next) => INTERPRETER_PROGRAMS.has(next)))) {
      analysis.findings.push(remoteScript());
    }
    const leaksInto = pipeline.findIndex((command) => isSecretSource(command));
    if (leaksInto !== -1 && names.slice(leaksInto + 1).some((name) => EGRESS_PROGRAMS.has(name))) {
      analysis.findings.push({ rail: "secret-egress", code: "secret-pipe", message: "a secret source is piped into a network command" });
    }
  }
  const downloads = programs.some((name) => DOWNLOAD_PROGRAMS.has(name));
  if (parsed.substitution && downloads && programs.some((name) => INTERPRETER_PROGRAMS.has(name))) analysis.findings.push(remoteScript());
  if (programs.some((name) => name === "iex" || name === "invoke-expression") && DOWNLOAD_REFERENCE.test(script)) {
    analysis.findings.push(remoteScript());
  }
}

const GIT_COMMAND_KEYS = /^(?:core\.(?:sshcommand|pager|editor|fsmonitor|askpass)|sequence\.editor|diff\.external|diff\.[^.]+\.command|merge\.[^.]+\.driver|filter\.[^.]+\.(?:clean|smudge|process)|gpg\.program|pager\.[^.]+)$/i;

/** Shell text a program runs on our behalf: `git -c alias.x='!cmd'`, `git -c core.sshCommand=cmd`. */
function embeddedScripts(program: string, args: readonly string[]): string[] {
  if (program !== "git") return [];
  const scripts: string[] = [];
  for (const [index, argument] of args.entries()) {
    const setting = argument === "-c" ? args[index + 1] : undefined;
    if (setting === undefined) continue;
    const separator = setting.indexOf("=");
    const key = separator === -1 ? setting : setting.slice(0, separator);
    const value = separator === -1 ? "" : setting.slice(separator + 1);
    if (/^alias\./i.test(key) && value.startsWith("!")) scripts.push(value.slice(1));
    else if (GIT_COMMAND_KEYS.test(key)) scripts.push(value);
  }
  return scripts;
}

/**
 * Commands a program runs from its own arguments: `find ... -exec cmd {} ;`. The `{}` placeholder
 * stands for paths under the search roots, so it is replaced by the root it came from; without a
 * root it stays unresolved and any scope check on it fails closed.
 */
function embeddedCommands(program: string, args: readonly string[]): string[][] {
  if (program !== "find") return [];
  const expressionStart = args.findIndex((value) => value.startsWith("-") || value === "(" || value === "!");
  const roots = expressionStart === -1 ? args : args.slice(0, expressionStart);
  const placeholder = roots.length === 1 ? `${roots[0]}/_` : "{}";
  const commands: string[][] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes((args[index] ?? "").toLowerCase())) continue;
    const command: string[] = [];
    for (index += 1; index < args.length && args[index] !== ";" && args[index] !== "+" && args[index] !== "\\;"; index += 1) {
      command.push(args[index] === "{}" ? placeholder : (args[index] ?? ""));
    }
    if (command.length > 0) commands.push(command);
  }
  return commands;
}

function remoteScript(): CommandFinding {
  return { rail: "destructive-command", code: "remote-script-exec", message: "downloading and executing a remote script bypasses every review" };
}

function applyRules(program: string, args: readonly string[], scope: CommandScope, analysis: Analysis): void {
  for (const rule of DESTRUCTIVE_COMMAND_RULES) {
    if (ruleApplies(rule, program) && rule.matches(args, scope)) {
      analysis.findings.push({ rail: "destructive-command", code: rule.code, message: rule.message });
    }
  }
  for (const rule of EXTERNAL_WRITE_RULES) {
    if (ruleApplies(rule, program) && rule.matches(args, scope)) analysis.external.push({ code: rule.code, message: rule.message });
  }
  if (EGRESS_PROGRAMS.has(program) && args.some(carriesSecret)) {
    analysis.findings.push({ rail: "secret-egress", code: "secret-egress", message: `${program} would send a secret or secret file off the machine` });
  }
  const invocation = program === "git" ? gitInvocation(args) : undefined;
  if (invocation !== undefined && ["push", "clone", "fetch", "pull", "remote"].includes(invocation.sub) && invocation.rest.some(carriesSecret)) {
    analysis.findings.push({ rail: "secret-egress", code: "secret-egress", message: "git would send embedded credentials to a remote" });
  }
  if (program === "git" && args.some((argument) => argument.toLowerCase().includes("core.hookspath"))) {
    analysis.findings.push({ rail: "reserved-path-write", code: "git-hooks-path", message: "core.hooksPath points git at hooks outside the reserved .git directory" });
  } else if (invocation?.sub === "config" && isGitConfigWrite(invocation.rest)) {
    analysis.findings.push({ rail: "reserved-path-write", code: "git-config-write", message: "git config writes .git/config (or a global config), which is reserved" });
  }
}

const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list"]);
const GIT_CONFIG_WRITE_FLAGS = new Set(["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"]);
const GIT_CONFIG_VALUE_FLAGS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);

/** Default-deny: a `git config` form counts as a write unless it is positively a read (`--get*`, `--list`, `get`, one key). */
function isGitConfigWrite(rest: readonly string[]): boolean {
  const positional: string[] = [];
  let read = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = (rest[index] ?? "").toLowerCase();
    if (GIT_CONFIG_WRITE_FLAGS.has(argument)) return true;
    if (GIT_CONFIG_READ_FLAGS.has(argument)) read = true;
    else if (GIT_CONFIG_VALUE_FLAGS.has(argument)) index += 1;
    else if (!argument.startsWith("-")) positional.push(argument);
  }
  const verb = positional[0];
  if (verb === "get" || verb === "list") return false;
  if (verb === "set" || verb === "unset" || verb === "edit" || verb === "rename-section" || verb === "remove-section") return true;
  return !(read || positional.length === 1);
}

function inspectCredentials(program: string, argv: readonly string[], analysis: Analysis): void {
  const joined = argv.join(" ").replaceAll("\\", "/").toLowerCase();
  const args = argv.slice(1).map((argument) => argument.toLowerCase());
  if (FOREIGN_CREDENTIAL_MARKERS.some((marker) => joined.includes(marker))) {
    analysis.findings.push({ rail: "foreign-credential-store", code: "foreign-credential-store", message: "another application's credential store is off limits" });
    return;
  }
  const keychainRead =
    (program === "security" && args.some((argument) => ["find-generic-password", "find-internet-password", "dump-keychain", "export", "delete-generic-password"].includes(argument))) ||
    (program === "secret-tool" && args.some((argument) => ["lookup", "search", "clear"].includes(argument))) ||
    program === "cmdkey" ||
    program === "vaultcmd" ||
    program === "get-storedcredential" ||
    (program === "rundll32" && joined.includes("keymgr.dll"));
  if (keychainRead || joined.includes(".synorch/credentials")) {
    analysis.findings.push({ rail: "credential-access", code: "credential-access", message: "credential stores are reachable only through the auth module" });
  }
  if (joined.includes(".synorch/config") || joined.includes(".synorch/policy") || ((program === "syn" || program === "synorch") && args[0] === "config")) {
    analysis.findings.push({ rail: "policy-self-modification", code: "policy-self-modification", message: "policy sources cannot be changed by a tool" });
  }
}

function isSecretSource(command: readonly string[]): boolean {
  const program = programName(command[0] ?? "");
  const args = command.slice(1);
  if ((program === "env" || program === "printenv" || program === "set" || program === "export") && args.every((argument) => argument.startsWith("-"))) return true;
  if (["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(program) && args.some((argument) => argument.toLowerCase().startsWith("env:"))) return true;
  return FILE_READERS.has(program) && args.some(carriesSecret);
}

function isMutatingLeaf(program: string, args: readonly string[]): boolean {
  if (MUTATING_PROGRAMS.has(program)) return true;
  if (program === "git") {
    const invocation = gitInvocation(args);
    if (invocation === undefined) return false;
    if (GIT_MUTATING.has(invocation.sub)) return true;
    return invocation.sub === "branch" && invocation.rest.some((argument) => !argument.startsWith("-") || /^-[dDmMcC]$/.test(argument));
  }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "go", "gem", "composer"].includes(program)) {
    const first = args.find((argument) => !argument.startsWith("-"))?.toLowerCase();
    if (first !== undefined && PACKAGE_MUTATING.has(first)) return true;
  }
  const inline = INLINE_CODE_FLAGS[program];
  if (inline === undefined) return false;
  return args.some((argument) =>
    inline.some((flag) => argument === flag || argument.startsWith(`${flag}=`) || (program === "sed" && flag === "-i" && argument.startsWith("-i"))),
  );
}

const SIMPLE_WRAPPERS = new Set(["nohup", "exec", "command", "builtin", "time", "call", "busybox", "doas", "sudo", "gsudo", "pkexec"]);
const VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-i", "-n", "-P", "-d", "-a", "-L", "-s", "-E", "--max-args", "--max-procs", "--delimiter", "--arg-file"],
  npx: ["-p", "--package", "-c", "--call"],
  pnpx: ["-p", "--package"],
  bunx: ["-p", "--package"],
  wsl: ["-d", "--distribution", "-u", "--user", "--cd"],
  stdbuf: ["-i", "-o", "-e"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "-D", "-h", "-p", "-r", "-t"],
};

/** The wrapped command of a prefix wrapper (`env X=1 rm ...` → `rm ...`), or undefined. */
function unwrapPrefix(program: string, args: readonly string[]): readonly string[] | undefined {
  if (program === "env" && args.some((argument) => argument === "-S" || argument === "--split-string")) {
    const index = args.findIndex((argument) => argument === "-S" || argument === "--split-string");
    return ["sh", "-c", args.slice(index + 1).join(" ")];
  }
  if (["pnpm", "yarn", "npm"].includes(program)) {
    const first = args[0]?.toLowerCase();
    if (first === "dlx" || first === "exec" || first === "x") return skipOptions(args.slice(1), []);
    return undefined;
  }
  if (program === "start") return skipStartOptions(args);
  const valueFlags = VALUE_FLAGS[program];
  if (!SIMPLE_WRAPPERS.has(program) && valueFlags === undefined) return undefined;
  let rest = skipOptions(args, valueFlags ?? []);
  if (program === "timeout" && rest.length > 0) rest = rest.slice(1);
  if (program === "env") rest = dropAssignments(rest);
  if (program === "wsl" && (rest[0] === "-e" || rest[0] === "--exec")) rest = rest.slice(1);
  return rest.length > 0 ? rest : undefined;
}

function dropAssignments(args: readonly string[]): readonly string[] {
  let index = 0;
  while (index < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index] ?? "")) index += 1;
  return args.slice(index);
}

function skipOptions(args: readonly string[], valueFlags: readonly string[]): readonly string[] {
  let index = 0;
  while (index < args.length) {
    const argument = args[index] ?? "";
    if (argument === "--") return args.slice(index + 1);
    if (!argument.startsWith("-") || argument === "-") break;
    index += valueFlags.includes(argument) ? 2 : 1;
  }
  return args.slice(index);
}

function skipStartOptions(args: readonly string[]): readonly string[] | undefined {
  let index = 0;
  while (index < args.length && /^\/[a-z]+$/i.test(args[index] ?? "")) index += 1;
  const rest = args.slice(index);
  return rest.length > 0 ? rest : undefined;
}

function dedupe<T extends { readonly code: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${"rail" in item ? String(item.rail) : ""}:${item.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
