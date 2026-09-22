import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  deriveProjectId,
  EXIT_CODES,
  HarnessError,
  MEMORY_KINDS,
  proposalIdSchema,
  type CommandHandler,
  type CommandIO,
  type ExitCode,
  type MemoryConfig,
  type MemoryKind,
  type MemoryNote,
  type MemoryProposal,
} from "../contracts/index.ts";
import { createMemoryStore, isMemoryKind, parseMemoryId, type MarkdownMemoryStore } from "./markdown-memory-store.ts";
import type { MemoryCandidate } from "./relations.ts";
import { createSystemObsidianLauncher, obsidianOpenUri, type ObsidianLauncher } from "./obsidian.ts";
import { readGitBranch, resolveMemoryRoot } from "./vault.ts";

/** `syn memory status|search|show|related|review|accept|reject|open|reindex` (contracts/cli-and-jsonl.md). */

export const MEMORY_SUBCOMMANDS = ["status", "search", "show", "related", "review", "accept", "reject", "open", "reindex"] as const;

const USAGE = `Usage: syn memory <command> [options]

Commands:
  status                      Vault location, counts, pending reviews, stale notes, broken links
  search <text...>            Full-text search (--kind <kind>, --all, --limit <n>)
  show <id>                   Print a note with its source and freshness
  related <id>                Relations, links, backlinks and rule-based candidates
  review                      List proposals waiting for a decision
  accept <proposal-id>        Accept a proposal (--reason <text>)
  reject <proposal-id>        Reject a proposal (--reason <text>)
  open <id> [--in obsidian]   Open in Obsidian via obsidian:// URI; prints the note when Obsidian is absent
  reindex                     Rebuild the derived index from the notes

Common options: --root <dir> (vault), --branch <name> (defaults to the checked-out branch)
`;

export interface MemoryCommandOptions {
  readonly config?: MemoryConfig | undefined;
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly obsidian?: ObsidianLauncher | undefined;
  readonly now?: (() => Date) | undefined;
}

interface Context {
  readonly io: CommandIO;
  readonly store: MarkdownMemoryStore;
  readonly projectId: string;
  readonly branch: string | undefined;
  readonly values: ParsedValues;
  readonly positionals: readonly string[];
  readonly obsidian: ObsidianLauncher;
  readonly now: () => Date;
}

interface ParsedValues {
  readonly root?: string | undefined;
  readonly branch?: string | undefined;
  readonly kind?: string[] | undefined;
  readonly all?: boolean | undefined;
  readonly limit?: string | undefined;
  readonly reason?: string | undefined;
  readonly in?: string | undefined;
  readonly help?: boolean | undefined;
}

export function createMemoryCommand(options: MemoryCommandOptions = {}): CommandHandler {
  return async (args, io) => {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        options: {
          root: { type: "string" },
          branch: { type: "string" },
          kind: { type: "string", multiple: true },
          all: { type: "boolean" },
          limit: { type: "string" },
          reason: { type: "string" },
          in: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (error: unknown) {
      io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
      return EXIT_CODES.usage;
    }
    const [subcommand, ...positionals] = parsed.positionals;
    const values: ParsedValues = parsed.values;
    if (values.help === true || subcommand === "help") {
      io.stdout(USAGE);
      return EXIT_CODES.success;
    }
    if (subcommand === undefined || !(MEMORY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      io.stderr(`${subcommand === undefined ? "error: missing memory command" : `error: unknown memory command '${subcommand}'`}\n\n${USAGE}`);
      return EXIT_CODES.usage;
    }

    const platform = options.platform ?? process.platform;
    const home = options.home ?? io.env.HOME ?? io.env.USERPROFILE ?? homedir();
    const projectId = deriveProjectId(io.cwd, platform);
    const root = values.root ?? resolveMemoryRoot(options.config, projectId, home);
    const now = options.now ?? (() => new Date());
    const context: Context = {
      io,
      store: createMemoryStore(root, { workspaceRoot: io.cwd, now }),
      projectId,
      branch: values.branch ?? (await readGitBranch(io.cwd)),
      values,
      positionals,
      obsidian: options.obsidian ?? createSystemObsidianLauncher(io.env, platform),
      now,
    };
    try {
      return await HANDLERS[subcommand as (typeof MEMORY_SUBCOMMANDS)[number]](context);
    } catch (error: unknown) {
      if (error instanceof HarnessError) {
        io.stderr(`error: ${error.message}${error.info.next_command === undefined ? "" : `\nnext: ${error.info.next_command}`}\n`);
        return error.exitCode;
      }
      io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_CODES.internal;
    }
  };
}

/** The handler the CLI composition root wires as `syn memory`. */
export const memoryCommand: CommandHandler = createMemoryCommand();

const HANDLERS: { readonly [K in (typeof MEMORY_SUBCOMMANDS)[number]]: (context: Context) => Promise<ExitCode> } = {
  status,
  search,
  show,
  related,
  review,
  accept: (context) => decide(context, "accepted"),
  reject: (context) => decide(context, "rejected"),
  open,
  reindex,
};

function fail(context: Context, message: string, code: ExitCode = EXIT_CODES.usage): ExitCode {
  context.io.stderr(`error: ${message}\n`);
  return code;
}

async function status(context: Context): Promise<ExitCode> {
  const report = await context.store.status();
  const count = (kind: MemoryKind, statusName: string): number => report.byKind[kind]?.[statusName] ?? 0;
  const contradictions = report.candidates.filter((candidate) => candidate.kind === "contradiction").length;
  const lines = [
    `vault: ${report.root}`,
    `project: ${context.projectId}${context.branch === undefined ? "" : ` (branch ${context.branch})`}`,
    `${count("decision", "accepted")} geçerli karar, ${count("assumption", "open")} açık varsayım, ${count("question", "open")} açık soru, ${contradictions} olası çelişki`,
    `notes: ${report.notes}`,
  ];
  for (const kind of MEMORY_KINDS) {
    const counts = report.byKind[kind];
    if (counts === undefined) continue;
    lines.push(`  ${kind}: ${Object.entries(counts).map(([name, value]) => `${value} ${name}`).join(", ")}`);
  }
  lines.push(`pending review: ${report.pending}`);
  lines.push(`stale: ${report.stale.length === 0 ? "0" : report.stale.join(", ")}`);
  lines.push(`broken links: ${report.brokenLinks.length}`);
  if (report.invalid.length > 0) lines.push(`invalid notes: ${report.invalid.map((item) => item.path).join(", ")}`);
  if (report.duplicates.length > 0) lines.push(`duplicate ids: ${report.duplicates.map((item) => `${item.id} (${item.paths.join(", ")})`).join("; ")}`);
  lines.push(`candidates: ${report.candidates.length} (syn memory related <id>)`);
  context.io.stdout(`${lines.join("\n")}\n`);
  return EXIT_CODES.success;
}

async function search(context: Context): Promise<ExitCode> {
  const text = context.positionals.join(" ").trim();
  if (text.length === 0) return fail(context, "search needs text: syn memory search <text...>");
  const kinds: MemoryKind[] = [];
  for (const kind of context.values.kind ?? []) {
    if (!isMemoryKind(kind)) return fail(context, `unknown kind '${kind}' (${MEMORY_KINDS.join(", ")})`);
    kinds.push(kind);
  }
  const limit = context.values.limit === undefined ? 10 : Number(context.values.limit);
  if (!Number.isInteger(limit) || limit < 1) return fail(context, "--limit must be a positive integer");
  const results = await context.store.search({
    projectId: context.projectId,
    branch: context.branch,
    text,
    kinds: kinds.length === 0 ? undefined : kinds,
    includeInactive: context.values.all === true,
    limit,
  });
  if (results.length === 0) {
    context.io.stdout("no matching memory\n");
    return EXIT_CODES.success;
  }
  const lines = results.map(
    (result) =>
      `${result.note.frontmatter.id}  ${result.note.frontmatter.kind}/${result.note.frontmatter.status}${result.stale ? "  [STALE]" : ""}  ${result.note.title}\n    ${result.note.path} · ${result.reason}`,
  );
  context.io.stdout(`${lines.join("\n")}\n`);
  return EXIT_CODES.success;
}

async function loadNote(context: Context): Promise<MemoryNote | ExitCode> {
  const raw = context.positionals[0];
  if (raw === undefined) return fail(context, "a memory id is required (for example dec-0042)");
  const id = parseMemoryId(raw);
  if (id === undefined) return fail(context, `'${raw}' is not a memory id (<prefix>-<slug>)`);
  const note = await context.store.get(id);
  if (note === undefined) return fail(context, `no memory note ${id} in ${context.store.root}`, EXIT_CODES.internal);
  return note;
}

async function renderNote(context: Context, note: MemoryNote): Promise<string> {
  const frontmatter = note.frontmatter;
  const source = await context.store.sourceState(frontmatter);
  const lines = [
    `id: ${frontmatter.id}`,
    `kind: ${frontmatter.kind} (${frontmatter.status})`,
    `scope: ${frontmatter.scope}${frontmatter.branch === undefined ? "" : ` · branch ${frontmatter.branch}`}${
      frontmatter.scope === "branch" && frontmatter.branch !== context.branch ? " · NOT the current branch" : ""
    }`,
    `confidence: ${frontmatter.confidence} · owner: ${frontmatter.owner}`,
    `created: ${frontmatter.created_at}${frontmatter.updated_at === undefined ? "" : ` · updated: ${frontmatter.updated_at}`}${
      frontmatter.reviewed_at === undefined ? "" : ` · reviewed: ${frontmatter.reviewed_at}`
    }`,
  ];
  if (frontmatter.source_ref !== undefined) lines.push(`source: ${frontmatter.source_ref} (${source === "none" ? "no digest" : source})`);
  if (frontmatter.source_run !== undefined) lines.push(`source run: ${frontmatter.source_run}`);
  for (const relation of frontmatter.relations) lines.push(`relation: ${relation.type} -> ${relation.target}`);
  lines.push(`path: ${context.store.absolutePath(note.path)}`, "", `# ${note.title}`);
  if (note.body.length > 0) lines.push("", note.body);
  return `${lines.join("\n")}\n`;
}

async function show(context: Context): Promise<ExitCode> {
  const note = await loadNote(context);
  if (typeof note === "number") return note;
  context.io.stdout(await renderNote(context, note));
  return EXIT_CODES.success;
}

function describeCandidate(candidate: MemoryCandidate): string {
  return `  [${candidate.kind}/${candidate.rule}] ${candidate.source} ${candidate.relation.type} ${candidate.target}: ${candidate.rationale}`;
}

async function related(context: Context): Promise<ExitCode> {
  const note = await loadNote(context);
  if (typeof note === "number") return note;
  const view = await context.store.related(note.frontmatter.id);
  if (view === undefined) return fail(context, `no memory note ${note.frontmatter.id}`, EXIT_CODES.internal);
  const lines = [`${note.frontmatter.id}  ${note.title}`];
  const section = (title: string, items: readonly string[]): void => {
    lines.push(`${title}:${items.length === 0 ? " none" : ""}`, ...items);
  };
  section("relations", view.outgoing.map((item) => `  ${item.type} -> ${item.target}${item.title === undefined ? " (missing)" : `  ${item.title}`}`));
  section("referenced by", view.incoming.map((item) => `  ${item.source} ${item.type}  ${item.title}`));
  section("links", view.linksOut.map((item) => `  ${item.path}${item.id === undefined ? "" : ` (${item.id})`}`));
  section("backlinks", view.linksIn.map((item) => `  ${item.path} (${item.id})`));
  section("candidates (unreviewed)", view.candidates.map(describeCandidate));
  context.io.stdout(`${lines.join("\n")}\n`);
  return EXIT_CODES.success;
}

function describeProposal(proposal: MemoryProposal): string {
  const subject =
    proposal.kind === "note"
      ? `new ${proposal.note?.kind ?? "note"} ${proposal.note?.id ?? ""}`
      : proposal.kind === "status-change"
        ? `${proposal.target ?? "?"} -> ${proposal.new_status ?? "?"}`
        : `${proposal.target ?? "?"} ${proposal.relation?.type ?? "?"} ${proposal.relation?.target ?? "?"}`;
  const evidence = proposal.evidence.map((item) => `${item.kind} ${item.ref}`).join(", ");
  return [
    `${proposal.proposal_id}  [${proposal.kind}${proposal.state === "deferred" ? ", deferred" : ""}] ${subject}`,
    `    ${proposal.rationale}`,
    `    evidence: ${evidence} · by ${proposal.created_by.run_id} at ${proposal.created_at}`,
  ].join("\n");
}

async function review(context: Context): Promise<ExitCode> {
  const pending = await context.store.pending();
  if (pending.length === 0) {
    context.io.stdout("review queue is empty\n");
    return EXIT_CODES.success;
  }
  context.io.stdout(`${pending.map(describeProposal).join("\n")}\n\naccept: syn memory accept <proposal-id> · reject: syn memory reject <proposal-id>\n`);
  return EXIT_CODES.success;
}

async function decide(context: Context, state: "accepted" | "rejected"): Promise<ExitCode> {
  const raw = context.positionals[0];
  if (raw === undefined) return fail(context, `a proposal id is required: syn memory ${state === "accepted" ? "accept" : "reject"} <proposal-id>`);
  const id = proposalIdSchema.safeParse(raw);
  if (!id.success) return fail(context, `'${raw}' is not a proposal id (prop_<ULID>)`);
  const reason = context.values.reason?.trim() || `${state} by the user via syn memory`;
  const outcome = await context.store.decide(id.data, { by: "user", at: context.now().toISOString(), reason }, state);
  const persisted = outcome.persisted === undefined ? "" : `; wrote ${outcome.persisted.memory_id} (${outcome.persisted.path})`;
  context.io.stdout(`${state} ${outcome.decided.proposal_id}${persisted}\n`);
  return EXIT_CODES.success;
}

async function open(context: Context): Promise<ExitCode> {
  const target = context.values.in;
  if (target !== undefined && target !== "obsidian") return fail(context, `--in supports only 'obsidian', not '${target}'`);
  const note = await loadNote(context);
  if (typeof note === "number") return note;
  if (target === "obsidian") {
    const uri = obsidianOpenUri(context.store.absolutePath(note.path));
    if ((await context.obsidian.available()) && (await context.obsidian.open(uri))) {
      context.io.stdout(`opened in Obsidian: ${uri}\n`);
      return EXIT_CODES.success;
    }
    context.io.stdout(`Obsidian is not available; showing the note here.\nuri: ${uri}\n\n`);
  }
  context.io.stdout(await renderNote(context, note));
  return EXIT_CODES.success;
}

async function reindex(context: Context): Promise<ExitCode> {
  const index = await context.store.rebuildIndex();
  const lines = [`indexed ${index.notes.length} notes; ${index.broken_links.length} broken links`];
  for (const link of index.broken_links) lines.push(`  broken ${link.kind}: ${link.from} -> ${link.target}`);
  for (const item of index.invalid) lines.push(`  invalid note: ${item.path}: ${item.message}`);
  for (const item of index.duplicates) lines.push(`  duplicate id ${item.id}: ${item.paths.join(", ")}`);
  context.io.stdout(`${lines.join("\n")}\n`);
  return EXIT_CODES.success;
}
