import { createHash } from "node:crypto";
import path from "node:path";
import {
  GENERATED_SKILL_ACTIVE_BUDGET,
  GENERATED_SKILL_DIRECTORY,
  GENERATED_SKILL_MAX_BYTES,
  generatedSkillFrontmatterSchema,
  type GeneratedSkillFrontmatter,
} from "../domain/generated-skill.ts";
import {
  OBSERVATION_LEDGER_PATH,
  observationLedgerSchema,
  type ObservationLedger,
} from "../domain/observation-ledger.ts";
import type { FileSystem } from "../infrastructure/file-system.ts";
import { parseFrontmatter, type ParsedFrontmatter } from "../infrastructure/frontmatter.ts";
import { parseYaml } from "../infrastructure/serialization.ts";
import type { Diagnostic } from "./doctor-service.ts";

/**
 * Validate the generated project-skill namespace: the ledger itself, the frontmatter contract of
 * every `SKILL.md` under `.ai/skills/project/**`, the evidence behind it, and the shape heuristics.
 * Contract violations are errors; heuristics and staleness are warnings, per design D13.
 */
export async function diagnoseGeneratedSkills(
  fileSystem: FileSystem,
  rootDirectory: string,
): Promise<Diagnostic[]> {
  const root = path.resolve(rootDirectory);
  const diagnostics: Diagnostic[] = [];

  const skillDirectories = await listSkillDirectories(fileSystem, root);
  const ledger = await readLedger(fileSystem, root, skillDirectories.length > 0, diagnostics);
  const knownTaskIds = collectConfirmingTaskIds(ledger);

  let activeSkills = 0;
  for (const skillId of skillDirectories) {
    const relativePath = `${GENERATED_SKILL_DIRECTORY}/${skillId}/SKILL.md`;
    const absolutePath = path.join(root, GENERATED_SKILL_DIRECTORY, skillId, "SKILL.md");
    if (!(await isReadableFileWithinRoot(fileSystem, root, absolutePath))) continue;

    const content = await fileSystem.readText(absolutePath);
    if (Buffer.byteLength(content, "utf8") > GENERATED_SKILL_MAX_BYTES) {
      diagnostics.push({
        severity: "error",
        code: "generated.size-exceeded",
        message:
          `Generated skill exceeds the ${GENERATED_SKILL_MAX_BYTES}-byte ceiling: ` +
          `${Buffer.byteLength(content, "utf8")} bytes.`,
        path: relativePath,
      });
    }

    const document = readSkillDocument(content, relativePath, diagnostics);
    if (document === undefined) continue;
    const parsed = validateFrontmatter(document.data, relativePath, diagnostics);

    reportShapeHeuristics(document.body, parsed, relativePath, diagnostics);
    if (parsed === undefined) continue;

    if (parsed.status === "active") activeSkills += 1;
    await validateEvidence(fileSystem, root, parsed, relativePath, diagnostics);
    if (ledger !== undefined) {
      reportUnknownConfirmations(parsed, knownTaskIds, relativePath, diagnostics);
    }
  }

  if (activeSkills > GENERATED_SKILL_ACTIVE_BUDGET) {
    diagnostics.push({
      severity: "error",
      code: "generated.budget-exceeded",
      message:
        `Active project skills (${activeSkills}) exceed the budget of ` +
        `${GENERATED_SKILL_ACTIVE_BUDGET}. Retire one before promoting another.`,
      path: GENERATED_SKILL_DIRECTORY,
    });
  }

  return diagnostics;
}

/** Directory names under `.ai/skills/project`, sorted, so diagnostics keep a stable order. */
async function listSkillDirectories(
  fileSystem: FileSystem,
  root: string,
): Promise<readonly string[]> {
  const directory = path.join(root, GENERATED_SKILL_DIRECTORY);
  if (
    !(await fileSystem.exists(directory)) ||
    !(await fileSystem.isDirectory(directory)) ||
    !(await isPathWithinRoot(fileSystem, root, directory))
  ) {
    return [];
  }
  return [...(await fileSystem.list(directory))]
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readLedger(
  fileSystem: FileSystem,
  root: string,
  skillsExist: boolean,
  diagnostics: Diagnostic[],
): Promise<ObservationLedger | undefined> {
  const absolutePath = path.join(root, OBSERVATION_LEDGER_PATH);
  if (!(await fileSystem.exists(absolutePath))) {
    if (skillsExist) {
      diagnostics.push({
        severity: "error",
        code: "generated.ledger-invalid",
        message:
          "Observation ledger is missing, so generated skill confirmations cannot be verified.",
        path: OBSERVATION_LEDGER_PATH,
      });
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(await fileSystem.readText(absolutePath));
  } catch (error: unknown) {
    diagnostics.push({
      severity: "error",
      code: "generated.ledger-invalid",
      message: error instanceof Error ? error.message : String(error),
      path: OBSERVATION_LEDGER_PATH,
    });
    return undefined;
  }

  const result = observationLedgerSchema.safeParse(parsed);
  if (!result.success) {
    diagnostics.push({
      severity: "error",
      code: "generated.ledger-invalid",
      message: result.error.message,
      path: OBSERVATION_LEDGER_PATH,
    });
    return undefined;
  }
  return result.data;
}

function collectConfirmingTaskIds(ledger: ObservationLedger | undefined): ReadonlySet<string> {
  const taskIds = new Set<string>();
  for (const observation of ledger?.observations ?? []) {
    for (const taskId of observation.confirmed_by) taskIds.add(taskId);
  }
  return taskIds;
}

/**
 * Reads the shared canonical frontmatter block. `missing` and `malformed` keep the dedicated
 * codes the generated namespace already reports, so the two contracts share one parser without
 * sharing a diagnostic vocabulary.
 */
function readSkillDocument(
  content: string,
  relativePath: string,
  diagnostics: Diagnostic[],
): ParsedFrontmatter | undefined {
  const result = parseFrontmatter(content);
  if (result.kind === "missing") {
    diagnostics.push({
      severity: "error",
      code: "generated.frontmatter-missing",
      message: "Generated skill has no YAML frontmatter block fenced by '---'.",
      path: relativePath,
    });
    return undefined;
  }
  if (result.kind === "malformed") {
    diagnostics.push({
      severity: "error",
      code: "generated.frontmatter-invalid",
      message: result.message,
      path: relativePath,
    });
    return undefined;
  }
  return result;
}

/**
 * Dedicated codes come first so that the priority ceiling and the evidence requirement are
 * reported as themselves rather than as a generic schema failure.
 */
function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  relativePath: string,
  diagnostics: Diagnostic[],
): GeneratedSkillFrontmatter | undefined {
  const priority = frontmatter["priority"];
  if (priority !== "skill") {
    diagnostics.push({
      severity: "error",
      code: "generated.priority-ceiling",
      message:
        "A generated skill must declare 'priority: skill'; it can never hold constitutional " +
        `or protocol priority. Received: ${describeValue(priority)}.`,
      path: relativePath,
    });
  }
  if (!hasCompleteEvidence(frontmatter["evidence"])) {
    diagnostics.push({
      severity: "error",
      code: "generated.missing-evidence",
      message:
        "origin: generated requires a non-empty evidence list where every entry carries a " +
        "claim, a source and a digest.",
      path: relativePath,
    });
  }

  const result = generatedSkillFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    diagnostics.push({
      severity: "error",
      code: "generated.contract-invalid",
      message: result.error.message,
      path: relativePath,
    });
    return undefined;
  }
  return result.data;
}

function hasCompleteEvidence(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      typeof record["claim"] === "string" &&
      typeof record["source"] === "string" &&
      typeof record["digest"] === "string"
    );
  });
}

async function validateEvidence(
  fileSystem: FileSystem,
  root: string,
  frontmatter: GeneratedSkillFrontmatter,
  relativePath: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const evidence of frontmatter.evidence) {
    const resolved = resolveSafeRelativePath(root, evidence.source);
    if (resolved === undefined || !(await isPathWithinRoot(fileSystem, root, resolved))) {
      diagnostics.push({
        severity: "error",
        code: "generated.unsafe-source",
        message: `Evidence source must stay inside the target root: ${evidence.source}`,
        path: relativePath,
      });
      continue;
    }
    if (
      !(await fileSystem.exists(resolved)) ||
      (await fileSystem.isDirectory(resolved))
    ) {
      diagnostics.push({
        severity: "error",
        code: "generated.missing-source",
        message: `Evidence source is not an existing regular file: ${evidence.source}`,
        path: relativePath,
      });
      continue;
    }
    const current = digestOf(await fileSystem.readText(resolved));
    if (!matchesRecordedDigest(evidence.digest, current)) {
      diagnostics.push({
        severity: "warning",
        code: "generated.stale-evidence",
        message:
          `Evidence source changed since the skill was verified: ${evidence.source} is now ` +
          `${current}. Re-verify the claim or retire the skill.`,
        path: relativePath,
      });
    }
  }
}

function reportUnknownConfirmations(
  frontmatter: GeneratedSkillFrontmatter,
  knownTaskIds: ReadonlySet<string>,
  relativePath: string,
  diagnostics: Diagnostic[],
): void {
  for (const taskId of frontmatter.confirmed_by) {
    if (knownTaskIds.has(taskId)) continue;
    diagnostics.push({
      severity: "error",
      code: "generated.unknown-confirmation",
      message: `Confirming task id '${taskId}' does not appear in the observation ledger.`,
      path: relativePath,
    });
  }
}

const PAST_TENSE_MARKERS =
  /\b(?:was|were|had|did|failed|crashed|broke|discovered|noticed|turned out|we (?:saw|hit|found|tried|ran))\b/gi;
const TASK_REFERENCE = /\btask-\d+\b/i;
const DATE_REFERENCE = /\b\d{4}-\d{2}-\d{2}\b/;
const PATH_LIKE_CODE_SPAN = /`([^`\n]+)`/g;

/** Taste-level signals from design §7. They warn; they never block. */
function reportShapeHeuristics(
  body: string,
  frontmatter: GeneratedSkillFrontmatter | undefined,
  relativePath: string,
  diagnostics: Diagnostic[],
): void {
  if (!/^##\s+When this applies\s*$/m.test(body)) {
    diagnostics.push({
      severity: "warning",
      code: "shape.no-trigger",
      message:
        "No explicit activation condition: add a 'When this applies' section so the skill can " +
        "be matched without reading it.",
      path: relativePath,
    });
  }

  const pastTenseMarkers = body.match(PAST_TENSE_MARKERS)?.length ?? 0;
  if (pastTenseMarkers >= 3 && (TASK_REFERENCE.test(body) || DATE_REFERENCE.test(body))) {
    diagnostics.push({
      severity: "warning",
      code: "shape.incident-log-shape",
      message:
        "The body reads as a narrated past incident (past-tense narration plus a task id or " +
        "date) instead of a repeatable procedure.",
      path: relativePath,
    });
  }

  if (frontmatter === undefined) return;
  const sources = new Set(frontmatter.evidence.map((evidence) => evidence.source));
  const unsourced = [...body.matchAll(PATH_LIKE_CODE_SPAN)]
    .map((match) => match[1] ?? "")
    .filter((value) => isPathLike(value) && !sources.has(value))
    .sort((left, right) => left.localeCompare(right));
  const firstUnsourced = unsourced[0];
  if (firstUnsourced !== undefined) {
    diagnostics.push({
      severity: "warning",
      code: "shape.unsourced-claim",
      message:
        `The body cites '${firstUnsourced}', which no evidence entry backs. Add it to evidence ` +
        "with a digest or drop the claim.",
      path: relativePath,
    });
  }
}

function isPathLike(value: string): boolean {
  return /^[\w.@/-]+$/.test(value) && value.includes("/") && !value.endsWith("/");
}

/** Digests are taken over line-ending-normalized text so they are stable across platforms. */
function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content.replaceAll("\r\n", "\n"), "utf8").digest("hex")}`;
}

/** A recorded digest may be truncated, so a prefix of the current digest is a match. */
function matchesRecordedDigest(recorded: string, current: string): boolean {
  return current.startsWith(recorded);
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : JSON.stringify(value) ?? "undefined";
}

async function isReadableFileWithinRoot(
  fileSystem: FileSystem,
  root: string,
  absolutePath: string,
): Promise<boolean> {
  return (
    (await fileSystem.exists(absolutePath)) &&
    !(await fileSystem.isDirectory(absolutePath)) &&
    (await isPathWithinRoot(fileSystem, root, absolutePath))
  );
}

async function isPathWithinRoot(
  fileSystem: FileSystem,
  root: string,
  absolutePath: string,
): Promise<boolean> {
  try {
    await fileSystem.assertPathWithinRoot(root, absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** Lexical containment check; `assertPathWithinRoot` adds the realpath half. */
function resolveSafeRelativePath(root: string, candidate: string): string | undefined {
  if (candidate.includes("\0") || path.win32.parse(candidate).root !== "") return undefined;
  const normalized = candidate.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized.length === 0 || path.posix.isAbsolute(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;

  const absolute = path.resolve(root, ...segments);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    return undefined;
  }
  return absolute;
}
