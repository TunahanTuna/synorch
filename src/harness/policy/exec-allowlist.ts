import { WORKSPACE_UNTRUSTED_CODE, type ExecConfinement, type PolicyMode, type VerificationCommandClass } from "../contracts/index.ts";
import { dependencyMutation, gitInvocation } from "./command-rules.ts";
import { parseShellScript, programName } from "./shell-parser.ts";

/**
 * Exec confinement by allowlist (default-deny). A command runs only when it is positively
 * recognised: an exact verification command, or a fully parsed argv on a vetted list. Nothing here
 * enumerates bad commands as the way in; whatever is not recognised is refused (or asked for in
 * `ask` mode).
 *
 * Order matters (SEC-N5): an argv that cannot be recognised (non-literal program, inline code) or
 * that carries a hard-refused form (a module-loading flag for node, a git form that writes the
 * repository or reads outside the workspace) is refused before any exact-match allow, so a plan
 * can never smuggle such a command in as a "verification command".
 *
 * - Read-only workers (explorer, reviewer, an rca-only debugger) may run only non-mutating git
 *   subcommands, directory listing and file viewing, `rg`/`grep`/`findstr` and exact verification
 *   commands, whatever the sandbox.
 * - Without a full OS sandbox every other worker may run only exact verification commands, the
 *   read-only list and a vetted build/test list.
 * - Verification and build/test commands run repository code the policy-only sandbox cannot
 *   confine (SEC-N1). Without a full sandbox they need the user to have trusted the workspace; an
 *   untrusted workspace denies them (`workspace-untrusted`) in autonomous mode and asks in `ask`.
 * - With a full sandbox writers are not narrowed here (the OS backend confines them).
 * - Only the harness integrates: no worker list contains a git form that writes the repository
 *   (SEC-N3).
 */

export const EXEC_ALLOWLIST_CODES = ["exec-allowlisted", "exec-not-allowlisted", "exec-unconfined", WORKSPACE_UNTRUSTED_CODE] as const;
export type ExecAllowlistCode = (typeof EXEC_ALLOWLIST_CODES)[number];

export interface ExecAllowlistInput {
  readonly argv: readonly string[];
  /** Explorer, reviewer, or a debugger without owned paths. */
  readonly readOnly: boolean;
  readonly confinement: ExecConfinement;
  readonly mode: PolicyMode;
  readonly verificationCommands: readonly string[];
  /** Exact (non-wildcard) user allowlist entries for external writes; each is an exact argv the user granted. */
  readonly exactGrants?: readonly string[];
  /** The user trusted this workspace (user-scope trust store or `--trust-workspace`). */
  readonly workspaceTrusted?: boolean;
  /**
   * `/allow` prefixes (conversation agent only, ADR-21): an argv whose leading words equal one of
   * them is treated like a build/test command (it runs repository code, so it still needs trust
   * without a full sandbox). Hard refusals, unrecognisable argv and outside paths are never granted.
   */
  readonly commandGrants?: readonly string[];
}

export interface ExecAllowlistDecision {
  readonly decision: "allow" | "ask" | "deny";
  readonly code: ExecAllowlistCode;
  /**
   * `role` for the read-only list, `sandbox` for the partial-sandbox list (maps to
   * `sandbox_insufficient`), `user` for workspace trust (a user-scope decision).
   */
  readonly layer: "role" | "sandbox" | "user";
  readonly message: string;
}

/** Undefined when nothing narrows exec (a writer under a full sandbox). */
export function evaluateExecAllowlist(input: ExecAllowlistInput): ExecAllowlistDecision | undefined {
  const { argv } = input;
  const layer = input.readOnly ? "role" : "sandbox";
  const shown = argv.join(" ").slice(0, 200);
  const integration = gitIntegration(argv);
  if (integration !== undefined) return { decision: "deny", code: "exec-not-allowlisted", layer: "role", message: `${shown} is refused: ${integration}` };
  if (!input.readOnly && input.confinement === "full-sandbox") return undefined;
  const hard = hardRefusal(argv);
  if (hard !== undefined) return { decision: "deny", code: "exec-not-allowlisted", layer: "role", message: `${shown} is refused: ${hard}` };
  const refusal = unrecognised(argv);
  if (refusal === undefined) {
    if (!input.readOnly && matchesExactCommand(argv, input.exactGrants ?? [])) {
      return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is an exact entry of the user allowlist` };
    }
    if (isReadOnlyCommand(argv)) return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is on the read-only command list` };
    const isGit = programName(argv[0] ?? "") === "git";
    const kind =
      !isGit && matchesExactCommand(argv, input.verificationCommands)
        ? "an exact verification command"
        : !input.readOnly && isBuildCommand(argv)
          ? "on the build/test allowlist"
          : !input.readOnly && !isGit && matchesGrant(argv, input.commandGrants ?? [])
            ? "allowed by /allow"
            : undefined;
    if (kind !== undefined) {
      if (input.confinement === "full-sandbox") return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is ${kind}` };
      if (input.workspaceTrusted === true) {
        return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is ${kind}; the user trusted this workspace, so it runs unconfined with the user's permissions` };
      }
      const message = `${shown} is ${kind}, but it runs repository code this sandbox cannot confine and the workspace is not trusted (run syn trust, or pass --trust-workspace for one run)`;
      return { decision: input.mode === "ask" ? "ask" : "deny", code: WORKSPACE_UNTRUSTED_CODE, layer: "user", message };
    }
  }
  const why = refusal ?? (input.readOnly ? "it is not on the read-only command list" : "it is not a verification command or on the build/test allowlist");
  if (input.readOnly) {
    return { decision: "deny", code: "exec-not-allowlisted", layer, message: `read-only worker may not run ${shown}: ${why}` };
  }
  if (input.mode === "ask") {
    return { decision: "ask", code: "exec-unconfined", layer, message: `${shown} would run without a full sandbox (${why}); it needs approval` };
  }
  return { decision: "deny", code: "exec-not-allowlisted", layer, message: `${shown} cannot run without a full sandbox: ${why}` };
}

/**
 * What kind of check a verification argv is (ADR-18, review R1/R2): `build-test` for the vetted
 * build/test list (minus installs), `read-only` for the read-only list (git status/diff/log/show,
 * listing, viewing, search), `other` for anything else. Only a passed `build-test` run (or one a
 * criterion names exactly, never a `read-only` one) proves behaviour.
 */
export function classifyVerificationCommand(argv: readonly string[]): VerificationCommandClass {
  if (argv.length === 0 || unrecognised(argv) !== undefined || hardRefusal(argv) !== undefined || gitIntegration(argv) !== undefined) return "other";
  if (isReadOnlyCommand(argv)) return "read-only";
  if (isBuildCommand(argv) && dependencyMutation(programName(argv[0] ?? ""), argv.slice(1)) === undefined) return "build-test";
  return "other";
}

/** Whether the argv starts with every word of a `/allow` prefix and names no path outside the workspace. */
function matchesGrant(argv: readonly string[], grants: readonly string[]): boolean {
  if (!argv.slice(1).every(staysInside)) return false;
  return grants.some((grant) => {
    const words = grant.trim().split(/\s+/).filter((word) => word.length > 0);
    return words.length > 0 && words.length <= argv.length && words.every((word, index) => (index === 0 ? programName(argv[0] ?? "") === programName(word) : argv[index] === word));
  });
}

/** Why an argv cannot be recognised at all, or undefined when it is plain enough to look up. */
function unrecognised(argv: readonly string[]): string | undefined {
  const first = argv[0] ?? "";
  if (!PLAIN_WORD.test(first)) return "the program name is not a plain literal word, so the command is unclassifiable";
  const program = programName(first);
  if (hasInlineCode(program, argv.slice(1))) return `${program} is invoked with inline code`;
  return undefined;
}

/**
 * Forms refused in every mode and for every non-full-sandbox worker, whatever list or exact
 * verification command they would otherwise match.
 */
function hardRefusal(argv: readonly string[]): string | undefined {
  const program = programName(argv[0] ?? "");
  if (program === "node") return nodeModuleInjection(argv.slice(1));
  if (program === "git") return gitRefusal(argv.slice(1));
  return undefined;
}

const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** A leading `NAME=value` word (a `NODE_OPTIONS=...` style environment injection) in any command of the string. */
const ASSIGNMENT_PREFIX = /(^|[;&|(\n])\s*[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every simple command of each verification string, when the string is fully readable: no
 * substitution, no redirection, no pipes and no environment assignment. The argv must equal one
 * of them word for word.
 */
function matchesExactCommand(argv: readonly string[], commands: readonly string[]): boolean {
  return commands.some((command) => {
    if (ASSIGNMENT_PREFIX.test(command)) return false;
    const parsed = parseShellScript(command, "posix");
    if (parsed.substitution || parsed.redirection) return false;
    return parsed.pipelines.some((pipeline) => {
      const words = pipeline.length === 1 ? pipeline[0] : undefined;
      return words !== undefined && words.length === argv.length && words.every((word, index) => word === argv[index]);
    });
  });
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "csh", "tcsh"]);

/** An interpreter handed code on its command line: any flag cluster carrying an eval/print/command flag. */
export function hasInlineCode(program: string, args: readonly string[]): boolean {
  const lowered = args.map((argument) => argument.toLowerCase());
  const cluster = (letters: string): boolean => args.some((argument) => /^-[A-Za-z]+$/.test(argument) && [...letters].some((letter) => argument.slice(1).includes(letter)));
  if (program === "node" || program === "bun") return cluster("ep") || lowered.some((argument) => /^--(eval|print)(=|$)/.test(argument)) || (program === "bun" && lowered[0] === "eval");
  if (program === "python" || program === "python3" || program === "py" || program.startsWith("python3.")) return cluster("c");
  if (program === "powershell" || program === "pwsh" || program === "powershell_ise") {
    return lowered.some((argument) => {
      const flag = argument.replace(/^[/–—―]/, "-");
      return flag === "-c" || flag === "-e" || flag === "-ec" || flag === "-cwa" || (flag.length >= 3 && ("-command".startsWith(flag) || "-encodedcommand".startsWith(flag) || "-commandwithargs".startsWith(flag)));
    });
  }
  if (POSIX_SHELLS.has(program)) return cluster("c");
  if (program === "cmd") return lowered.some((argument) => /^\/[ckr]/.test(argument));
  if (program === "deno") return lowered[0] === "eval" || cluster("e") || lowered.includes("--eval");
  if (program === "ruby") return cluster("e");
  if (program === "perl") return cluster("eE");
  return false;
}

/**
 * Node options that load a module, a config or an environment file, open a debugger, or change
 * what runs before the tests (SEC-N1). They are refused for every node invocation, trusted or not.
 */
const NODE_LOADING_OPTIONS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--experimental-default-config-file",
  "--test-global-setup",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-wait",
  "--debug-port",
  "--openssl-config",
  "--snapshot-blob",
  "--build-snapshot",
  "--build-snapshot-config",
  "--experimental-sea-config",
]);
const BUILTIN_TEST_REPORTERS = new Set(["spec", "tap", "dot", "junit", "lcov"]);
const REPORTER_STREAMS = new Set(["stdout", "stderr"]);

/** Why a node argv loads code from outside Node itself, or undefined. Only built-in reporters are allowed. */
function nodeModuleInjection(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separator = argument.indexOf("=");
    const name = (separator === -1 ? argument : argument.slice(0, separator)).toLowerCase();
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    if (NODE_LOADING_OPTIONS.has(name) || /^-r./.test(argument)) return `node ${name} loads code or configuration from a file`;
    if (name === "--test-reporter") {
      const value = inline ?? args[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || !BUILTIN_TEST_REPORTERS.has(value)) return `node --test-reporter ${value ?? ""} is not a built-in reporter (${[...BUILTIN_TEST_REPORTERS].join(", ")})`.trim();
      continue;
    }
    if (name === "--test-reporter-destination") {
      const value = inline ?? args[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value.startsWith("-") || (!REPORTER_STREAMS.has(value) && !staysInside(value))) return `node --test-reporter-destination ${value ?? ""} points outside the workspace`.trim();
    }
  }
  return undefined;
}

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse"]);
/**
 * Git subcommands that change the repository, the index or refs. Only the harness integrates
 * worker changes (SEC-N3); no worker list or verification command may contain them.
 */
const GIT_INTEGRATION_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "stash",
  "checkout",
  "reset",
  "switch",
  "restore",
  "rebase",
  "merge",
  "tag",
  "branch",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "mv",
  "rm",
  "pull",
  "clean",
  "worktree",
  "update-ref",
  "update-index",
  "notes",
  "replace",
  "submodule",
  "config",
  "gc",
  "prune",
  "init",
  "clone",
]);
/** `git branch`, `git tag`, `git stash` forms that only list; they are still not on any list. */
const GIT_LISTING_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--no-color", "--color"]);

/**
 * Why a git argv may not run for a worker (SEC-N2, SEC-N3): a writing subcommand, or an argument
 * that makes git read or write a file outside the workspace (`--no-index`, an order file,
 * `--contents`, `--output*`, external diff/textconv drivers, or any path resolving outside).
 */
function gitRefusal(args: readonly string[]): string | undefined {
  const integration = gitIntegration(["git", ...args]);
  if (integration !== undefined) return integration;
  for (const argument of args) {
    const lowered = argument.toLowerCase();
    if (/^--(no-index|orderfile|contents|ext-diff|textconv)(=|$)/.test(lowered) || lowered.startsWith("--output") || /^-O/.test(argument)) {
      return `git ${argument.split("=")[0] ?? argument} reads or writes files outside the tracked tree`;
    }
    const attached = /^-[A-Za-z]./.test(argument) && !argument.startsWith("--") ? argument.slice(2) : undefined;
    const revisionPath = !argument.startsWith("-") && argument.includes(":") ? argument.slice(argument.indexOf(":") + 1) : undefined;
    if (!staysInside(argument) || (attached !== undefined && !staysInside(attached)) || (revisionPath !== undefined && !staysInside(revisionPath))) {
      return `git argument ${argument.slice(0, 200)} names a path outside the workspace`;
    }
  }
  return undefined;
}

/** A git argv whose subcommand writes the repository, the index or refs (any sandbox, any worker). */
function gitIntegration(argv: readonly string[]): string | undefined {
  if (programName(argv[0] ?? "") !== "git") return undefined;
  const invocation = gitInvocation(argv.slice(1));
  if (invocation === undefined || !GIT_INTEGRATION_SUBCOMMANDS.has(invocation.sub) || isGitListing(invocation.sub, invocation.rest)) return undefined;
  return `git ${invocation.sub} changes the repository; only the harness integrates worker changes`;
}

function isGitListing(sub: string, rest: readonly string[]): boolean {
  if (sub === "stash") return rest.length === 1 && rest[0] === "list";
  if (sub === "branch" || sub === "tag") return rest.every((argument) => GIT_LISTING_FLAGS.has(argument));
  return false;
}

const VIEWERS = new Set(["ls", "dir", "tree", "cat", "type", "head", "tail", "wc", "stat", "file", "pwd"]);
const SEARCHERS = new Set(["rg", "grep", "egrep", "fgrep", "findstr"]);

function isReadOnlyCommand(argv: readonly string[]): boolean {
  const program = programName(argv[0] ?? "");
  const args = argv.slice(1);
  if (program === "git") return isReadOnlyGit(args);
  if (VIEWERS.has(program)) return args.every((argument) => viewerArgumentInside(program, argument));
  if (!SEARCHERS.has(program)) return false;
  if (program === "rg" && args.some((argument) => /^--(pre|hostname-bin)(=|$)/i.test(argument))) return false;
  const explicitPattern = args.some((argument) => /^(-e|--regexp)(=|$)/.test(argument) || /^\/c:/i.test(argument));
  let patternSeen = explicitPattern;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-e" || argument === "--regexp") {
      index += 1;
      continue;
    }
    const flag = argument.startsWith("-") || isWindowsSwitch(program, argument);
    if (!flag && !patternSeen) {
      patternSeen = true;
      continue;
    }
    if (!viewerArgumentInside(program, argument)) return false;
  }
  return true;
}

const WINDOWS_SWITCH_PROGRAMS = new Set(["dir", "tree", "findstr", "type"]);

/** `dir /s`, `findstr /i /c:text`: single-letter switches of Windows programs, never a path like `/etc`. */
function isWindowsSwitch(program: string, argument: string): boolean {
  return WINDOWS_SWITCH_PROGRAMS.has(program) && /^\/[A-Za-z?](:.*)?$/.test(argument);
}

function viewerArgumentInside(program: string, argument: string): boolean {
  if (isWindowsSwitch(program, argument)) return /^\/c:/i.test(argument) || staysInside(argument.slice(3));
  return staysInside(argument);
}

/**
 * `git <read-only sub> ...` with the subcommand first (no `-c`/`-C`/`--git-dir`). Every argument
 * already passed `gitRefusal` (no writing subcommand, no out-of-tree file, no outside path).
 */
function isReadOnlyGit(args: readonly string[]): boolean {
  return READ_ONLY_GIT.has(args[0] ?? "") && gitRefusal(args) === undefined;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_SCRIPT_SUBS = new Set(["test", "build", "typecheck"]);
const FROZEN_INSTALL_FLAGS = new Set(["--frozen-lockfile", "--immutable", "--ignore-scripts", "--offline", "--prefer-offline"]);
const CONFIG_FLAG = /^(-C|--(script-shell|shell-emulator|node-options|userconfig|globalconfig|prefix|dir|config|workspace-root|global)\b)/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const TSC_FLAGS = new Set(["--noemit", "-b", "--build", "--pretty", "--incremental", "--verbose"]);
const NODE_TEST_FLAGS = new Set(["--experimental-strip-types", "--no-warnings", "--experimental-test-coverage"]);

function isBuildCommand(argv: readonly string[]): boolean {
  const program = programName(argv[0] ?? "");
  const sub = argv[1] ?? "";
  const rest = argv.slice(2);
  if (PACKAGE_MANAGERS.has(program)) return isPackageCommand(program, sub, rest);
  switch (program) {
    case "node":
      return sub === "--test" && isNodeTestArguments(rest);
    case "tsc":
      return isTscCommand(argv.slice(1));
    case "dotnet":
      return (sub === "build" || sub === "test") && rest.every(staysInside);
    case "mvn":
    case "mvnw":
      return sub === "test" && rest.every(staysInside);
    case "gradle":
    case "gradlew":
      return sub === "test" && rest.every((argument) => !/^(-I|--init-script)(=|$)/.test(argument) && staysInside(argument));
    case "cargo":
      return (sub === "build" || sub === "test") && rest.every((argument) => !/^(--config|-Z)(=|$)/.test(argument) && staysInside(argument));
    case "go":
      return (sub === "build" || sub === "test") && rest.every((argument) => !/^--?(exec|toolexec)(=|$)/.test(argument) && staysInside(argument));
    case "pytest":
      return argv.slice(1).every(staysInside);
    default:
      return false;
  }
}

/** `node --test` options: `--test-*` (reporters already restricted by `nodeModuleInjection`), a few flags, test paths. */
function isNodeTestArguments(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if ((argument === "--test-reporter" || argument === "--test-reporter-destination") && args[index + 1] !== undefined) {
      index += 1;
      continue;
    }
    const known = argument.startsWith("--test-") || NODE_TEST_FLAGS.has(argument) || !argument.startsWith("-");
    if (!known || !staysInside(argument)) return false;
  }
  return true;
}

function isPackageCommand(program: string, sub: string, rest: readonly string[]): boolean {
  if (PACKAGE_SCRIPT_SUBS.has(sub)) return packageArgumentsSafe(rest);
  if (sub === "run" || sub === "run-script") return SCRIPT_NAME.test(rest[0] ?? "") && packageArgumentsSafe(rest.slice(1));
  if (sub === "install" || sub === "i") {
    const frozen = rest.includes("--frozen-lockfile") || (program === "yarn" && rest.includes("--immutable"));
    return frozen && rest.every((argument) => FROZEN_INSTALL_FLAGS.has(argument));
  }
  if (program === "npm" && sub === "ci") return rest.every((argument) => FROZEN_INSTALL_FLAGS.has(argument));
  return false;
}

/** Package-manager options that change which shell, config or directory runs the script are refused before `--`. */
function packageArgumentsSafe(args: readonly string[]): boolean {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  return options.every((argument) => !CONFIG_FLAG.test(argument)) && args.every(staysInside);
}

function isTscCommand(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const lowered = argument.toLowerCase();
    if (lowered === "-p" || lowered === "--project") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-") || !staysInside(value)) return false;
      index += 1;
      continue;
    }
    if (TSC_FLAGS.has(lowered)) continue;
    if (argument.startsWith("-") || !staysInside(argument)) return false;
  }
  return true;
}

/**
 * False when an argument (or the value of `--flag=value`) names a place outside the workspace: an
 * absolute, drive, UNC or home-relative path, or one with a `..` segment.
 */
function staysInside(argument: string): boolean {
  const separator = argument.startsWith("-") ? argument.indexOf("=") : -1;
  const value = separator === -1 ? argument : argument.slice(separator + 1);
  if (value.startsWith("-")) return true;
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes("..");
}
