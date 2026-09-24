import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId, digestText, memoryProposalSchema, type MemoryKind } from "../contracts/index.ts";
import type { MarkdownMemoryStore } from "./markdown-memory-store.ts";
import { ensureVaultScaffold } from "./vault.ts";

/**
 * `/memory init` (zero-config onboarding): bootstraps a project's memory from facts Synorch detected
 * itself (the project profile), so the user never types "we use pnpm workspaces". Stack, commands,
 * layout and conventions become `concept` notes and manifest pointers `evidence` notes (auto-persist
 * kinds, ADR-17); what reads like a decision or a preference is only proposed into the review queue.
 *
 * Re-running is safe: notes Synorch wrote are refreshed in place (digest-checked), notes the user
 * edited (`owner: human`) are left alone, and a proposal is never queued twice for the same fact
 * (a user-scope marker remembers what was proposed, so a rejected fact is not proposed again).
 */

export interface BootstrapNote {
  /** Slug: the note id is `<kind prefix>-<key>`. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface BootstrapEvidence extends BootstrapNote {
  /** Workspace-relative file the evidence points at (its digest makes the note go stale when it changes). */
  readonly sourceRef: string;
}

export interface BootstrapProposal extends BootstrapNote {
  readonly kind: "decision" | "preference";
  readonly rationale: string;
  readonly sourceRef?: string;
}

export interface ProjectFacts {
  readonly concepts: readonly BootstrapNote[];
  readonly evidence: readonly BootstrapEvidence[];
  readonly proposals: readonly BootstrapProposal[];
}

export interface BootstrapOptions {
  readonly projectId: string;
  readonly workspaceRoot: string;
  /** User-scope JSON file remembering which facts were already proposed. */
  readonly markerFile: string;
  readonly now?: Date;
}

export interface BootstrapResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Notes the user owns now; never overwritten. */
  readonly kept: readonly string[];
  readonly proposed: readonly string[];
  readonly alreadyProposed: readonly string[];
}

const TAG = "synorch-profile";
const PREFIX: Readonly<Record<"concept" | "evidence" | "decision" | "preference", string>> = { concept: "cpt", evidence: "evd", decision: "dec", preference: "prf" };

export function bootstrapId(kind: keyof typeof PREFIX, key: string): string {
  const slug = key.toLowerCase().replace(/[^0-9a-z]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/g, "");
  return `${PREFIX[kind]}-${slug.length < 3 ? `${slug}-note` : slug}`;
}

interface Marker {
  readonly proposed: string[];
  readonly bootstrapped_at?: string;
}

async function readMarker(file: string): Promise<Marker> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { proposed?: unknown; bootstrapped_at?: unknown };
    return { proposed: Array.isArray(parsed.proposed) ? parsed.proposed.filter((item): item is string => typeof item === "string") : [], ...(typeof parsed.bootstrapped_at === "string" ? { bootstrapped_at: parsed.bootstrapped_at } : {}) };
  } catch {
    return { proposed: [] };
  }
}

/** Whether `/memory init` already ran for this project (the automatic first-session bootstrap checks it). */
export async function memoryBootstrapped(markerFile: string): Promise<boolean> {
  return (await readMarker(markerFile)).bootstrapped_at !== undefined;
}

export async function bootstrapProjectMemory(store: MarkdownMemoryStore, facts: ProjectFacts, options: BootstrapOptions): Promise<BootstrapResult> {
  const now = options.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  await ensureVaultScaffold(store.root);
  const written: string[] = [];
  const unchanged: string[] = [];
  const kept: string[] = [];

  const upsert = async (kind: "concept" | "evidence", note: BootstrapNote, source?: { readonly ref: string; readonly digest: string }): Promise<void> => {
    const id = bootstrapId(kind, note.key);
    const existing = await store.get(id as never).catch(() => undefined);
    if (existing !== undefined && existing.frontmatter.owner === "human") {
      kept.push(id);
      return;
    }
    if (existing !== undefined && existing.title === note.title && existing.body === note.body.trim() && existing.frontmatter.source_digest === source?.digest) {
      unchanged.push(id);
      return;
    }
    await store.persist(
      {
        frontmatter: {
          schema_version: 1,
          id: id as never,
          kind: kind as MemoryKind,
          project_id: options.projectId as never,
          scope: "project",
          status: kind === "concept" ? "active" : "current",
          created_at: existing?.frontmatter.created_at ?? date,
          ...(existing === undefined ? {} : { updated_at: date }),
          ...(source === undefined ? {} : { source_ref: source.ref, source_digest: source.digest as never }),
          confidence: "high",
          owner: "synorch",
          relations: [],
          tags: [TAG],
        },
        title: note.title,
        body: note.body,
      },
      existing?.digest,
    );
    written.push(id);
  };

  for (const concept of facts.concepts) await upsert("concept", concept);
  for (const evidence of facts.evidence) {
    const content = await readFile(path.join(options.workspaceRoot, evidence.sourceRef), "utf8").catch(() => undefined);
    if (content === undefined) continue;
    await upsert("evidence", evidence, { ref: evidence.sourceRef, digest: digestText(content) });
  }

  const marker = await readMarker(options.markerFile);
  const pendingIds = new Set((await store.pending()).flatMap((proposal) => (proposal.note === undefined ? [] : [proposal.note.id as string])));
  const proposed: string[] = [];
  const alreadyProposed: string[] = [];
  for (const fact of facts.proposals) {
    const id = bootstrapId(fact.kind, fact.key);
    if (marker.proposed.includes(id) || pendingIds.has(id) || (await store.get(id as never).catch(() => undefined)) !== undefined) {
      alreadyProposed.push(id);
      continue;
    }
    const proposal = memoryProposalSchema.parse({
      schema_version: 1,
      proposal_id: createId("proposal"),
      kind: "note",
      note: {
        schema_version: 1,
        id,
        kind: fact.kind,
        project_id: options.projectId,
        scope: "project",
        status: fact.kind === "decision" ? "proposed" : "active",
        created_at: date,
        confidence: "high",
        owner: fact.kind === "preference" ? "human" : "synorch",
        relations: [],
        tags: [TAG],
        ...(fact.sourceRef === undefined ? {} : { source_ref: fact.sourceRef }),
      },
      body: `# ${fact.title}${fact.body.trim() === "" ? "" : `\n\n${fact.body.trim()}`}`,
      rationale: fact.rationale,
      evidence: [{ kind: "file", ref: fact.sourceRef ?? "synorch:project-profile", produced_by: "orchestrator" }],
      created_by: { role: "session" },
      created_at: now.toISOString(),
      state: "pending",
    });
    await store.propose(proposal);
    proposed.push(id);
  }

  await mkdir(path.dirname(options.markerFile), { recursive: true });
  await writeFile(options.markerFile, `${JSON.stringify({ bootstrapped_at: now.toISOString(), proposed: [...new Set([...marker.proposed, ...proposed])] }, null, 2)}\n`, "utf8");
  return { written, unchanged, kept, proposed, alreadyProposed };
}

/** The lines `/memory init` prints. */
export function bootstrapSummary(result: BootstrapResult): string[] {
  const lines = [`✓ Project memory ${result.written.length === 0 ? "up to date" : `bootstrapped: ${result.written.length} note${result.written.length === 1 ? "" : "s"} written`}${result.unchanged.length === 0 ? "" : ` · ${result.unchanged.length} unchanged`}${result.kept.length === 0 ? "" : ` · ${result.kept.length} kept (edited by you)`}`];
  if (result.written.length > 0) lines.push(`  ${result.written.join(", ")}`);
  if (result.proposed.length > 0) lines.push(`${result.proposed.length} inferred decision${result.proposed.length === 1 ? "" : "s"}/preference${result.proposed.length === 1 ? "" : "s"} waiting for you · /memory review`);
  else if (result.alreadyProposed.length > 0) lines.push("No new decisions to propose (earlier proposals stay in /memory review until you decide).");
  return lines;
}
