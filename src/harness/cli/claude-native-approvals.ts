import {
  ALLOWING_OUTCOMES,
  ASK_USER_HEADLESS_MESSAGE,
  approvalDecisionSchema,
  approvalRequestSchema,
  createId,
  digestOf,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type AskUserQuestion,
  type BackendApprovalDecision,
  type PermissionMode,
  type ToolEffect,
} from "../contracts/index.ts";
import type { BackendApprovalContext, BackendApprovalHandler } from "../core/index.ts";
import { hostMatches } from "../policy/index.ts";
import { claudeInputSummary, claudeToolEffect } from "../providers/index.ts";
import { egressFindings } from "../tools/index.ts";
import type { UserQuestionsOutcome } from "./runtime.ts";

/**
 * Claude Code native mode (owner revision 2026-09-24, ADR-08): Claude's own permission prompts
 * (`--permission-prompt-tool mcp__synorch__approve`) are answered by the session's approval broker
 * with the same action card the tool gateway uses, audited as `approval/requested` +
 * `approval/decided` in the turn's log. "Always allow <prefix>" answers are persisted by the
 * conversation broker in the command-grant store and honoured here on later Bash prompts.
 */

export interface ClaudeNativeApprovalOptions {
  readonly broker: ApprovalBroker;
  /** The session's current permission mode; undefined is headless (the broker refuses). */
  readonly permissionMode: () => PermissionMode | undefined;
  /** Command prefixes always allowed in this workspace (user scope), read at every command prompt. */
  readonly commandGrants: () => Promise<readonly string[]>;
  readonly redact?: (text: string) => string;
  readonly now?: () => Date;
  /**
   * K4.1: Claude's WebSearch/WebFetch follow Synorch's network policy: auto and full read any
   * domain freely (owner revision 3), plan searches freely and asks at a fetch of a domain outside
   * the allowed list ("always allow this domain"), ask asks every time, and a
   * query or URL carrying a secret is refused in every mode (secret-egress rail).
   */
  readonly web?: { readonly domains: () => readonly string[]; readonly environment: Readonly<Record<string, string | undefined>> };
  /**
   * K5: Claude's own AskUserQuestion is shown in Synorch's choice modal; the answers go back as
   * `updatedInput.answers` (question text -> label, multi-select labels joined with ", ", or the
   * user's own text), the Agent SDK's documented contract for the permission callback.
   */
  readonly askUser?: (questions: readonly AskUserQuestion[], signal: AbortSignal) => Promise<UserQuestionsOutcome>;
}

/** Claude's AskUserQuestion input as `ask_user` questions (lenient: Claude validated it already). */
export function claudeQuestions(input: Readonly<Record<string, unknown>>): AskUserQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const questions: AskUserQuestion[] = [];
  for (const raw of input.questions.slice(0, 4) as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const item = raw as Record<string, unknown>;
    if (typeof item.question !== "string" || item.question.trim() === "" || !Array.isArray(item.options)) return undefined;
    const options = (item.options as unknown[]).flatMap((option) => {
      if (typeof option !== "object" || option === null) return [];
      const entry = option as Record<string, unknown>;
      if (typeof entry.label !== "string" || entry.label.trim() === "") return [];
      return [{ label: entry.label, description: typeof entry.description === "string" ? entry.description : "", ...(typeof entry.preview === "string" ? { preview: entry.preview } : {}) }];
    });
    if (options.length === 0) return undefined;
    questions.push({ question: item.question, header: typeof item.header === "string" && item.header.trim() !== "" ? item.header : "Question", options, multiSelect: item.multiSelect === true });
  }
  return questions.length === 0 ? undefined : questions;
}

/** The answers Claude Code expects in `updatedInput.answers`: one string per question. */
export function claudeAnswers(answers: Readonly<Record<string, readonly string[] | string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([question, value]) => [question, typeof value === "string" ? value : value.join(", ")]));
}

const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
/** Shell syntax that could chain or substitute another command after a granted prefix. */
const SHELL_SYNTAX = /[;&|`$<>(){}\r\n]/;

const CONSEQUENCES: Readonly<Record<ToolEffect, string>> = {
  read: "Claude Code reads this without changing anything",
  "workspace-write": "Claude Code changes files in this workspace",
  exec: "Claude Code runs this command on this machine with your user's rights (not Synorch's sandbox)",
  "external-write": "Claude Code writes outside this machine",
  control: "Claude Code changes the session",
  "network-read": "Claude Code reads from the internet; the content is untrusted data",
};

function webHostOf(input: Readonly<Record<string, unknown>>): string | undefined {
  try {
    return typeof input.url === "string" ? new URL(input.url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** A Bash command line as the words the card and the grant prefix see. */
export function commandWords(command: string): string[] {
  return command.trim().split(/\s+/).filter((word) => word !== "").slice(0, 256).map((word) => word.slice(0, 2000));
}

/** The granted prefix a command matches, or undefined; commands with shell syntax never match. */
export function grantedPrefix(command: string, grants: readonly string[]): string | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const words = commandWords(command);
  return grants.find((grant) => {
    const prefix = grant.split(" ");
    return prefix.length <= words.length && prefix.every((word, index) => words[index] === word);
  });
}

function summaryOf(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const detail = claudeInputSummary(toolName, input);
  return `Claude Code ${toolName}${detail === "" ? "" : `: ${detail}`}`;
}

export function createClaudeNativeApprovals(options: ClaudeNativeApprovalOptions): BackendApprovalHandler {
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? ((text: string) => text);
  const allow = (reason: string): BackendApprovalDecision => ({ allow: true, reason });
  const deny = (reason: string): BackendApprovalDecision => ({ allow: false, reason });

  const decided = async (context: BackendApprovalContext, decision: ApprovalDecision): Promise<void> => {
    await context.record("approval/decided", { decision });
  };
  const refusal = (context: BackendApprovalContext, request: ApprovalRequest, outcome: "cancelled" | "unavailable", reason: string): ApprovalDecision =>
    approvalDecisionSchema.parse({
      approval_id: request.approval_id,
      subject_kind: "action",
      subject_digest: request.subject_digest,
      outcome,
      decided_by: "broker",
      mode: context.policy.mode,
      decided_at: now().toISOString(),
      reason: reason.slice(0, 1000),
    });

  return async (toolName, input, context, signal) => {
    if (toolName === "AskUserQuestion") {
      // A question, not a permission: never auto-allowed (that would answer nothing), in every mode.
      const questions = claudeQuestions(input);
      if (questions === undefined) return deny("the AskUserQuestion input could not be read; ask in plain text instead");
      if (options.askUser === undefined || (context.role !== "session" && context.role !== "orchestrator")) return deny(ASK_USER_HEADLESS_MESSAGE);
      const outcome = await options.askUser(questions, signal).catch((): UserQuestionsOutcome => ({ kind: "dismissed" }));
      if (outcome.kind === "unavailable") return deny(ASK_USER_HEADLESS_MESSAGE);
      if (outcome.kind === "dismissed") return deny("the user dismissed the question without answering; do not assume an answer: continue with what you can decide safely, or ask again in plain text");
      return { allow: true, reason: "the user answered", updatedInput: { ...input, answers: claudeAnswers(outcome.answers.answers) } };
    }
    const mode = options.permissionMode();
    const effect = claudeToolEffect(toolName);
    const webHost = effect === "network-read" ? webHostOf(input) : undefined;
    if (effect === "network-read" && options.web !== undefined) {
      const outbound = toolName === "WebSearch" ? String(input.query ?? "") : typeof input.url === "string" ? input.url.replace(/^[a-z]+:\/\/[^/]+/i, "") : "";
      const findings = egressFindings(outbound, options.web.environment);
      if (findings !== undefined) return deny(`hard rail secret-egress: the ${toolName === "WebSearch" ? "query" : "URL"} carries ${findings.join(", ")}`);
      if (mode === "full" || mode === "auto") return allow(`${mode === "full" ? "full access" : "auto mode"}: web reads are allowed without asking`);
      if (mode !== "ask" && mode !== undefined && toolName === "WebSearch") return allow("web search is allowed in this mode");
      if (mode !== "ask" && mode !== undefined && webHost !== undefined && options.web.domains().some((pattern) => hostMatches(webHost, pattern))) return allow(`${webHost} is an allowed web domain`);
    }
    if (mode === "full") return allow("full access: Synorch allows Claude Code's tools without asking");
    if (mode === "plan" && (effect === "exec" || effect === "workspace-write" || toolName === "ExitPlanMode")) {
      return deny("plan mode is on: read, discuss and propose the plan; the user leaves plan mode to carry it out");
    }
    if (mode === "auto" && effect === "workspace-write") return allow("auto mode accepts edits in this workspace");

    const command = COMMAND_TOOLS.has(toolName) && typeof input.command === "string" ? input.command : undefined;
    const words = command === undefined ? [] : commandWords(command);
    const request = approvalRequestSchema.parse({
      approval_id: createId("approval"),
      ...(context.runId === undefined ? {} : { run_id: context.runId }),
      ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
      subject_kind: "action",
      subject_digest: digestOf({ backend: "claude-code", tool_name: toolName, input }),
      summary: redact(summaryOf(toolName, input)).slice(0, 2000) || `Claude Code ${toolName}`,
      effect,
      scope: "once",
      ...(words.length === 0 ? {} : { command: words.map((word) => redact(word).slice(0, 2000)) }),
      ...(toolName === "WebFetch" && webHost !== undefined ? { hosts: [webHost] } : {}),
      details: {
        why: `Claude Code asked to use its built-in ${toolName} tool (native mode)`.slice(0, 1000),
        consequence: CONSEQUENCES[effect],
      },
      requested_at: now().toISOString(),
    });

    if (command !== undefined && context.role === "session") {
      const prefix = grantedPrefix(command, await options.commandGrants().catch(() => []));
      if (prefix !== undefined) {
        await context.record("approval/requested", { request });
        await decided(
          context,
          approvalDecisionSchema.parse({
            approval_id: request.approval_id,
            subject_kind: "action",
            subject_digest: request.subject_digest,
            outcome: "allowed-for-scope",
            decided_by: "config",
            mode: context.policy.mode,
            decided_at: now().toISOString(),
            reason: `matches the always-allowed prefix "${prefix}"`.slice(0, 1000),
          }),
        );
        return allow(`always allowed: ${prefix}`);
      }
    }

    await context.record("approval/requested", { request });
    let answer: ApprovalDecision;
    try {
      const parsed = approvalDecisionSchema.safeParse(await options.broker.request(request, signal));
      if (!parsed.success) answer = refusal(context, request, "cancelled", "the approval decision was malformed");
      else if (parsed.data.approval_id !== request.approval_id || parsed.data.subject_digest !== request.subject_digest) {
        answer = refusal(context, request, "cancelled", "the approval does not bind to this request");
      } else answer = parsed.data;
    } catch (error: unknown) {
      answer = refusal(context, request, signal.aborted ? "cancelled" : "unavailable", `approval broker failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await decided(context, answer);
    if ((ALLOWING_OUTCOMES as readonly string[]).includes(answer.outcome)) return allow(answer.reason ?? `allowed by ${answer.decided_by}`);
    return deny(answer.reason ?? `${toolName} was not allowed (${answer.outcome})`);
  };
}
