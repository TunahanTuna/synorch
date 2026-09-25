import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "../../contracts/index.ts";

/**
 * K7 hooks in Claude Code's format (code.claude.com/docs/en/hooks, checked 2026-09-25): a plugin's
 * `hooks/hooks.json` (or manifest `hooks`) and the user configuration's `hooks:` block, both
 * `{ <Event>: [{ matcher?, hooks: [{ type: "command", command, args?, timeout? }] }] }`.
 *
 * Supported events (the ones that map onto Synorch's tool gateway and conversation loop):
 * SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop. Other events and non-`command`
 * hook types are listed as unsupported and never run.
 *
 * A command hook gets the event as JSON on stdin and answers with its exit code and stdout:
 *   exit 0   stdout JSON is read (`continue: false`, `decision: "block"`, `reason`,
 *            `systemMessage`, `hookSpecificOutput.{permissionDecision, permissionDecisionReason,
 *            additionalContext}`); plain stdout is context for SessionStart / UserPromptSubmit
 *   exit 2   blocks (PreToolUse denies, UserPromptSubmit drops the prompt, Stop continues the
 *            turn); stderr is the reason (PostToolUse: fed back to the model)
 *   other    a non-blocking error, shown as a note
 *
 * Safety: hooks run arbitrary commands. User hooks (`hooks:` in `~/.synorch/config.yaml`) are the
 * user's own and run as written. A plugin's hooks run only after the user approved them; the
 * approval stores a digest of the hook definitions and the plugin root, so a changed plugin asks
 * again. Claude-sourced plugin hooks are off until `/plugins hooks approve <plugin>`, and never
 * run on Claude Code native routes (Claude runs them itself there). A hook can deny or narrow a
 * tool call (allow → ask), never widen one: `permissionDecision: "allow"` and `updatedInput` are
 * ignored and the policy engine's hard rails always apply.
 */

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  readonly command: string;
  readonly args: readonly string[] | undefined;
  /** Seconds. */
  readonly timeout: number | undefined;
}

export interface HookGroup {
  readonly matcher: string | undefined;
  readonly hooks: readonly HookCommand[];
}

export type HookConfig = Readonly<Partial<Record<HookEvent, readonly HookGroup[]>>>;

export interface ParsedHooks {
  readonly config: HookConfig;
  /** Events or hook types present but not supported (listed, never run). */
  readonly unsupported: readonly string[];
}

const EVENT_SET = new Set<string>(HOOK_EVENTS);

/** Accepts `{hooks: {...}}` (hooks.json, settings) or the event map itself. */
export function parseHookConfig(raw: unknown): ParsedHooks {
  const events = (raw as { hooks?: unknown } | undefined)?.hooks ?? raw;
  const config: Partial<Record<HookEvent, HookGroup[]>> = {};
  const unsupported: string[] = [];
  if (typeof events !== "object" || events === null || Array.isArray(events)) return { config, unsupported };
  for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
    if (!EVENT_SET.has(event)) {
      unsupported.push(event);
      continue;
    }
    const parsed: HookGroup[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const entry = (typeof group === "object" && group !== null ? group : {}) as Record<string, unknown>;
      const hooks: HookCommand[] = [];
      for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
        const record = (typeof hook === "object" && hook !== null ? hook : {}) as Record<string, unknown>;
        const type = record.type ?? "command";
        if (type !== "command" || typeof record.command !== "string" || record.command.trim() === "") {
          unsupported.push(`${event}:${String(type)}`);
          continue;
        }
        const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : undefined;
        const timeout = typeof record.timeout === "number" && record.timeout > 0 ? record.timeout : undefined;
        hooks.push({ command: record.command, args, timeout });
      }
      if (hooks.length > 0) parsed.push({ matcher: typeof entry.matcher === "string" && entry.matcher.trim() !== "" ? entry.matcher : undefined, hooks });
    }
    if (parsed.length > 0) config[event as HookEvent] = [...(config[event as HookEvent] ?? []), ...parsed];
  }
  return { config, unsupported: [...new Set(unsupported)] };
}

/** Merges several hook configurations (a plugin's hooks.json and manifest `hooks`). */
export function mergeHookConfigs(configs: readonly HookConfig[]): HookConfig {
  const merged: Partial<Record<HookEvent, HookGroup[]>> = {};
  for (const config of configs) for (const event of HOOK_EVENTS) if (config[event] !== undefined) merged[event] = [...(merged[event] ?? []), ...(config[event] ?? [])];
  return merged;
}

export function hookCount(config: HookConfig): number {
  return HOOK_EVENTS.reduce((sum, event) => sum + (config[event] ?? []).reduce((inner, group) => inner + group.hooks.length, 0), 0);
}

/** One line per hook, for approval modals and `/plugins show`. */
export function describeHookConfig(config: HookConfig): string[] {
  const lines: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const group of config[event] ?? []) {
      for (const hook of group.hooks) lines.push(`${event}${group.matcher === undefined ? "" : ` [${group.matcher}]`}: ${hook.command}${hook.args === undefined ? "" : ` ${hook.args.join(" ")}`}`);
    }
  }
  return lines;
}

// ---- tool names ----------------------------------------------------------------------------------

/** Synorch tool → Claude Code tool names a Claude plugin's matcher may use. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash"],
  read_file: ["Read"],
  write_file: ["Write"],
  apply_patch: ["Edit", "MultiEdit"],
  search: ["Grep"],
  glob: ["Glob"],
  list_dir: ["LS"],
  web_fetch: ["WebFetch"],
  web_search: ["WebSearch"],
  todo: ["TodoWrite"],
};

/** The name a hook sees as `tool_name`: the Claude name when there is one, else Synorch's. */
export function claudeToolName(tool: string): string {
  return CLAUDE_TOOL_NAMES[tool]?.[0] ?? tool;
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function patchPaths(patch: string): string[] {
  const found = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) if (match[1] !== undefined) found.add(match[1].trim());
  for (const match of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (match[1] !== undefined && match[1].trim() !== "/dev/null") found.add(match[1].trim());
  return [...found];
}

/** Synorch arguments in Claude Code's `tool_input` shape (original keys kept alongside). */
export function claudeToolInput(tool: string, args: Readonly<Record<string, unknown>>, workspaceRoot: string): Record<string, unknown> {
  const absolute = (value: unknown): string | undefined => (typeof value === "string" ? path.resolve(workspaceRoot, value) : undefined);
  switch (tool) {
    case "exec": {
      const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
      return { ...args, command: argv.map(quoteArg).join(" "), ...(typeof args.timeout_ms === "number" ? { timeout: args.timeout_ms } : {}), run_in_background: args.background === true };
    }
    case "read_file":
    case "write_file":
      return { ...args, file_path: absolute(args.path) };
    case "apply_patch": {
      const paths = patchPaths(typeof args.patch === "string" ? args.patch : "").map((entry) => path.resolve(workspaceRoot, entry));
      return { ...args, file_path: paths[0], file_paths: paths };
    }
    case "search":
    case "glob":
      return { ...args, ...(typeof args.path === "string" ? { path: absolute(args.path) } : {}) };
    default:
      return { ...args };
  }
}

/**
 * Claude Code's matcher rules: empty / `*` matches all; only letters, digits, `_`, `-`, spaces, `|`
 * and `,` → exact names separated by `|` or `,`; anything else → an unanchored regular expression.
 */
export function matcherMatches(matcher: string | undefined, candidates: readonly string[]): boolean {
  if (matcher === undefined || matcher.trim() === "" || matcher.trim() === "*") return true;
  if (/^[\w\s|,-]+$/.test(matcher)) {
    const names = matcher.split(/[|,]/).map((name) => name.trim()).filter((name) => name !== "");
    return candidates.some((candidate) => names.includes(candidate));
  }
  try {
    const pattern = new RegExp(matcher);
    return candidates.some((candidate) => pattern.test(candidate));
  } catch {
    return false;
  }
}

// ---- approvals -----------------------------------------------------------------------------------

export const HOOK_APPROVALS_FILE = "hook-approvals.json";

export interface HookApprovals {
  readonly schema_version: 1;
  readonly approved: Readonly<Record<string, { readonly digest: string; readonly approved_at: string }>>;
}

function approvalsFile(home: string): string {
  return path.join(home, "plugins", HOOK_APPROVALS_FILE);
}

export async function readHookApprovals(home: string): Promise<HookApprovals> {
  try {
    const raw = JSON.parse(await readFile(approvalsFile(home), "utf8")) as Partial<HookApprovals>;
    if (raw.schema_version === 1 && typeof raw.approved === "object" && raw.approved !== null) return { schema_version: 1, approved: raw.approved };
  } catch {
    // Missing or unreadable: nothing approved.
  }
  return { schema_version: 1, approved: {} };
}

async function writeHookApprovals(home: string, approvals: HookApprovals): Promise<void> {
  const file = approvalsFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/** What an approval binds to: the hook definitions and the plugin directory (a new version re-asks). */
export function hookDigest(config: HookConfig, root: string): string {
  return sha256(canonicalJson({ root: path.resolve(root), hooks: config }));
}

export async function approveHooks(home: string, key: string, digest: string, now: Date = new Date()): Promise<void> {
  const current = await readHookApprovals(home);
  await writeHookApprovals(home, { schema_version: 1, approved: { ...current.approved, [key]: { digest, approved_at: now.toISOString() } } });
}

export async function revokeHooks(home: string, key: string): Promise<boolean> {
  const current = await readHookApprovals(home);
  if (current.approved[key] === undefined) return false;
  const approved = { ...current.approved };
  delete approved[key];
  await writeHookApprovals(home, { schema_version: 1, approved });
  return true;
}

// ---- sources -------------------------------------------------------------------------------------

export type HookOrigin = "user" | "synorch" | "claude";
/** `active` runs; `pending` was never approved; `changed` was approved for other definitions. */
export type HookSourceState = "active" | "pending" | "changed";

export interface HookSource {
  /** `user`, or the plugin key (`name`, Claude's `name@marketplace`). */
  readonly key: string;
  readonly origin: HookOrigin;
  readonly config: HookConfig;
  readonly digest: string;
  readonly state: HookSourceState;
  readonly pluginRoot: string | undefined;
  readonly pluginData: string | undefined;
}

export interface HookPluginInput {
  readonly key: string;
  readonly origin: "synorch" | "claude";
  readonly root: string;
  readonly data: string;
  readonly config: HookConfig;
}

export function hookSources(input: { readonly user: HookConfig; readonly plugins: readonly HookPluginInput[]; readonly approvals: HookApprovals }): HookSource[] {
  const sources: HookSource[] = [];
  if (hookCount(input.user) > 0) sources.push({ key: "user", origin: "user", config: input.user, digest: hookDigest(input.user, "."), state: "active", pluginRoot: undefined, pluginData: undefined });
  for (const plugin of input.plugins) {
    if (hookCount(plugin.config) === 0) continue;
    const digest = hookDigest(plugin.config, plugin.root);
    const approved = input.approvals.approved[plugin.key]?.digest;
    const state: HookSourceState = approved === undefined ? "pending" : approved === digest ? "active" : "changed";
    sources.push({ key: plugin.key, origin: plugin.origin, config: plugin.config, digest, state, pluginRoot: plugin.root, pluginData: plugin.data });
  }
  return sources;
}

// ---- running -------------------------------------------------------------------------------------

export const HOOK_OUTPUT_LIMIT = 64 * 1024;
export const HOOK_DEFAULT_TIMEOUT_SECONDS = 60;
export const HOOK_PROMPT_TIMEOUT_SECONDS = 30;
export const HOOK_MAX_TIMEOUT_SECONDS = 600;

export interface HookProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | undefined;
}

export type HookProcessRunner = (hook: HookCommand, stdin: string, options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly signal: AbortSignal }) => Promise<HookProcessResult>;

function windowsBash(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter((root): root is string => root !== undefined);
  for (const root of roots) {
    const candidate = path.join(root, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Runs one command hook: exec form (`args` set) spawns `command` directly; shell form goes to
 * `SYNORCH_HOOK_SHELL`, else `/bin/sh -c` (Git Bash on Windows when installed, cmd otherwise).
 * Output beyond `HOOK_OUTPUT_LIMIT` per stream is dropped; the timeout kills the process.
 */
export const defaultHookProcessRunner: HookProcessRunner = (hook, stdin, options) =>
  new Promise((resolve) => {
    const shell = options.env.SYNORCH_HOOK_SHELL;
    let file: string;
    let args: string[];
    let useShell = false;
    if (hook.args !== undefined) {
      file = hook.command;
      args = [...hook.args];
    } else if (shell !== undefined && shell !== "") {
      file = shell;
      args = ["-c", hook.command];
    } else if (process.platform === "win32") {
      const bash = windowsBash(options.env);
      if (bash !== undefined) {
        file = bash;
        args = ["-c", hook.command];
      } else {
        file = hook.command;
        args = [];
        useShell = true;
      }
    } else {
      file = "/bin/sh";
      args = ["-c", hook.command];
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (result: HookProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: useShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const abort = (): void => {
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < HOOK_OUTPUT_LIMIT) stdout += chunk.toString("utf8").slice(0, HOOK_OUTPUT_LIMIT - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < HOOK_OUTPUT_LIMIT) stderr += chunk.toString("utf8").slice(0, HOOK_OUTPUT_LIMIT - stderr.length);
    });
    child.on("error", (error) => done({ code: null, stdout, stderr, timedOut, error: error.message }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut, error: undefined }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });

export interface HookRunContext {
  readonly sessionId: string;
  readonly cwd: string;
  /** Synorch's permission mode (sent as Claude's `permission_mode`). */
  readonly permissionMode: string | undefined;
  /** The step runs on a Claude Code native route: Claude-sourced hooks are skipped (Claude runs them). */
  readonly claudeNative: boolean;
  /** Only these origins run (the Claude-native built-in tool check passes `["user", "synorch"]`). */
  readonly origins?: readonly HookOrigin[];
  readonly signal: AbortSignal;
}

export interface HookOutcome {
  /** A hook blocked (exit 2, `decision: "block"`, `continue: false`, `permissionDecision: "deny"`). */
  readonly blocked: boolean;
  readonly reason: string | undefined;
  /** PreToolUse `permissionDecision: "ask"`: an allowed call asks first. */
  readonly ask: boolean;
  /** Context for the model (additionalContext, plain stdout where Claude reads it). */
  readonly context: readonly string[];
  /** Notes for the user (systemMessage, hook errors, timeouts). */
  readonly messages: readonly string[];
  /** How many hooks ran. */
  readonly ran: number;
}

const EMPTY_OUTCOME: HookOutcome = { blocked: false, reason: undefined, ask: false, context: [], messages: [], ran: 0 };

const PERMISSION_MODES: Readonly<Record<string, string>> = { ask: "default", auto: "acceptEdits", full: "bypassPermissions", plan: "plan" };

function expand(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => variables[name] ?? whole);
}

function contextText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 8000) : undefined;
}

export interface HookEngineOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: () => readonly HookSource[];
  readonly run?: HookProcessRunner;
}

export interface HookEngine {
  /** Every hook source with its approval state. */
  sources(): readonly HookSource[];
  /** Whether any active hook is registered for the event (cheap check before building payloads). */
  has(event: HookEvent, context: Pick<HookRunContext, "claudeNative" | "origins">): boolean;
  /**
   * Runs the matching active hooks of an event in order and folds their answers. `match` is what
   * the matcher is tested against (tool names for tool events, the start source for SessionStart).
   */
  run(event: HookEvent, payload: Readonly<Record<string, unknown>>, match: readonly string[], context: HookRunContext): Promise<HookOutcome>;
}

export function createHookEngine(options: HookEngineOptions): HookEngine {
  const runProcess = options.run ?? defaultHookProcessRunner;
  const runnable = (source: HookSource, context: Pick<HookRunContext, "claudeNative" | "origins">): boolean =>
    source.state === "active" && !(context.claudeNative && source.origin === "claude") && (context.origins === undefined || context.origins.includes(source.origin));
  return {
    sources: options.sources,
    has(event, context) {
      return options.sources().some((source) => runnable(source, context) && (source.config[event]?.length ?? 0) > 0);
    },
    async run(event, payload, match, context) {
      const selected: { source: HookSource; hook: HookCommand }[] = [];
      const seen = new Set<string>();
      for (const source of options.sources()) {
        if (!runnable(source, context)) continue;
        for (const group of source.config[event] ?? []) {
          if (event !== "UserPromptSubmit" && event !== "Stop" && !matcherMatches(group.matcher, match)) continue;
          for (const hook of group.hooks) {
            const identity = `${source.key}\u0000${hook.command}\u0000${(hook.args ?? []).join("\u0000")}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            selected.push({ source, hook });
          }
        }
      }
      if (selected.length === 0) return EMPTY_OUTCOME;
      const context_: string[] = [];
      const messages: string[] = [];
      let blocked = false;
      let reason: string | undefined;
      let ask = false;
      const input = canonicalJson({
        session_id: context.sessionId,
        transcript_path: "",
        cwd: context.cwd,
        permission_mode: PERMISSION_MODES[context.permissionMode ?? ""] ?? "default",
        hook_event_name: event,
        ...payload,
      });
      for (const { source, hook } of selected) {
        if (context.signal.aborted) break;
        const variables: Record<string, string> = { CLAUDE_PROJECT_DIR: context.cwd };
        if (source.pluginRoot !== undefined) variables.CLAUDE_PLUGIN_ROOT = source.pluginRoot;
        if (source.pluginData !== undefined) variables.CLAUDE_PLUGIN_DATA = source.pluginData;
        const slash = (value: string): string => (process.platform === "win32" ? value.replaceAll("\\", "/") : value);
        const shellVariables = Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, hook.args === undefined ? slash(value) : value]));
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(options.env)) if (value !== undefined) env[name] = value;
        Object.assign(env, variables, { SYNORCH_HOOK_EVENT: event, SYNORCH_HOOK_SOURCE: source.key });
        const seconds = Math.min(HOOK_MAX_TIMEOUT_SECONDS, hook.timeout ?? (event === "UserPromptSubmit" ? HOOK_PROMPT_TIMEOUT_SECONDS : HOOK_DEFAULT_TIMEOUT_SECONDS));
        const command: HookCommand = { command: expand(hook.command, shellVariables), args: hook.args?.map((arg) => expand(arg, variables)), timeout: hook.timeout };
        const label = `${event} hook (${source.key})`;
        const result = await runProcess(command, input, { cwd: context.cwd, env, timeoutMs: seconds * 1000, signal: context.signal });
        if (result.error !== undefined) {
          messages.push(`${label} could not start: ${result.error}`.slice(0, 500));
          continue;
        }
        if (result.timedOut) {
          messages.push(`${label} timed out after ${seconds} s`);
          continue;
        }
        let json: Record<string, unknown> | undefined;
        const trimmed = result.stdout.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
          } catch {
            json = undefined;
          }
        }
        const specific = (typeof json?.hookSpecificOutput === "object" && json.hookSpecificOutput !== null ? json.hookSpecificOutput : {}) as Record<string, unknown>;
        const system = contextText(json?.systemMessage);
        if (system !== undefined) messages.push(`${label}: ${system}`);
        const additional = contextText(specific.additionalContext);
        if (additional !== undefined) context_.push(additional);
        const block = (why: string | undefined): void => {
          blocked = true;
          reason ??= (why ?? `blocked by ${label}`).trim().slice(0, 2000);
        };
        if (result.code === 2) {
          const why = contextText(result.stderr) ?? contextText(json?.reason) ?? contextText(specific.permissionDecisionReason);
          if (event === "PostToolUse") context_.push(why ?? `${label} reported a problem`);
          else block(why);
          continue;
        }
        if (result.code !== 0) {
          messages.push(`${label} failed (exit ${result.code ?? "?"})${contextText(result.stderr) === undefined ? "" : `: ${contextText(result.stderr)?.slice(0, 300)}`}`);
          continue;
        }
        if (json === undefined) {
          if ((event === "SessionStart" || event === "UserPromptSubmit") && trimmed !== "") context_.push(trimmed.slice(0, 8000));
          continue;
        }
        const permission = specific.permissionDecision;
        if (json.continue === false) block(contextText(json.stopReason) ?? contextText(json.reason));
        else if (json.decision === "block") {
          if (event === "PostToolUse") context_.push(contextText(json.reason) ?? `${label} flagged this result`);
          else block(contextText(json.reason));
        } else if (event === "PreToolUse" && (permission === "deny" || json.decision === "deny")) block(contextText(specific.permissionDecisionReason) ?? contextText(json.reason));
        else if (event === "PreToolUse" && permission === "ask") ask = true;
        if (blocked && event !== "PostToolUse") break;
      }
      return { blocked, reason, ask: ask && !blocked, context: context_, messages, ran: selected.length };
    },
  };
}
