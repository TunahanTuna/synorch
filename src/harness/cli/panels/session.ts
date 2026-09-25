import type { PanelAction, PanelActionResult, PanelBlock, PanelField, PanelItem, PanelPage, PanelTone, PanelView } from "../../contracts/index.ts";
import { documentPage } from "../../contracts/index.ts";
import type { HarnessView, OrchestrationTaskView, OrchestrationView } from "../../contracts/views.ts";
import type { SettingRow } from "../config-command.ts";
import { ledgerView, memorySeam, runMemoryDesk, type MemoryDeskHost } from "../memory-desk.ts";
import type { SlashCommand } from "../slash-commands.ts";
import { captured, outcome, plural } from "./common.ts";
import { mcpServerItem, type McpPanelHost } from "./mcp.ts";

/**
 * Panels of the session commands: `/help`, `/status`, `/config`, `/resume`, `/runs`, `/memory`,
 * `/usage` and `/context`. Each takes the data its text form already builds, so the text and the
 * panel never disagree; the conversation passes the data in.
 */

// ---- /help ---------------------------------------------------------------------------------------

export interface InvocableEntry {
  readonly name: string;
  readonly description: string;
  readonly argsHint: string | undefined;
  readonly source: string;
}

function runCommandAction(name: string, argsHint: string | undefined): PanelAction {
  const needsArgument = argsHint !== undefined && argsHint.trim().startsWith("<");
  return { key: "r", label: needsArgument ? "type it" : "run", run: () => (needsArgument ? { editorText: `${name} ` } : { command: name }) };
}

export function helpPanel(commands: readonly SlashCommand[], invocable: readonly InvocableEntry[], keys: string, sep: string): PanelPage {
  const commandItems: PanelItem[] = commands.map((command) => ({
    id: command.name,
    label: command.name,
    ...(command.argsHint === undefined ? {} : { meta: command.argsHint }),
    description: command.description,
    search: (command.aliases ?? []).join(" "),
    open: () =>
      documentPage(command.name, [
        {
          kind: "fields",
          rows: [
            { label: "command", value: `${command.name}${command.argsHint === undefined ? "" : ` ${command.argsHint}`}` },
            ...(command.aliases === undefined ? [] : [{ label: "aliases", value: command.aliases.join(", ") }]),
            { label: "while working", value: command.whileBusy === true ? "runs at once" : "waits for the turn to end" },
          ],
        },
        { kind: "text", text: command.description },
      ], { actions: [runCommandAction(command.name, command.argsHint)] }),
    actions: [runCommandAction(command.name, command.argsHint)],
  }));
  const skillItems: PanelItem[] = invocable.map((entry) => ({
    id: entry.name,
    label: `/${entry.name}`,
    meta: entry.source,
    description: entry.description,
    actions: [{ key: "r", label: "type it", primary: true, run: () => ({ editorText: `/${entry.name} ` }) }],
  }));
  const views: PanelView[] = [{ kind: "list", label: "Commands", items: commandItems }];
  if (skillItems.length > 0) views.push({ kind: "list", label: "Skills", items: skillItems });
  views.push({ kind: "document", label: "Keys", blocks: [{ kind: "text", text: keys.replace(/^Keys: /, "").split(` ${sep} `).join("\n") }] });
  return { title: "Help", subtitle: `${plural(commands.length, "command")} ${sep} Enter shows one ${sep} r runs it`, views };
}

// ---- /status ---------------------------------------------------------------------------------------

/** `Label           value` report lines (continuations indented) as fields. */
export function reportFields(lines: readonly string[], column = 16): PanelField[] {
  const rows: { label: string; value: string }[] = [];
  for (const line of lines) {
    const label = line.slice(0, column).trim();
    const value = line.slice(column).trim();
    if (label === "" && rows.length > 0) {
      const last = rows[rows.length - 1] as { label: string; value: string };
      last.value = last.value === "" ? value : `${last.value}\n${value}`;
    } else rows.push({ label, value });
  }
  return rows;
}

export function statusPanel(lines: readonly string[], mcp: McpPanelHost | undefined, sep: string): PanelPage {
  const views: PanelView[] = [{ kind: "document", label: "Session", blocks: [{ kind: "fields", rows: reportFields(lines) }] }];
  if (mcp !== undefined) {
    const servers = mcp.manager.status();
    views.push({ kind: "list", label: "MCP", items: servers.map((entry) => mcpServerItem(mcp, entry)), empty: "no MCP servers configured" });
  }
  return { title: "Status", subtitle: `model, mode, sandbox, MCP and startup notices ${sep} /config changes settings`, views, reload: () => statusPanel(lines, mcp, sep) };
}

// ---- /config ---------------------------------------------------------------------------------------

export interface ConfigPanelHost {
  readonly sep: string;
  /** The settings now (undefined when the user configuration cannot be read). */
  rows(): Promise<{ readonly rows: readonly SettingRow[]; readonly userFile: string } | undefined>;
  /** Picks a new value with the choice modal and saves it; the line it printed. */
  edit(row: SettingRow): Promise<string | undefined>;
}

export async function configPanel(host: ConfigPanelHost): Promise<PanelPage> {
  const listing = await host.rows();
  const rows = listing?.rows ?? [];
  const groups = [...new Set(rows.map((row) => row.key.split(".")[0] ?? row.key))];
  const item = (row: SettingRow): PanelItem => ({
    id: row.key,
    label: row.key,
    meta: row.value ?? "(not set)",
    badges: row.source === "default" ? [] : [{ label: row.source, tone: row.source === "user" ? "accent" : "info" }],
    description: row.description,
    actions: [
      {
        key: "c",
        label: row.kind === "boolean" ? "toggle" : "change",
        primary: true,
        run: async (): Promise<PanelActionResult> => {
          const line = await host.edit(row);
          return line === undefined ? {} : { message: line, level: /^\S*\s*(!|error)/i.test(line) ? "warning" : "success", refresh: true };
        },
      },
    ],
  });
  const views: PanelView[] = [{ kind: "list", label: "All", items: rows.map(item), empty: "the user configuration cannot be read: fix it with syn config edit" }];
  for (const group of groups) views.push({ kind: "list", label: group, items: rows.filter((row) => (row.key.split(".")[0] ?? row.key) === group).map(item) });
  return { title: "Settings", crumb: "Config", subtitle: `Enter changes ${host.sep} saved to ${listing?.userFile ?? "your user config"}`, views, reload: () => configPanel(host) };
}

// ---- /resume ---------------------------------------------------------------------------------------

export interface ResumeEntry {
  readonly sessionId: string;
  readonly title: string;
  readonly when: string;
  readonly forkOf: string | undefined;
}

export function resumePanel(entries: readonly ResumeEntry[], sep: string): PanelPage {
  const items: PanelItem[] = entries.map((entry) => ({
    id: entry.sessionId,
    label: entry.title === "" ? "(untitled)" : entry.title,
    meta: entry.when,
    ...(entry.forkOf === undefined ? {} : { badges: [{ label: "fork", tone: "info" as PanelTone }], description: `fork of ${entry.forkOf}` }),
    search: entry.sessionId,
    actions: [{ key: "r", label: "resume", primary: true, run: () => ({ command: `/resume ${entry.sessionId}` }) }],
  }));
  return { title: "Resume", subtitle: `recent conversations in this folder ${sep} Enter switches ${sep} this one stays saved`, views: [{ kind: "list", label: "Conversations", items, empty: "No other conversations in this folder." }] };
}

// ---- /runs -----------------------------------------------------------------------------------------

export interface RunEntry {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
  readonly running: boolean;
  view(): OrchestrationView;
  /** The run's status report (`/runs <id>`). */
  report(): string;
  cancel(): void;
}

function elapsed(task: OrchestrationTaskView): string | undefined {
  const ms = task.elapsedMs ?? (task.startedAtMs === undefined ? undefined : (task.endedAtMs ?? Date.now()) - task.startedAtMs);
  return ms === undefined ? undefined : `${Math.round(ms / 1000)}s`;
}

function taskTone(state: string): PanelTone {
  return state === "completed" ? "success" : state === "failed" || state === "blocked" ? "error" : state === "cancelled" ? "muted" : "accent";
}

function taskPage(task: OrchestrationTaskView): PanelPage {
  const rows: PanelField[] = [
    { label: "task", value: task.key },
    { label: "role", value: task.role },
    ...(task.model === undefined ? [] : [{ label: "model", value: task.model }]),
    { label: "state", value: `${task.state}${task.paused === true ? " (paused)" : ""}`, tone: taskTone(task.state) },
    ...(task.activity === undefined ? [] : [{ label: "activity", value: task.activity }]),
    ...(task.summary === undefined ? [] : [{ label: "outcome", value: task.summary }]),
    ...(task.reason === undefined ? [] : [{ label: "why", value: task.reason, tone: "warning" as PanelTone }]),
    ...(task.dependsOn === undefined || task.dependsOn.length === 0 ? [] : [{ label: "after", value: task.dependsOn.join(", ") }]),
    ...(elapsed(task) === undefined ? [] : [{ label: "elapsed", value: elapsed(task) as string }]),
    ...(task.diffstat === undefined ? [] : [{ label: "changes", value: `${plural(task.diffstat.files, "file")} +${task.diffstat.added} -${task.diffstat.removed}` }]),
    ...(task.checks === undefined ? [] : [{ label: "checks", value: `${task.checks.passed}/${task.checks.total} passed (run by Synorch)` }]),
    ...(task.review === undefined ? [] : [{ label: "review", value: `${task.review.verdict}${task.review.reviewer === undefined ? "" : ` by ${task.review.reviewer}`}${task.review.revisions === undefined ? "" : `, ${plural(task.review.revisions, "revision")}`}` }]),
  ];
  return documentPage(task.key, [{ kind: "fields", rows }], { subtitle: `${task.role} ${task.model ?? ""}`.trim(), actions: [{ key: "w", label: "worker view", run: () => ({ command: `/worker ${task.key}` }) }] });
}

function runPage(run: RunEntry, sep: string): PanelPage {
  const view = run.view();
  const tasks: PanelItem[] = view.tasks.map((task) => ({
    id: task.key,
    label: task.key,
    meta: task.role,
    badges: [{ label: task.state, tone: taskTone(task.state) }],
    description: task.summary ?? task.activity ?? task.reason ?? "",
    open: () => taskPage(task),
  }));
  const actions: PanelAction[] = run.running ? [{ key: "c", label: "cancel run", confirm: `Stop the workers of ${run.id}?`, run: () => (run.cancel(), { message: `stopping ${run.id}…`, level: "warning", refresh: true }) }] : [];
  return {
    title: run.id,
    subtitle: `${run.status} ${sep} ${run.goal.replace(/\s+/g, " ").slice(0, 200)}`,
    views: [
      { kind: "list", label: "Tasks", items: tasks, empty: "no tasks planned yet" },
      { kind: "document", label: "Board", blocks: [{ kind: "view", view }] },
      { kind: "document", label: "Report", blocks: [{ kind: "text", text: run.report() }] },
    ],
    actions,
    reload: () => runPage(run, sep),
  };
}

export function runsPanel(runs: () => readonly RunEntry[], sep: string): PanelPage {
  const list = runs();
  const items: PanelItem[] = list.map((run) => {
    const view = run.view();
    const done = view.tasks.filter((task) => task.state === "completed").length;
    return {
      id: run.id,
      label: run.id,
      meta: `${done}/${view.tasks.length} tasks`,
      badges: [{ label: run.status, tone: run.running ? "accent" : run.status === "succeeded" ? "success" : run.status === "cancelled" ? "muted" : "error" }],
      description: run.goal.replace(/\s+/g, " "),
      open: () => runPage(run, sep),
    };
  });
  return { title: "Worker runs", crumb: "Runs", subtitle: `${list.filter((run) => run.running).length} running ${sep} Ctrl+G board/graph`, views: [{ kind: "list", label: "Runs", items, empty: "No worker runs in this conversation yet: /workers <goal> starts one" }], reload: () => runsPanel(runs, sep) };
}

// ---- /memory ---------------------------------------------------------------------------------------

async function notePage(host: MemoryDeskHost, id: string): Promise<PanelPage> {
  const note = await memorySeam(host).note(id);
  if (note === undefined) return documentPage(id, [{ kind: "text", text: `No memory note ${id}.`, tone: "muted" }]);
  const views: PanelView[] = [
    {
      kind: "document",
      label: "Note",
      blocks: [{ kind: "fields", rows: [{ label: "id", value: note.id }, { label: "kind", value: `${note.noteKind} ${note.status}` }, ...note.frontmatter.map(([label, value]) => ({ label, value })), { label: "file", value: note.path }] }, { kind: "heading", text: note.title }, { kind: "markdown", text: note.body === "" ? "_(no text)_" : note.body }],
    },
  ];
  if (note.relations.length > 0) views.push({ kind: "list", label: "Links", items: note.relations.map((relation) => ({ id: `${relation.direction}:${relation.type}:${relation.id}`, label: relation.id, meta: `${relation.direction === "out" ? "→" : "←"} ${relation.type}`, description: relation.title ?? "", open: () => notePage(host, relation.id) })) });
  const run = async (argument: string, extra: Partial<PanelActionResult> = {}) => outcome(await captured((print) => runMemoryDesk({ ...host, print }, argument)), (line) => host.print([line]), extra);
  return {
    title: note.title,
    crumb: note.id,
    subtitle: `${note.noteKind} ${note.status}`,
    views,
    actions: [
      { key: "o", label: "open in Obsidian", run: async () => ({ message: await memorySeam(host).open(note.id) }) },
      { key: "e", label: "edit", run: () => ({ command: `/memory edit ${note.id}` }) },
      { key: "x", label: "retire", confirm: `Retire ${note.id}? It stops steering new requests (kept as history).`, run: () => run(`retire ${note.id}`, { back: true }) },
    ],
    reload: () => notePage(host, id),
  };
}

export async function memoryPanel(host: MemoryDeskHost): Promise<PanelPage> {
  const view = await ledgerView(host);
  const views: PanelView[] = view.sections.map((section) => ({
    kind: "list",
    label: section.title,
    items: section.entries.map((entry) => ({
      id: entry.id,
      label: entry.title,
      meta: entry.decider ?? entry.status,
      badges: entry.stale === true ? [{ label: "stale", tone: "warning" as PanelTone }] : [],
      description: entry.id,
      search: `${entry.id} ${entry.scope ?? ""}`,
      open: () => notePage(host, entry.id),
    })),
    empty: `no ${section.title.toLowerCase()} yet`,
  }));
  if (view.contradictions.length > 0) views.push({ kind: "document", label: `Contradictions ${view.contradictions.length}`, blocks: [{ kind: "text", text: view.contradictions.join("\n"), tone: "warning" }] });
  const actions: PanelAction[] = [{ key: "r", label: `review${view.pending > 0 ? ` (${view.pending})` : ""}`, run: () => ({ command: "/memory review" }) }, { key: "g", label: "graph", run: () => ({ command: "/memory graph" }) }];
  return { title: "Memory", subtitle: `${view.summary} ${view.pending > 0 ? `· ${plural(view.pending, "proposal")} waiting ` : ""}· vault ${view.vault}`, views, actions, reload: () => memoryPanel(host) };
}

// ---- cards: /usage, /context ---------------------------------------------------------------------

/** A harness card (usage, context) as a one-page panel, with extra text blocks under it. */
export function cardPanel(title: string, view: HarnessView, extra: readonly PanelBlock[] = [], reload?: () => Promise<PanelPage>): PanelPage {
  return documentPage(title, [{ kind: "view", view }, ...extra], reload === undefined ? {} : { reload });
}
