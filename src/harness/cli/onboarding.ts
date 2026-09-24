import { readFile } from "node:fs/promises";
import path from "node:path";
import { StructureService } from "../../application/structure-service.ts";
import type { PlannedFile } from "../../domain/generation.ts";
import { NodeFileSystem } from "../../infrastructure/file-system.ts";
import { bootstrapProjectMemory, bootstrapSummary, ensureVaultScaffold, memoryBootstrapped, type MarkdownMemoryStore } from "../memory/index.ts";
import { lineDiff } from "../tui/index.ts";
import { profileHeaderLine, profileMemoryFacts, within, type ProjectProfile } from "./project-profile.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Zero-config onboarding in the conversation: the quiet "Synorch ready · …" line, the memory vault
 * created silently, the automatic first-session memory bootstrap, `/memory init` and `/init`.
 * Everything automatic lives in the user scope (`~/.synorch/...`); only an explicit `/init` writes
 * into the repository, after a preview and a confirmation.
 */

export function memoryMarkerFile(runtime: Runtime): string {
  return path.join(runtime.home, "projects", runtime.projectId, "memory-bootstrap.json");
}

/**
 * Prints the one-line profile header as soon as the profile is known (a cached profile: at once),
 * creates the memory vault and, the first time Synorch runs in this project, bootstraps the project
 * memory from the profile (concept/evidence notes written, decisions only proposed). Never throws.
 */
export async function startOnboarding(runtime: Runtime, print: (line: string) => void, sep: string): Promise<void> {
  await ensureVaultScaffold(runtime.memoryRoot).catch(() => undefined);
  const quick = await within(runtime.profile.ready, 400);
  // An empty folder or one without a recognized stack stays quiet: nothing to announce or remember.
  if (quick !== undefined && recognized(quick)) print(profileHeaderLine(quick, sep));
  const profile = quick ?? (await runtime.profile.ready.catch(() => undefined));
  if (profile === undefined || !recognized(profile)) return;
  if (quick === undefined) print(profileHeaderLine(profile, sep));
  const marker = memoryMarkerFile(runtime);
  if (await memoryBootstrapped(marker)) return;
  await bootstrapProjectMemory(runtime.memory as MarkdownMemoryStore, profileMemoryFacts(profile), { projectId: runtime.projectId, workspaceRoot: runtime.workspaceRoot, markerFile: marker }).catch(() => undefined);
}

function recognized(profile: ProjectProfile): boolean {
  return profile.languages.length > 0 || profile.packageManager !== null;
}

/** `/memory init`: re-detects the profile and (re)bootstraps the project memory from it. */
export async function runMemoryInit(runtime: Runtime): Promise<string[]> {
  const profile = (await runtime.profile.refresh()) ?? (await runtime.profile.ready);
  if (profile === undefined) return ["The project profile could not be detected here; nothing was written."];
  const result = await bootstrapProjectMemory(runtime.memory as MarkdownMemoryStore, profileMemoryFacts(profile), { projectId: runtime.projectId, workspaceRoot: runtime.workspaceRoot, markerFile: memoryMarkerFile(runtime) });
  return [profileHeaderLine(profile).replace(/^Synorch ready/, "Detected"), ...bootstrapSummary(result)];
}

export interface InitHost {
  readonly runtime: Runtime;
  print(lines: readonly string[]): void;
  ask(question: string, options: readonly string[] | undefined): Promise<string>;
}

function fileLine(file: PlannedFile, current: string | undefined): string {
  if (file.status === "create") return `  + ${file.relativePath}`;
  const diff = lineDiff(current ?? "", file.content);
  return `  ~ ${file.relativePath} (differs: +${diff.added} -${diff.removed}; kept unless you choose to overwrite)`;
}

/**
 * `/init`: materializes the Synorch `.ai/` structure into the repository for customization, with the
 * legacy `syn init` structure service. It previews what would be created and which existing files
 * differ, asks, and never overwrites a differing file unless the user chose to. `--yes` skips the
 * question for new files only.
 */
export async function runInitCommand(host: InitHost, argument: string): Promise<void> {
  const root = host.runtime.workspaceRoot;
  const service = new StructureService(new NodeFileSystem());
  const plan = await service.createPlan(root, undefined, true);
  const created = plan.files.filter((file) => file.status === "create");
  const differing = plan.files.filter((file) => file.status === "update");
  const unchanged = plan.files.filter((file) => file.status === "unchanged" || file.status === "preserved").length;
  if (created.length === 0 && differing.length === 0) {
    host.print([`The Synorch structure is already in ${root} (${unchanged} files up to date). Edit .ai/ to customize it.`]);
    return;
  }
  const lines = [`/init writes the Synorch structure into ${root} so you can customize it (Synorch already works without it):`, `${created.length} new file${created.length === 1 ? "" : "s"}, ${differing.length} existing file${differing.length === 1 ? "" : "s"} that differ, ${unchanged} up to date`];
  const shown = [...differing, ...created].slice(0, 30);
  for (const file of shown) {
    const current = file.status === "update" ? await readFile(path.join(root, file.relativePath), "utf8").catch(() => undefined) : undefined;
    lines.push(fileLine(file, current));
  }
  if (created.length + differing.length > shown.length) lines.push(`  … and ${created.length + differing.length - shown.length} more`);
  host.print(lines);

  const yes = /(^|\s)(--yes|-y)(\s|$)/.test(argument);
  let overwrite = false;
  if (!yes) {
    const options = differing.length === 0 ? ["Create the files", "Cancel"] : ["Create new files only (keep the differing ones)", "Create and overwrite the differing files", "Cancel"];
    const answer = (await host.ask("Write the Synorch structure into this repository?", options).catch(() => "cancel")).trim().toLowerCase();
    const cancelled = differing.length === 0 ? /^(2|c|cancel|n|no|hayır|iptal)/.test(answer) || answer === "" : /^(3|c|cancel|n|no|hayır|iptal)/.test(answer) || answer === "";
    if (cancelled) {
      host.print(["Cancelled · nothing was written."]);
      return;
    }
    overwrite = differing.length > 0 && /^(2|overwrite|create and overwrite)/.test(answer);
  }
  const files = plan.files.filter((file) => file.status === "create" || (overwrite && file.status === "update"));
  const result = await service.initialize({ ...plan, files });
  host.print([
    `✓ Wrote ${result.created.length} new file${result.created.length === 1 ? "" : "s"}${result.updated.length === 0 ? "" : `, overwrote ${result.updated.length}`}${differing.length > 0 && !overwrite ? ` · kept ${differing.length} differing file${differing.length === 1 ? "" : "s"}` : ""}`,
    "The .ai/ structure is loaded from the next session on; commit it to share the customization.",
  ]);
}
