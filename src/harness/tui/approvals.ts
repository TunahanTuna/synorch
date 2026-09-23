import type { ApprovalBroker, ApprovalDecision, ApprovalRequest, PolicyMode } from "../contracts/index.ts";

/**
 * Broker outcomes a renderer may produce on its own. A headless broker answers every request with
 * `unavailable` (ADR-15), which refuses ask-mode prompts and human-only subjects and ends the run
 * with exit code 3. Interactive brokers only add `allowed-*`/`rejected` when a human answered.
 */

export type ApprovalChoice = "allowed-once" | "allowed-for-scope" | "rejected";
/** What a human answered: a choice, or a denial with a reason the agent is told. */
export type ApprovalAnswer = ApprovalChoice | { readonly choice: "rejected"; readonly reason: string };

/** One row of the action prompt (UX-03): Allow once · Always allow <prefix> · Deny · Deny and say why. */
export interface ActionChoice {
  readonly value: ApprovalChoice | "rejected-why";
  readonly label: string;
  /** The number key that picks it (1-based). */
  readonly key: string;
}

const PLAIN_WORD = /^[A-Za-z0-9._+\-=:/@\\]+$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "env", "sudo", "doas", "xargs", "npx", "pnpx", "bunx"]);

/**
 * The prefix "Always allow" would persist for a command: the program and up to two leading
 * non-flag words (`npm run lint`, `python scripts/build.py`, `cargo clippy`). Undefined for git
 * (never granted), for a bare shell or runner, and for words that are not plain.
 */
export function suggestedCommandPrefix(argv: readonly string[] | undefined): string | undefined {
  if (argv === undefined || argv.length === 0) return undefined;
  const words: string[] = [];
  for (const word of argv) {
    if (words.length > 0 && (word.startsWith("-") || words.length >= 3)) break;
    if (!PLAIN_WORD.test(word)) break;
    words.push(word);
  }
  const program = (words[0] ?? "").replaceAll("\\", "/").split("/").pop()?.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "") ?? "";
  if (words.length === 0 || program === "git" || (words.length === 1 && SHELLS.has(program))) return undefined;
  return words.join(" ");
}

/** The action card's question for a request. */
export function actionTitle(request: ApprovalRequest): string {
  if (request.subject_kind !== "action") return `Approval needed (${request.subject_kind})`;
  switch (request.effect) {
    case "exec":
      return "Allow Synorch to run this command?";
    case "workspace-write":
      return "Allow Synorch to edit files?";
    case "external-write":
      return "Allow Synorch to write outside this machine?";
    default:
      return "Allow this action?";
  }
}

/** The rows the action prompt offers for a request, in order; the first is pre-selected. */
export function actionChoices(request: ApprovalRequest): ActionChoice[] {
  const rows: { value: ActionChoice["value"]; label: string }[] = [{ value: "allowed-once", label: "Allow once" }];
  const prefix = request.subject_kind === "action" ? suggestedCommandPrefix(request.command) : undefined;
  if (prefix !== undefined) rows.push({ value: "allowed-for-scope", label: `Always allow \`${prefix}\` in this folder` });
  else if (request.subject_kind === "action" && request.effect === "workspace-write") rows.push({ value: "allowed-for-scope", label: "Allow all edits (switch to auto mode)" });
  else if (request.scope !== "once") rows.push({ value: "allowed-for-scope", label: `Allow for this ${request.scope}` });
  rows.push({ value: "rejected", label: "Deny" }, { value: "rejected-why", label: "Deny and tell Synorch why" });
  return rows.map((row, index) => ({ ...row, key: String(index + 1) }));
}

export function brokerDecision(
  request: ApprovalRequest,
  outcome: "unavailable" | "expired" | "cancelled",
  mode: PolicyMode,
  now: Date,
  reason: string,
): ApprovalDecision {
  return {
    approval_id: request.approval_id,
    subject_kind: request.subject_kind,
    subject_digest: request.subject_digest,
    outcome,
    decided_by: "broker",
    mode,
    decided_at: now.toISOString(),
    reason,
  };
}

export function userDecision(request: ApprovalRequest, answer: ApprovalAnswer, mode: PolicyMode, now: Date): ApprovalDecision {
  const outcome = typeof answer === "string" ? answer : answer.choice;
  const reason = typeof answer === "string" ? undefined : answer.reason.trim().slice(0, 1000);
  return {
    approval_id: request.approval_id,
    subject_kind: request.subject_kind,
    subject_digest: request.subject_digest,
    outcome,
    decided_by: "user",
    mode,
    decided_at: now.toISOString(),
    ...(reason === undefined || reason === "" ? {} : { reason: `the user said: ${reason}`.slice(0, 1000) }),
  };
}

export class HeadlessApprovalBroker implements ApprovalBroker {
  public readonly availability = "headless" as const;
  private readonly mode: PolicyMode;
  private readonly clock: () => Date;

  public constructor(mode: PolicyMode, clock: () => Date = () => new Date()) {
    this.mode = mode;
    this.clock = clock;
  }

  public async request(request: ApprovalRequest, _signal: AbortSignal): Promise<ApprovalDecision> {
    return brokerDecision(request, "unavailable", this.mode, this.clock(), "no interactive terminal is attached to answer this request");
  }
}

/**
 * Races a human prompt against the request expiry and the caller's signal. Expiry resolves as
 * `expired` (the default on timeout is refusal), abort as `cancelled`; both are broker outcomes.
 */
export async function withApprovalDeadline(
  request: ApprovalRequest,
  mode: PolicyMode,
  signal: AbortSignal,
  clock: () => Date,
  ask: (signal: AbortSignal) => Promise<ApprovalAnswer>,
): Promise<ApprovalDecision> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) return brokerDecision(request, "cancelled", mode, clock(), "the request was cancelled");
    const races: Promise<ApprovalDecision>[] = [
      ask(controller.signal).then(
        (choice) => userDecision(request, choice, mode, clock()),
        () => brokerDecision(request, "cancelled", mode, clock(), "the prompt was cancelled"),
      ),
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(brokerDecision(request, "cancelled", mode, clock(), "the request was cancelled")), { once: true });
      }),
    ];
    if (request.expires_at !== undefined) {
      const remaining = Math.max(0, Date.parse(request.expires_at) - clock().getTime());
      races.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(brokerDecision(request, "expired", mode, clock(), "no answer before the approval expired")), remaining);
        }),
      );
    }
    return await Promise.race(races);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
