import type { ExecConfinement, PolicyMode } from "../contracts/index.ts";
import { parseShellScript, programName } from "./shell-parser.ts";

/**
 * Exec confinement by allowlist (default-deny). A command runs only when it is positively
 * recognised: an exact verification command, or a fully parsed argv on a vetted list. Nothing here
 * enumerates bad commands; whatever is not recognised is refused (or asked for in `ask` mode).
 *
 * - Read-only workers (explorer, reviewer, an rca-only debugger) may run only non-mutating git
 *   subcommands, directory listing and file viewing, `rg`/`grep`/`findstr` and exact verification
 *   commands, whatever the sandbox.
 * - Without a full OS sandbox every other worker may run only exact verification commands, the
 *   read-only list and a vetted build/test list. Allowlisted build/test commands still run
 *   repository code; only a full OS sandbox truly confines exec.
 * - With a full sandbox writers are not narrowed here (the OS backend confines them).
 */

export const EXEC_ALLOWLIST_CODES = ["exec-allowlisted", "exec-not-allowlisted", "exec-unconfined"] as const;
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
}

export interface ExecAllowlistDecision {
  readonly decision: "allow" | "ask" | "deny";
  readonly code: ExecAllowlistCode;
  /** `role` for the read-only list, `sandbox` for the partial-sandbox list (maps to `sandbox_insufficient`). */
  readonly layer: "role" | "sandbox";
  readonly message: string;
}

/** Undefined when nothing narrows exec (a writer under a full sandbox). */
export function evaluateExecAllowlist(input: ExecAllowlistInput): ExecAllowlistDecision | undefined {
  const { argv } = input;
  const layer = input.readOnly ? "role" : "sandbox";
  if (!input.readOnly && input.confinement === "full-sandbox") return undefined;
  const shown = argv.join(" ").slice(0, 200);
  if (matchesExactCommand(argv, input.verificationCommands)) {
    return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is an exact verification command` };
  }
  if (!input.readOnly && matchesExactCommand(argv, input.exactGrants ?? [])) {
    return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is an exact entry of the user allowlist` };
  }
  const refusal = unrecognised(argv);
  if (refusal === undefined) {
    if (isReadOnlyCommand(argv)) return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is on the read-only command list` };
    if (!input.readOnly && isBuildCommand(argv)) return { decision: "allow", code: "exec-allowlisted", layer, message: `${shown} is on the build/test allowlist` };
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

/** Why an argv cannot be recognised at all, or undefined when it is plain enough to look up. */
function unrecognised(argv: readonly string[]): string | undefined {
  const first = argv[0] ?? "";
  if (!PLAIN_WORD.test(first)) return "the program name is not a plain literal word, so the command is unclassifiable";
  const program = programName(first);
  if (hasInlineCode(program, argv.slice(1))) return `${program} is invoked with inline code`;
  return undefined;
}

const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Every simple command of each verification string, when the string is fully readable: no
 * substitution, no redirection and no pipes. The argv must equal one of them word for word.
 */
function matchesExactCommand(argv: readonly string[], commands: readonly string[]): boolean {
  return commands.some((command) => {
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

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse"]);
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

/** `git <read-only sub> ...` with the subcommand first (no `-c`/`-C`/`--git-dir`) and no flag that writes a file. */
function isReadOnlyGit(args: readonly string[]): boolean {
  const sub = args[0] ?? "";
  if (!READ_ONLY_GIT.has(sub)) return false;
  return !args.slice(1).some((argument) => /^--(output|ext-diff)(=|$)/i.test(argument));
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_SCRIPT_SUBS = new Set(["test", "build", "typecheck"]);
const FROZEN_INSTALL_FLAGS = new Set(["--frozen-lockfile", "--immutable", "--ignore-scripts", "--offline", "--prefer-offline"]);
const CONFIG_FLAG = /^(-C|--(script-shell|shell-emulator|node-options|userconfig|globalconfig|prefix|dir|config|workspace-root|global)\b)/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const TSC_FLAGS = new Set(["--noemit", "-b", "--build", "--pretty", "--incremental", "--verbose"]);
const GIT_ADD_FLAGS = new Set(["-a", "--all", "-u", "--update", "--"]);
const GIT_COMMIT_FLAGS = new Set(["-a", "--all", "-q", "--quiet", "--allow-empty", "-s", "--signoff"]);
const GIT_COMMIT_MESSAGE_FLAGS = new Set(["-m", "--message", "-am"]);

function isBuildCommand(argv: readonly string[]): boolean {
  const program = programName(argv[0] ?? "");
  const sub = argv[1] ?? "";
  const rest = argv.slice(2);
  if (PACKAGE_MANAGERS.has(program)) return isPackageCommand(program, sub, rest);
  switch (program) {
    case "node":
      return sub === "--test" && rest.every((argument) => (argument.startsWith("--test-") || argument === "--experimental-strip-types" || argument === "--no-warnings" || argument === "--experimental-test-coverage" || !argument.startsWith("-")) && staysInside(argument));
    case "tsc":
      return isTscCommand(argv.slice(1));
    case "git":
      return isReadOnlyGit(argv.slice(1)) || isGitAdd(sub, rest) || isGitCommit(sub, rest);
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

function isGitAdd(sub: string, rest: readonly string[]): boolean {
  if (sub !== "add") return false;
  return rest.every((argument) => (argument.startsWith("-") ? GIT_ADD_FLAGS.has(argument.toLowerCase()) : staysInside(argument)));
}

function isGitCommit(sub: string, rest: readonly string[]): boolean {
  if (sub !== "commit") return false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    if (GIT_COMMIT_MESSAGE_FLAGS.has(argument)) {
      if (rest[index + 1] === undefined) return false;
      index += 1;
      continue;
    }
    if (argument.startsWith("--message=")) continue;
    if (!GIT_COMMIT_FLAGS.has(argument)) return false;
  }
  return true;
}

/**
 * An argument (or the value of `--flag=value`) that names a place outside the workspace: an
 * absolute, drive, UNC or home-relative path, or one with a `..` segment.
 */
function staysInside(argument: string): boolean {
  const separator = argument.startsWith("-") ? argument.indexOf("=") : -1;
  const value = separator === -1 ? argument : argument.slice(separator + 1);
  if (value.startsWith("-")) return true;
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes("..");
}
