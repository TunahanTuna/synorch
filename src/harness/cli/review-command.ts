import path from "node:path";
import { digestOf, type ModelTier, type RouteDecision } from "../contracts/index.ts";
import {
  isGeneratedPath,
  renderArtifactReviewBrief,
  renderReviewCard,
  verdictDecision,
  type ArtifactReviewRequest,
  type ArtifactReviewResult,
  type PinnedReviewArtifact,
} from "../orchestration/index.ts";
import type { ParsedCommand } from "./args.ts";
import { failureInfo } from "./outcome.ts";
import { createRuntime, type RuntimeOverrides } from "./runtime.ts";
import { reviewDiff } from "./session-git.ts";

/**
 * `syn review [--staged | <commit> | <from>..<to>] [focus] [--json]`: the conversation's `/review`
 * (ADR-09) without the interface. The same pinned artifact, reviewer routing and coordinator
 * review, non-interactively (no approvals: headless auto); exit 0 approve, 1 changes requested,
 * 2 blocked, 3 error. The route/diff steps mirror `ConversationSession.review` in `conversation.ts`
 * (kept there untouched); a shared helper would live in one module later.
 */

type ReviewCommand = Extract<ParsedCommand, { kind: "review" }>;

export interface ReviewIO {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly signal: AbortSignal | undefined;
}

const REVIEW_DIFF_LIMIT = 48 * 1024;
const GLYPHS = { ok: "+", warn: "!", fail: "x", bullet: "-", sep: "|" };
const REVIEW_EXIT = { approve: 0, changes_requested: 1, blocked: 2, error: 3 } as const;

class ReviewFailure extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function reviewCommand(parsed: ReviewCommand, io: ReviewIO, overrides: RuntimeOverrides): Promise<number> {
  const emit = (value: unknown): void => void io.stdout.write(`${JSON.stringify(value)}\n`);
  const fail = (code: string, message: string): number => {
    if (parsed.json) emit({ schema: 1, error: { code, message } });
    else io.stderr.write(`Error: ${message}\n`);
    return REVIEW_EXIT.error;
  };
  if (parsed.target.kind === "run") return fail("usage_invalid", "run-<n> targets exist only inside a conversation (/review run-<n>); pass --staged, a commit or a range");
  const signal = io.signal ?? new AbortController().signal;
  const root = path.resolve(io.cwd, parsed.common.target ?? ".");
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime({
      workspaceRoot: root,
      env: io.env,
      policyMode: parsed.session.policy,
      routes: parsed.session.profiles,
      efforts: parsed.session.efforts,
      overrides,
      trustWorkspace: parsed.trustWorkspace,
    });
    const workspaceRoot = runtime.workspaceRoot;
    let diff = await reviewDiff(workspaceRoot, parsed.target, isGeneratedPath, signal);
    if (typeof diff === "string") throw new ReviewFailure("usage_invalid", diff === "not a git repository" ? "syn review needs a git repository (the diff is what gets reviewed)" : diff);
    if (diff.text.trim() === "" && parsed.target.kind === "workspace") {
      const last = await reviewDiff(workspaceRoot, { kind: "commit", rev: "HEAD" }, isGeneratedPath, signal);
      if (typeof last !== "string" && last.text.trim() !== "") diff = { ...last, label: `last ${last.label}` };
    }
    if (diff.text.trim() === "") {
      throw new ReviewFailure("nothing_to_review", diff.excluded.length > 0 ? `only generated files changed (${diff.excluded.slice(0, 3).join(", ")}); nothing to review` : `nothing to review in ${diff.label}`);
    }
    const pinned = diff;
    const rules = runtime.routeRules();
    const explicit = rules.find((candidate) => candidate.role === "reviewer");
    const tier: ModelTier = explicit?.tier ?? (rules.some((candidate) => candidate.tier === "complex_worker") ? "complex_worker" : (rules.find((candidate) => candidate.tier !== "session")?.tier ?? "complex_worker"));
    const taskTier = tier === "session" ? "complex_worker" : tier;
    const implementer = await runtime.router.resolve({ tier: taskTier, role: "implementer" }, signal).then((decision) => decision.route).catch(() => undefined);
    const route: RouteDecision = await runtime.router.resolve({ tier, role: "reviewer", ...(implementer === undefined ? {} : { implementer }) }, signal);
    const digest = digestOf({ diff: pinned.text });
    const truncated = Buffer.byteLength(pinned.text, "utf8") > REVIEW_DIFF_LIMIT;
    const shown = truncated ? Buffer.from(pinned.text, "utf8").subarray(0, REVIEW_DIFF_LIMIT).toString("utf8") : pinned.text;
    const artifact: PinnedReviewArtifact = {
      digest,
      brief: renderArtifactReviewBrief({ label: pinned.label, digest, diff: shown, truncated, changedPaths: pinned.files, excludedPaths: pinned.excluded, focus: parsed.focus }),
      repin: async (repinSignal) => {
        const again = await reviewDiff(workspaceRoot, pinned.resolved, isGeneratedPath, repinSignal);
        return typeof again === "string" ? undefined : digestOf({ diff: again.text });
      },
    };
    const request: ArtifactReviewRequest = {
      workspaceRoot,
      policyMode: parsed.session.policy,
      headless: true,
      target: parsed.target,
      label: pinned.label,
      focus: parsed.focus,
      tier: taskTier,
      route,
      implementer,
      changedPaths: pinned.files,
      excludedPaths: pinned.excluded,
      artifact,
    };
    const coordinator = runtime.createCoordinator(runtime.brokerFor(undefined));
    const result = await coordinator.review(request, signal);
    return report(parsed, io, result, pinned.label);
  } catch (error) {
    if (error instanceof ReviewFailure) return fail(error.code, error.message);
    const info = failureInfo(error);
    return fail(info.code, info.message);
  } finally {
    if (runtime !== undefined) {
      runtime.processes.killAllSync();
      runtime.mcp.killAllSync();
      void runtime.mcp.close();
    }
  }
}

function report(parsed: ReviewCommand, io: ReviewIO, result: ArtifactReviewResult, label: string): number {
  const verdict = result.verdict;
  const code = result.status === "reviewed" && verdict !== undefined ? REVIEW_EXIT[verdict] : REVIEW_EXIT.error;
  if (parsed.json) {
    io.stdout.write(
      `${JSON.stringify({
        schema: 1,
        status: result.status,
        target: result.targetKind,
        label,
        verdict: verdict ?? null,
        decision: verdict === undefined ? null : verdictDecision(verdict),
        reviewer: result.reviewer,
        cross_provider: result.sameProvider === undefined ? null : !result.sameProvider,
        artifact: { digest: result.artifactDigest, files: result.changedPaths, excluded: result.excludedPaths },
        findings: result.findings,
        criteria: result.criteria,
        ...(result.problems.length > 0 ? { problems: result.problems } : {}),
        attempt_id: result.reviewerAttemptId ?? null,
        session_id: result.sessionId === "" ? null : result.sessionId,
      })}\n`,
    );
  } else {
    io.stdout.write(`${renderReviewCard(result, GLYPHS).join("\n")}\n`);
    for (const problem of result.problems) io.stderr.write(`${problem}\n`);
  }
  return code;
}
