import type { CommandPaletteEntry, SessionEvent } from "../contracts/index.ts";
import { closestMatch } from "../../domain/suggest.ts";

/**
 * In-session commands of `syn agent` (cli-experience.md): the command registry and the two
 * read-only reports (`/tasks`, `/context` fallback) built from what the session recorded.
 */

function latest<T extends SessionEvent["type"]>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<SessionEvent, { type: T }>;
  }
  return undefined;
}

export function tasksReport(events: readonly SessionEvent[]): string[] {
  const created = events.filter((event): event is Extract<SessionEvent, { type: "task/created" }> => event.type === "task/created");
  if (created.length === 0) return ["no tasks yet"];
  return created.map((task) => {
    const last = events.filter((event) => event.type === "task/state_changed" && event.data.task_id === task.data.task_id).at(-1);
    const state = last?.type === "task/state_changed" ? last.data.to : "draft";
    const owned = task.data.owned_paths.length === 0 ? "read-only" : task.data.owned_paths.join(", ");
    const after = task.data.depends_on.length === 0 ? "" : ` after ${task.data.depends_on.join(", ")}`;
    return `${task.data.key} ${task.data.task_id} ${state} (${task.data.role}; ${owned})${after}`;
  });
}

export function contextReport(events: readonly SessionEvent[]): string[] {
  const request = latest(events, "model/request_prepared");
  if (request === undefined) return ["no model request yet"];
  const total = request.data.context.reduce((sum, block) => sum + block.tokens_estimate, 0);
  const compaction = latest(events, "context/compacted");
  return [
    `request ${request.data.request_id} to ${request.data.route.provider_id}/${request.data.route.model_id}: ~${total} tokens`,
    ...request.data.context.map((block) => `- ${block.source} (${block.trust}) ~${block.tokens_estimate}${block.truncated ? " truncated" : ""}`),
    compaction === undefined ? "no compaction" : `last compaction ${compaction.data.trigger}: ${compaction.data.tokens_before} -> ${compaction.data.tokens_after} tokens`,
  ];
}

// ---- the conversation's command registry (ADR-21, TUI §8.11) ----------------------------------

/**
 * What a conversation command may do. `cli/conversation.ts` implements it; the registry below is
 * the single source for the handlers, `/help` and the renderer's command palette (`setCommands`).
 */
export interface ConversationCommandHost {
  print(lines: readonly string[]): void;
  /** `/help` as a command browser (TUI panel); absent prints `conversationHelp()`. */
  help?(): Promise<void>;
  cancel(): void;
  planMode(goal: string): Promise<void>;
  go(mode: string): Promise<void>;
  workers(goal: string): Promise<void>;
  /** K3 `/runs [id | cancel [id]]`: background worker runs. */
  runs(argument: string): Promise<void>;
  /** K1.7 `/worker [key] [message | --pause | --resume | --cancel]`. */
  worker(argument: string): Promise<void>;
  undo(): Promise<void>;
  allow(argument: string): Promise<void>;
  trust(): Promise<void>;
  /** `/status`: mode, sandbox, MCP servers and the notices of this session's start. */
  status(): Promise<void>;
  model(argument: string): Promise<void>;
  /** K6 `/effort [level] [--tier <tier>]`: set, or with no level pick, a tier's reasoning effort for this session. */
  effort(argument: string): Promise<void>;
  review(argument: string): Promise<void>;
  commit(argument: string): Promise<void>;
  usage(): Promise<void>;
  cost(): Promise<void>;
  /** K4.2 `/ps [kill <handle|all>]`: background processes. */
  ps(argument: string): Promise<void>;
  /** K3 `/mcp`: MCP servers, their tools and state; reconnect, enable, disable, approve. */
  mcp(argument: string): Promise<void>;
  /** K7 `/skills`: skills and markdown commands with source and state; show, enable, disable. */
  skills(argument: string): Promise<void>;
  /** K7 `/plugins`: installed plugins (Synorch and Claude Code); install, remove, enable, disable. */
  plugins(argument: string): Promise<void>;
  /** K2 `/evidence [turn | <n>]`. */
  evidence(argument: string): Promise<void>;
  why(argument: string): Promise<void>;
  compact(focus: string): Promise<void>;
  report(name: "context" | "permissions" | "tasks" | "memory" | "diff" | "log", argument: string): Promise<void>;
  clear(): Promise<void>;
  resume(argument: string): Promise<void>;
  /** K3 `/fork [name]`: continue in a branch of this conversation; the original stays resumable. */
  fork(argument: string): Promise<void>;
  /** K3 `/rewind` (Esc Esc): fork from before an earlier message, optionally restoring the files Synorch changed since. */
  rewind(): Promise<void>;
  mouse(argument: string): Promise<void>;
  graph(): Promise<void>;
  /** `/config [key [value]]`: the settings screen, or read / set one key (user configuration). */
  config(argument: string): Promise<void>;
  /** K8 `/theme [name]`, `/welcome [style]`, `/setup`: appearance with live preview (saved to the user config). */
  theme(argument: string): Promise<void>;
  welcome(argument: string): Promise<void>;
  setup(): Promise<void>;
  /** `/init [--yes]`: materialize the Synorch `.ai/` structure into the repository (preview first). */
  init(argument: string): Promise<void>;
}

export interface SlashCommand {
  /** With the leading slash, lower case: `/model`. */
  readonly name: string;
  readonly description: string;
  /** `<required>` makes the palette complete instead of submit; `[optional]` submits. */
  readonly argsHint?: string;
  readonly aliases?: readonly string[];
  /** Runs at once while the agent works; other commands wait for the turn to end. */
  readonly whileBusy?: boolean;
  /** Executed by the interactive renderer itself (`/mouse`, `/exit`): kept out of the palette rows the session pushes. */
  readonly rendererLocal?: boolean;
  /** Resolves true when the user asked to leave the session. */
  run(host: ConversationCommandHost, argument: string): Promise<boolean | void>;
}

export const CONVERSATION_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "commands and keys", whileBusy: true, run: async (host) => (host.help === undefined ? host.print(conversationHelp()) : host.help()) },
  { name: "/plan", argsHint: "[goal]", description: "plan mode: read-only, discuss and plan before changing anything (Shift+Tab cycles modes)", whileBusy: true, run: (host, argument) => host.planMode(argument) },
  { name: "/go", argsHint: "[workers]", description: "leave plan mode and carry out the plan here, or with workers", run: (host, argument) => host.go(argument) },
  { name: "/workers", argsHint: "<goal>", description: "run a large goal with parallel workers and an independent reviewer; alone: list the workers", whileBusy: true, run: (host, argument) => host.workers(argument) },
  { name: "/runs", argsHint: "[id | cancel [id]]", description: "background worker runs: status and progress; one run's tasks; cancel one", whileBusy: true, run: (host, argument) => host.runs(argument) },
  { name: "/worker", argsHint: "[key] [message | --pause | --resume | --cancel]", description: "one worker: its assignment and recent activity, or message / pause / resume / cancel it", whileBusy: true, run: (host, argument) => host.worker(argument) },
  { name: "/model", argsHint: "[tier] [provider/model] [--save]", description: "every logged-in provider's models; set a tier's model for this session (--save keeps it)", run: (host, argument) => host.model(argument) },
  { name: "/effort", argsHint: "[level] [--tier <tier>]", description: "reasoning effort of the conversation model (low … max, ultra); alone: pick one. Applies to the next request", whileBusy: true, run: (host, argument) => host.effort(argument) },
  { name: "/review", argsHint: "[--staged | <commit> | <from>..<to> | run-<n> | fix] [focus]", description: "independent reviewer (fresh context, another provider when logged in) on the uncommitted diff, staged changes, a commit/range or a worker run; runs in the background, verdict card + findings", whileBusy: true, run: (host, argument) => host.review(argument) },
  { name: "/commit", argsHint: "[message]", description: "diff summary and a proposed message; commits only after you confirm", run: (host, argument) => host.commit(argument) },
  { name: "/undo", description: "revert the last edit Synorch made (files only)", run: (host) => host.undo() },
  { name: "/allow", argsHint: "[prefix | -r prefix]", description: "let Synorch run commands starting with <prefix> here", whileBusy: true, run: (host, argument) => host.allow(argument) },
  { name: "/trust", description: "trust this folder so build/test commands may run", run: (host) => host.trust() },
  { name: "/status", description: "session status: model, mode, sandbox, MCP servers and startup notices", whileBusy: true, run: (host) => host.status() },
  { name: "/usage", description: "requests, tokens, quota and estimated cost (session and today)", whileBusy: true, run: (host) => host.usage() },
  { name: "/cost", description: "this session's estimated cost and tokens", whileBusy: true, run: (host) => host.cost() },
  { name: "/evidence", argsHint: "[turn | n]", description: "proof for the last turn or worker run: criteria, checks Synorch ran, review verdict and findings", whileBusy: true, run: (host, argument) => host.evidence(argument) },
  { name: "/why", argsHint: "[last | n | tool | model]", description: "why an action was allowed, asked or refused (mode, rule, layer) and what would change it; /why model: why this route", whileBusy: true, run: (host, argument) => host.why(argument) },
  { name: "/compact", argsHint: "[focus]", description: "summarize older messages to free context", run: (host, argument) => host.compact(argument) },
  { name: "/context", description: "why this context: instructions, skills, memory, files and history the model received, with token estimates", whileBusy: true, run: (host, argument) => host.report("context", argument) },
  { name: "/clear", description: "start a fresh conversation (this one stays resumable)", run: (host) => host.clear() },
  { name: "/resume", argsHint: "[n | session id]", description: "pick a recent conversation (forks included) and switch to it", run: (host, argument) => host.resume(argument) },
  { name: "/fork", argsHint: "[name]", description: "branch this conversation here and continue in the branch (the original stays resumable)", run: (host, argument) => host.fork(argument) },
  { name: "/rewind", description: "go back to an earlier message: fork from before it, optionally restore files (Esc Esc)", run: (host) => host.rewind() },
  { name: "/init", argsHint: "[--yes]", description: "write the Synorch .ai/ structure into this repo to customize it (preview first; never needed to use Synorch)", run: (host, argument) => host.init(argument) },
  { name: "/memory", argsHint: "[init | review | edit <id> | retire <id> | open [id] | graph]", description: "memory ledger and decision desk: what Synorch remembers, proposals to accept / edit / reject / defer", whileBusy: true, run: (host, argument) => host.report("memory", argument) },
  { name: "/mouse", argsHint: "[on|off]", description: "toggle mouse capture (scroll / select)", whileBusy: true, rendererLocal: true, run: (host, argument) => host.mouse(argument) },
  { name: "/diff", description: "files changed by Synorch in this conversation", whileBusy: true, run: (host, argument) => host.report("diff", argument) },
  { name: "/mcp", argsHint: "[<name> | tools | reconnect | login | logout | enable | disable | approve <name>]", description: "MCP servers (external tools such as Playwright): state, details, tools, sign in, reconnect, enable / disable, approve a project server", whileBusy: true, run: (host, argument) => host.mcp(argument) },
  { name: "/skills", argsHint: "[show | enable | disable <name>]", description: "skills and slash commands (yours, the repo's, plugins', Claude Code's): source, state; /<name> runs one", whileBusy: true, run: (host, argument) => host.skills(argument) },
  { name: "/plugins", argsHint: "[show | install <spec> | remove | enable | disable <name> | hooks]", description: "plugins (Claude Code format): what each adds; install, remove, enable / disable, approve hooks", whileBusy: true, run: (host, argument) => host.plugins(argument) },
  { name: "/agents", argsHint: "[show <id>]", description: "plugin agents: worker personas the orchestrator may assign to a task", whileBusy: true, run: (host, argument) => host.plugins(`agents ${argument}`.trim()) },
  { name: "/ps", argsHint: "[kill <handle|all>]", description: "background processes (dev servers, watchers); stop one or all", whileBusy: true, run: (host, argument) => host.ps(argument) },
  { name: "/graph", description: "the plan graph of the current or last worker run", whileBusy: true, run: (host) => host.graph() },
  { name: "/tasks", description: "tasks of this conversation's worker runs", whileBusy: true, run: (host, argument) => host.report("tasks", argument) },
  { name: "/permissions", argsHint: "[ask|auto|full|plan | allow <prefix> | remove <prefix>]", description: "permission mode, allow rules and trust; switch mode or edit rules", whileBusy: true, run: (host, argument) => host.report("permissions", argument) },
  { name: "/config", argsHint: "[key [value]]", description: "settings: routes, permission mode, budget, mouse, glyphs (saved to your user config)", whileBusy: true, run: (host, argument) => host.config(argument) },
  { name: "/theme", argsHint: "[name]", description: "colour theme with a live preview (synorch, light, high-contrast, mono, nord, dracula, gruvbox, catppuccin or yours)", whileBusy: true, run: (host, argument) => host.theme(argument) },
  { name: "/welcome", argsHint: "[full|compact|minimal|off]", description: "customize the welcome header: style, logo, facts, tips (live preview)", whileBusy: true, run: (host, argument) => host.welcome(argument) },
  { name: "/setup", description: "the first-run setup again: theme, welcome screen, symbols", whileBusy: true, run: (host) => host.setup() },
  { name: "/log", argsHint: "[n]", description: "raw event log of this conversation (debug)", whileBusy: true, run: (host, argument) => host.report("log", argument) },
  { name: "/cancel", description: "stop the current work (the conversation stays resumable)", whileBusy: true, run: async (host) => host.cancel() },
  { name: "/exit", aliases: ["/quit"], description: "leave (resume with syn agent --continue)", whileBusy: true, rendererLocal: true, run: async () => true },
];

export function findConversationCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return CONVERSATION_COMMANDS.find((command) => command.name === lower || command.aliases?.includes(lower) === true);
}

/** The reply to an unknown slash command: the closest registered command when one is plausibly meant. */
export function unknownConversationCommand(name: string, sep: string): string {
  const names = CONVERSATION_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
  const match = name.startsWith("/") ? closestMatch(name.slice(1), names.map((candidate) => candidate.slice(1))) : undefined;
  return match === undefined ? `Unknown command ${name} ${sep} /help lists the commands` : `Unknown command ${name} ${sep} did you mean /${match}?`;
}

/** Palette rows for the interactive renderer (`controls.setCommands`, K1-U1): names without the slash; renderer-local commands stay the renderer's. */
export function conversationPaletteEntries(): CommandPaletteEntry[] {
  return CONVERSATION_COMMANDS.filter((command) => command.rendererLocal !== true).map(({ name, description, argsHint, aliases }) => ({
    name: name.slice(1),
    description,
    ...(argsHint === undefined ? {} : { argsHint }),
    ...(aliases === undefined ? {} : { aliases: aliases.map((alias) => alias.slice(1)) }),
  }));
}

/** K7: names a skill or markdown command cannot take (a built-in command always wins), without the slash. */
export function reservedCommandNames(): ReadonlySet<string> {
  return new Set(CONVERSATION_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]).map((name) => name.slice(1)));
}

export function conversationHelp(): string[] {
  const label = (command: SlashCommand): string => `${command.name}${command.argsHint === undefined ? "" : ` ${command.argsHint}`}`;
  const width = Math.max(...CONVERSATION_COMMANDS.map((command) => label(command).length));
  return [
    ...CONVERSATION_COMMANDS.map((command) => `${label(command).padEnd(width + 2)}${command.description}`),
    "Keys: Esc interrupts the turn (workers keep running in the background; /runs cancel stops them) · Ctrl+G board/graph · Down selects a worker · Shift+Tab cycles ask/auto/full/plan · Enter while working steers · @path attaches a file · Ctrl+C twice exits",
  ];
}
