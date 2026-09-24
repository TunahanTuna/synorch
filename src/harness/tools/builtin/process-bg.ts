import { z } from "zod";
import type { AgentRole, BackgroundChild, BackgroundExit, Tool, ToolExecutionContext, ToolResult } from "../../contracts/index.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, okResult } from "./shared.ts";

/**
 * K4.2 background processes: `exec` with `background: true` starts a child through the sandbox
 * runner (`SandboxRunner.start`) after the normal exec policy decision and registers it here; the
 * `process_*` tools read its output, wait for it, list and stop it. Each process belongs to the
 * attempt (or the conversation) that started it; only that owner sees it. The manager kills every
 * tree when the session ends.
 */

/** Output kept per process; older output is dropped (the cursor keeps counting). */
const BUFFER_CHARS = 2 * 1024 * 1024;
/** What one process_output / process_wait shows inline; the full new output goes to a blob. */
const INLINE_CHARS = 12 * 1024;
const SESSION_OWNER = "session";

export type BackgroundState = "running" | "exited" | "killed" | "timeout" | "failed";

export interface BackgroundProcessInfo {
  readonly handle: string;
  readonly name: string | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number | undefined;
  readonly owner: string;
  readonly role: AgentRole;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly state: BackgroundState;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Total characters of output produced so far (the cursor of the newest output). */
  readonly outputChars: number;
}

export interface BackgroundOutput {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  /** Characters between `since` and `from` that were dropped from the buffer. */
  readonly dropped: number;
}

interface Managed {
  info: BackgroundProcessInfo;
  readonly child: BackgroundChild;
  chunks: string[];
  base: number;
  size: number;
  readCursor: number;
  readonly waiters: Set<() => void>;
}

export type BackgroundListener = (info: BackgroundProcessInfo, change: "started" | "ended") => void;

export class BackgroundProcessManager {
  private readonly processes = new Map<string, Managed>();
  private readonly listeners = new Set<BackgroundListener>();
  private counter = 0;
  private readonly now: () => number;

  public constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  public register(child: BackgroundChild, meta: { readonly name: string | undefined; readonly command: string; readonly cwd: string; readonly owner: string; readonly role: AgentRole }): BackgroundProcessInfo {
    this.counter += 1;
    const handle = `p${this.counter}`;
    const managed: Managed = {
      info: { handle, ...meta, pid: child.pid, startedAt: this.now(), endedAt: undefined, state: "running", exitCode: null, signal: null, outputChars: 0 },
      child,
      chunks: [],
      base: 0,
      size: 0,
      readCursor: 0,
      waiters: new Set(),
    };
    this.processes.set(handle, managed);
    child.onOutput((chunk) => this.append(managed, chunk));
    void child.exited.then((exit) => this.ended(managed, exit));
    queueMicrotask(() => {
      managed.info = { ...managed.info, pid: child.pid };
      this.emit(managed.info, "started");
    });
    return managed.info;
  }

  public onChange(listener: BackgroundListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every process (newest first), or only `owner`'s. */
  public list(owner?: string): BackgroundProcessInfo[] {
    return [...this.processes.values()].filter((entry) => owner === undefined || entry.info.owner === owner).map((entry) => this.current(entry)).reverse();
  }

  public running(owner?: string): BackgroundProcessInfo[] {
    return this.list(owner).filter((info) => info.state === "running");
  }

  public get(handle: string, owner?: string): BackgroundProcessInfo | undefined {
    const entry = this.processes.get(handle);
    return entry === undefined || (owner !== undefined && entry.info.owner !== owner) ? undefined : this.current(entry);
  }

  /** Output from `since` (default: where the last read stopped) to now; advances the read cursor. */
  public output(handle: string, since?: number): BackgroundOutput | undefined {
    const entry = this.processes.get(handle);
    if (entry === undefined) return undefined;
    const end = entry.base + entry.size;
    const wanted = Math.min(Math.max(0, since ?? entry.readCursor), end);
    const from = Math.max(wanted, entry.base);
    const text = entry.chunks.join("").slice(from - entry.base);
    entry.readCursor = end;
    return { text, from, to: end, dropped: from - wanted };
  }

  /** Resolves when the process has new output past `cursor`, has ended, or `ms` passed. */
  public async waitForOutput(handle: string, cursor: number, ms: number, signal: AbortSignal): Promise<void> {
    const entry = this.processes.get(handle);
    if (entry === undefined || ms <= 0 || entry.info.state !== "running" || entry.base + entry.size > cursor) return;
    await this.park(entry, ms, signal, () => entry.base + entry.size > cursor || entry.info.state !== "running");
  }

  /** Resolves when the process ended or `ms` passed. */
  public async waitForExit(handle: string, ms: number, signal: AbortSignal): Promise<void> {
    const entry = this.processes.get(handle);
    if (entry === undefined || entry.info.state !== "running") return;
    await this.park(entry, ms, signal, () => entry.info.state !== "running");
  }

  public async kill(handle: string): Promise<BackgroundProcessInfo | undefined> {
    const entry = this.processes.get(handle);
    if (entry === undefined) return undefined;
    if (entry.info.state === "running") {
      entry.info = { ...entry.info, state: "killed" };
      await entry.child.kill();
      await Promise.race([entry.child.exited, delay(3_000)]);
    }
    return this.current(entry);
  }

  /** Kills every running process (or `owner`'s); resolves with how many were running. */
  public async killAll(owner?: string): Promise<number> {
    const targets = this.running(owner);
    await Promise.all(targets.map((info) => this.kill(info.handle)));
    return targets.length;
  }

  /** Process-exit fallback: synchronous tree kill of everything still running. */
  public killAllSync(): void {
    for (const entry of this.processes.values()) {
      if (entry.info.state !== "running") continue;
      entry.info = { ...entry.info, state: "killed" };
      try {
        entry.child.killSync();
      } catch {
        // Best effort at exit.
      }
    }
  }

  private current(entry: Managed): BackgroundProcessInfo {
    return { ...entry.info, pid: entry.child.pid ?? entry.info.pid, outputChars: entry.base + entry.size };
  }

  private append(entry: Managed, chunk: string): void {
    entry.chunks.push(chunk);
    entry.size += chunk.length;
    while (entry.size > BUFFER_CHARS && entry.chunks.length > 1) {
      const dropped = entry.chunks.shift() ?? "";
      entry.size -= dropped.length;
      entry.base += dropped.length;
    }
    if (entry.size > BUFFER_CHARS) {
      const only = entry.chunks[0] ?? "";
      const cut = only.length - BUFFER_CHARS;
      entry.chunks[0] = only.slice(cut);
      entry.size -= cut;
      entry.base += cut;
    }
    this.wake(entry);
  }

  private ended(entry: Managed, exit: BackgroundExit): void {
    const state: BackgroundState =
      entry.info.state === "killed" || exit.termination === "cancelled" ? "killed" : exit.termination === "timeout" ? "timeout" : exit.termination === "spawn-failed" ? "failed" : "exited";
    if (exit.termination === "spawn-failed" && exit.spawnError !== undefined) this.append(entry, `failed to start: ${exit.spawnError}\n`);
    entry.info = { ...entry.info, state, exitCode: exit.exitCode, signal: exit.signal, endedAt: this.now() };
    this.wake(entry);
    this.emit(this.current(entry), "ended");
  }

  private emit(info: BackgroundProcessInfo, change: "started" | "ended"): void {
    for (const listener of this.listeners) {
      try {
        listener(info, change);
      } catch {
        // A view listener never breaks the process bookkeeping.
      }
    }
  }

  private wake(entry: Managed): void {
    for (const waiter of [...entry.waiters]) waiter();
  }

  private park(entry: Managed, ms: number, signal: AbortSignal, done: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || done()) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        entry.waiters.delete(check);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const check = (): void => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, ms);
      entry.waiters.add(check);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export function ownerOf(context: Pick<ToolExecutionContext, "attemptId">): string {
  return context.attemptId ?? SESSION_OWNER;
}

export function formatElapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `p1 · dev server (pnpm dev) · running · 12s · pid 4242` */
export function describeProcess(info: BackgroundProcessInfo, now: number = Date.now()): string {
  const label = info.name === undefined ? info.command : `${info.name} (${info.command})`;
  const elapsed = formatElapsedShort((info.endedAt ?? now) - info.startedAt);
  const status =
    info.state === "running"
      ? "running"
      : info.state === "exited"
        ? `exited ${info.exitCode ?? info.signal ?? "?"}`
        : info.state === "killed"
          ? "stopped"
          : info.state === "timeout"
            ? "timed out (stopped)"
            : "failed to start";
  return `${info.handle} · ${label} · ${status} · ${elapsed}${info.pid === undefined ? "" : ` · pid ${info.pid}`}`;
}

/** The model-facing output window: a header, then at most INLINE_CHARS of the newest output (the rest in a blob). */
async function outputResult(info: BackgroundProcessInfo, output: BackgroundOutput, context: ToolExecutionContext, extraHeader?: string): Promise<ToolResult> {
  const lines = [describeProcess(info)];
  if (extraHeader !== undefined) lines.push(extraHeader);
  const dropped = output.dropped > 0 ? ` (${output.dropped} older chars were dropped from the buffer)` : "";
  if (output.text.length === 0) {
    lines.push(`no new output (cursor ${output.to})${dropped}`);
    return okResult(lines.join("\n"), exitOf(info));
  }
  const clipped = output.text.length > INLINE_CHARS;
  const shown = clipped ? output.text.slice(-INLINE_CHARS) : output.text;
  lines.push(`output ${output.from}-${output.to}${dropped}${clipped ? `; showing the last ${INLINE_CHARS} chars, the full new output is in the result blob` : ""} · next read: since=${output.to}`);
  const blob = clipped ? await context.blobs.put(new Uint8Array(Buffer.from(output.text, "utf8")), "text/plain; charset=utf-8") : undefined;
  return okResult(`${lines.join("\n")}\n${shown.replace(/\s+$/, "")}`, { truncated: clipped, ...exitOf(info), ...(blob === undefined ? {} : { blob }) });
}

function exitOf(info: BackgroundProcessInfo): { exit_code?: number } {
  return info.state === "exited" && info.exitCode !== null ? { exit_code: info.exitCode } : {};
}

/** The start result of `exec` with `background: true`: waits briefly so an immediate crash or the first lines are visible. */
export async function backgroundStartResult(manager: BackgroundProcessManager, info: BackgroundProcessInfo, context: ToolExecutionContext, settleMs: number): Promise<ToolResult> {
  await manager.waitForExit(info.handle, settleMs, context.signal);
  const current = manager.get(info.handle) ?? info;
  const output = manager.output(info.handle, 0) ?? { text: "", from: 0, to: 0, dropped: 0 };
  const hint =
    current.state === "running"
      ? `started in the background as ${info.handle}; read new output with process_output("${info.handle}"), wait with process_wait, stop with process_kill. It is stopped when the session ends.`
      : `the process ended within ${Math.round(settleMs / 1000)}s of starting`;
  const result = await outputResult(current, output, context, hint);
  if (current.state === "failed") return errorResult("execution_failed", output.text.trim() || `failed to start ${current.command}`, { text: result.text });
  return result;
}

const PROCESS_ROLES: AgentRole[] = ["implementer", "debugger", "reviewer", "session"];
const handleSchema = z.string().regex(/^p\d{1,6}$/, "a process handle looks like p1");

const outputInput = z.strictObject({
  handle: handleSchema,
  since: z.int().min(0).optional(),
  wait_ms: z.int().min(0).max(30_000).default(0),
});
type OutputInput = z.infer<typeof outputInput>;

const waitInput = z.strictObject({
  handle: handleSchema,
  timeout_ms: z.int().min(100).max(600_000).default(60_000),
});
type WaitInput = z.infer<typeof waitInput>;

const killInput = z.strictObject({ handle: handleSchema });
type KillInput = z.infer<typeof killInput>;

const listInput = z.strictObject({});
type ListInput = z.infer<typeof listInput>;

function unknownHandle(handle: string): ToolResult {
  return errorResult("invalid_arguments", `no background process ${handle} in this session; process_list shows the running ones`);
}

export function createProcessTools(manager: BackgroundProcessManager): Tool[] {
  const outputMeta = builtinMetadata({
    name: "process_output",
    description:
      "Read new output of a background process started with exec {background: true}. Returns what arrived since the last read (or since `since`, a cursor from an earlier result); `wait_ms` waits up to that long for new output first.",
    effect: "read",
    idempotent: false,
    network: "none",
    output_limit_bytes: 1024 * 1024,
    timeout_ms: 60_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: PROCESS_ROLES,
  });
  const waitMeta = builtinMetadata({
    name: "process_wait",
    description: "Wait until a background process exits (or timeout_ms passes) and return its status and new output. Does not stop it.",
    effect: "read",
    idempotent: false,
    network: "none",
    output_limit_bytes: 1024 * 1024,
    timeout_ms: 610_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: PROCESS_ROLES,
  });
  const killMeta = builtinMetadata({
    name: "process_kill",
    description: "Stop a background process and everything it started (the whole process tree).",
    effect: "control",
    idempotent: true,
    network: "none",
    output_limit_bytes: 64 * 1024,
    timeout_ms: 30_000,
    cancellable: false,
    concurrency: "parallel",
    visible_to: PROCESS_ROLES,
  });
  const listMeta = builtinMetadata({
    name: "process_list",
    description: "List the background processes of this session: handle, command, state, elapsed time.",
    effect: "read",
    idempotent: true,
    network: "none",
    output_limit_bytes: 64 * 1024,
    timeout_ms: 10_000,
    cancellable: true,
    concurrency: "parallel",
    visible_to: PROCESS_ROLES,
  });
  return [
    defineTool<OutputInput>(outputMeta, outputInput, {
      normalize: async (input, context) => actionOf(outputMeta, input, context),
      async execute(input, context) {
        const info = manager.get(input.handle, ownerOf(context));
        if (info === undefined) return unknownHandle(input.handle);
        const before = manager.output(input.handle, input.since ?? undefined);
        if (before === undefined) return unknownHandle(input.handle);
        if (before.text.length > 0 || input.wait_ms === 0) return outputResult(manager.get(input.handle) ?? info, before, context);
        await manager.waitForOutput(input.handle, before.to, input.wait_ms, context.signal);
        const after = manager.output(input.handle, before.from) ?? before;
        return outputResult(manager.get(input.handle) ?? info, { ...after, dropped: after.dropped + before.dropped }, context);
      },
    }) as Tool,
    defineTool<WaitInput>(waitMeta, waitInput, {
      normalize: async (input, context) => actionOf(waitMeta, input, context),
      async execute(input, context) {
        const info = manager.get(input.handle, ownerOf(context));
        if (info === undefined) return unknownHandle(input.handle);
        await manager.waitForExit(input.handle, input.timeout_ms, context.signal);
        const current = manager.get(input.handle) ?? info;
        const output = manager.output(input.handle) ?? { text: "", from: 0, to: 0, dropped: 0 };
        const note = current.state === "running" ? (context.signal.aborted ? "wait cancelled; still running" : `still running after ${Math.round(input.timeout_ms / 1000)}s`) : undefined;
        return outputResult(current, output, context, note);
      },
    }) as Tool,
    defineTool<KillInput>(killMeta, killInput, {
      normalize: async (input, context) => actionOf(killMeta, input, context),
      async execute(input, context) {
        const info = manager.get(input.handle, ownerOf(context));
        if (info === undefined) return unknownHandle(input.handle);
        if (info.state !== "running") return okResult(`${describeProcess(info)}\n(already ended; nothing to stop)`);
        const stopped = (await manager.kill(input.handle)) ?? info;
        return okResult(`stopped ${describeProcess(stopped)}`);
      },
    }) as Tool,
    defineTool<ListInput>(listMeta, listInput, {
      normalize: async (input, context) => actionOf(listMeta, input, context),
      async execute(_input, context) {
        const all = manager.list(ownerOf(context));
        if (all.length === 0) return okResult("no background processes");
        return okResult(all.map((info) => describeProcess(info)).join("\n"));
      },
    }) as Tool,
  ];
}
