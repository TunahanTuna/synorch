import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerStatus } from "../mcp/index.ts";

/**
 * A clean first screen: welcome, the first-run setup, then at most two short notice lines. Notices
 * raised while the session starts are held until the setup is done (and MCP servers had a moment to
 * settle), then shown; more than two collapse into one "N notices · /status" line. Everything stays
 * readable in `/status`.
 */

export interface StartupNotice {
  readonly level: "info" | "warning";
  readonly text: string;
  readonly context?: boolean;
}

const MAX_LINES = 2;

export class StartupNotices {
  private readonly held: StartupNotice[] = [];
  private readonly seen: StartupNotice[] = [];
  private open = true;
  private readonly emit: (notice: StartupNotice) => void;
  private readonly sep: string;

  public constructor(emit: (notice: StartupNotice) => void, sep: string) {
    this.emit = emit;
    this.sep = sep;
  }

  /** Every notice of this session start, for `/status`. */
  public get all(): readonly StartupNotice[] {
    return this.seen.filter((notice) => notice.context !== true);
  }

  public add(notice: StartupNotice): void {
    this.seen.push(notice);
    if (this.open) this.held.push(notice);
    else this.emit(notice);
  }

  public flush(): void {
    if (!this.open) return;
    this.open = false;
    const all = this.held.splice(0);
    // Context lines (the project profile, the memory summary) are the quiet status, not notices.
    for (const notice of all) if (notice.context === true) this.emit(notice);
    const held = all.filter((notice) => notice.context !== true);
    if (held.length <= MAX_LINES) {
      for (const notice of held) this.emit(notice);
      return;
    }
    this.emit({ level: held.some((notice) => notice.level === "warning") ? "warning" : "info", text: `${held.length} notices ${this.sep} /status` });
  }
}

function names(list: readonly string[], limit = 3): string {
  return list.length <= limit ? list.join(", ") : `${list.slice(0, limit).join(", ")} +${list.length - limit}`;
}

function commands(verb: string, list: readonly string[]): string {
  return list.length <= 2 ? list.map((name) => `/mcp ${verb} ${name}`).join(", ") : `/mcp ${verb} <name> (/mcp lists them)`;
}

/** Project servers waiting for approval, as one line with the real command. */
export function approvalNotice(pending: readonly string[], sep: string): StartupNotice | undefined {
  if (pending.length === 0) return undefined;
  return { level: "info", text: `MCP ${names(pending)} (this repo) ${pending.length === 1 ? "is" : "are"} off until approved ${sep} ${commands("approve", pending)}` };
}

/** After the session's MCP start: one dim line for every server needing sign-in, one line for failures. */
export function mcpStartNotices(status: readonly McpServerStatus[], sep: string): StartupNotice[] {
  const notices: StartupNotice[] = [];
  const signIn = status.filter((entry) => entry.state === "needs-auth").map((entry) => entry.name);
  if (signIn.length > 0) notices.push({ level: "info", text: `${names(signIn)} ${signIn.length === 1 ? "needs" : "need"} sign-in ${sep} ${commands("login", signIn)}` });
  const failed = status.filter((entry) => entry.state === "failed");
  const [only] = failed;
  if (failed.length === 1 && only !== undefined) notices.push({ level: "warning", text: `MCP ${only.name} did not start: ${only.error ?? "unknown error"} ${sep} /mcp ${only.name}` });
  else if (failed.length > 1) notices.push({ level: "warning", text: `MCP ${names(failed.map((entry) => entry.name))} did not start ${sep} /mcp` });
  return notices;
}

// ---- once-per-machine acknowledgements (user state) ---------------------------------------------

const NOTICE_STATE_FILE = path.join("state", "notices.json");

export type AcknowledgedNotice = "sandbox-partial";

export async function acknowledgedNotices(home: string): Promise<ReadonlySet<string>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, NOTICE_STATE_FILE), "utf8")) as { acknowledged?: unknown };
    return new Set(Array.isArray(parsed.acknowledged) ? parsed.acknowledged.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export async function acknowledgeNotice(home: string, id: AcknowledgedNotice): Promise<void> {
  try {
    const current = await acknowledgedNotices(home);
    if (current.has(id)) return;
    const file = path.join(home, NOTICE_STATE_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ acknowledged: [...current, id] }, null, 2)}\n`, "utf8");
  } catch {
    // A notice shown twice is harmless.
  }
}
