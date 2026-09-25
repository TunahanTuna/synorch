import { z } from "zod";

/**
 * K5 choice questions: one shape for every question the harness puts to the user (the `/init`
 * confirmation, approval cards, `/model`, `/config`, the memory desk, the agent's `ask_user` and
 * Claude Code's own AskUserQuestion). The interactive renderer shows it as a focused modal; plain
 * mode prints the numbered equivalent and parses what is typed (`parseTypedChoice`).
 */

export interface ChoiceOption {
  readonly label: string;
  /** One dim line under the label. */
  readonly description?: string;
  /** A short preview block (code, mockup) shown under the highlighted option. */
  readonly preview?: string;
  /** Tagged "Recommended"; at most one per question. */
  readonly recommended?: boolean;
  /** Shown but not selectable; the text says why. */
  readonly disabled?: string;
}

export interface ChoiceQuestion {
  readonly question: string;
  /** A short chip shown before the question (`Auth`, `Format`). */
  readonly header?: string;
  /** Pre-rendered lines between the question and the options (the approval card's what, where and why). */
  readonly context?: readonly string[];
  /** One dim line under the question (column legend, where a setting is saved). */
  readonly subtitle?: string;
  readonly options: readonly ChoiceOption[];
  /** 1-9 pick an option directly (default true; off for the trust prompt, where a stray digit must not trust). */
  readonly numberShortcuts?: boolean;
  /** Space toggles, Enter confirms. */
  readonly multiSelect?: boolean;
  /** Appends "Other…", which switches to a free-text answer. Default true. */
  readonly allowOther?: boolean;
  /** The row highlighted first (default: the recommended one, else the first). */
  readonly initialIndex?: number;
  /** What Esc means, for the hint line (`cancel`, `deny`, `not now`). */
  readonly escapeLabel?: string;
  /** `attention` (yellow frame) for questions that block work; `neutral` for pickers. */
  readonly tone?: "attention" | "neutral";
}

/** What the user answered; the renderer resolves undefined on Esc / abort instead. */
export type ChoiceAnswer =
  | { readonly kind: "selected"; readonly indices: readonly number[]; readonly labels: readonly string[] }
  | { readonly kind: "other"; readonly text: string };

export const OTHER_LABEL = "Other…";

/** The row the modal highlights first. */
export function initialChoiceIndex(question: ChoiceQuestion): number {
  if (question.initialIndex !== undefined && question.initialIndex >= 0 && question.initialIndex < question.options.length) return question.initialIndex;
  const recommended = question.options.findIndex((option) => option.recommended === true && option.disabled === undefined);
  if (recommended >= 0) return recommended;
  const enabled = question.options.findIndex((option) => option.disabled === undefined);
  return Math.max(0, enabled);
}

/** The answer's text: the chosen labels joined with ", ", or the free text. */
export function choiceAnswerText(answer: ChoiceAnswer): string {
  return answer.kind === "other" ? answer.text : answer.labels.join(", ");
}

/**
 * Plain-mode lines for a question: the chip and question, one numbered row per option (with its
 * description and the recommended tag), "Other" and how to answer.
 */
export function choiceQuestionLines(question: ChoiceQuestion): string[] {
  const lines = [`? ${question.header === undefined ? "" : `[${question.header}] `}${question.question}`];
  question.options.forEach((option, index) => {
    const tags = [option.recommended === true ? "recommended" : undefined, option.disabled].filter((tag) => tag !== undefined);
    lines.push(`  ${index + 1}. ${option.label}${tags.length === 0 ? "" : ` (${tags.join(", ")})`}${option.description === undefined || option.description === "" ? "" : ` - ${option.description}`}`);
  });
  const other = question.allowOther !== false;
  if (other) lines.push(`  ${question.options.length + 1}. Other (type your own answer)`);
  const how = question.multiSelect === true ? "type numbers separated by commas" : "type a number";
  lines.push(`  ${how}${other ? " or your own answer" : ""} and press Enter`);
  return lines;
}

/**
 * Reads a typed plain-mode answer: a number (or comma-separated numbers for multi-select) picks
 * options, a typed label picks that option, anything else is free text (when "Other" is allowed).
 * Undefined when nothing usable was typed (empty, or text a closed question cannot take).
 */
export function parseTypedChoice(question: ChoiceQuestion, typed: string): ChoiceAnswer | undefined {
  const text = typed.trim();
  if (text === "") return undefined;
  const selectable = (index: number): boolean => question.options[index] !== undefined && question.options[index]?.disabled === undefined;
  const numbers = /^\d+(\s*[,\s]\s*\d+)*$/.test(text) ? text.split(/[\s,]+/).map((part) => Number(part) - 1) : undefined;
  if (numbers !== undefined) {
    const picked = [...new Set(numbers)].filter(selectable);
    const limited = question.multiSelect === true ? picked : picked.slice(0, 1);
    if (limited.length > 0 && (question.multiSelect === true || numbers.length === 1)) {
      return { kind: "selected", indices: limited, labels: limited.map((index) => question.options[index]?.label ?? "") };
    }
  }
  const byLabel = question.options.findIndex((option) => option.label.toLowerCase() === text.toLowerCase());
  if (byLabel >= 0 && selectable(byLabel)) return { kind: "selected", indices: [byLabel], labels: [question.options[byLabel]?.label ?? ""] };
  return question.allowOther === false ? undefined : { kind: "other", text };
}

// ---------------------------------------------------------------------------------------------
// The agent's `ask_user` tool (Claude Code's AskUserQuestion shape).

export const askUserOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  description: z.string().max(500),
  preview: z.string().max(4000).optional(),
  recommended: z.boolean().optional(),
});

export const askUserQuestionSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(2000),
    /** A short chip, e.g. "Auth method". */
    header: z.string().trim().min(1).max(30),
    options: z.array(askUserOptionSchema).min(2).max(4),
    multiSelect: z.boolean().optional(),
  })
  .superRefine((question, context) => {
    if (question.options.filter((option) => option.recommended === true).length > 1) {
      context.addIssue({ code: "custom", path: ["options"], message: "at most one option may be recommended" });
    }
    const labels = question.options.map((option) => option.label.toLowerCase());
    if (new Set(labels).size !== labels.length) context.addIssue({ code: "custom", path: ["options"], message: "option labels must be unique" });
  });

export const askUserInputSchema = z
  .strictObject({
    questions: z.array(askUserQuestionSchema).min(1).max(4),
  })
  .superRefine((input, context) => {
    const texts = input.questions.map((question) => question.question);
    if (new Set(texts).size !== texts.length) context.addIssue({ code: "custom", path: ["questions"], message: "question texts must be unique" });
  });
export type AskUserInput = z.infer<typeof askUserInputSchema>;
export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>;

/**
 * What goes back to the model: per question text, the selected labels (an array) or the user's
 * own free text (a string).
 */
export interface AskUserAnswers {
  readonly answers: Readonly<Record<string, readonly string[] | string>>;
}

export function askUserChoiceQuestion(question: AskUserQuestion): ChoiceQuestion {
  return {
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description === "" ? {} : { description: option.description }),
      ...(option.preview === undefined ? {} : { preview: option.preview }),
      ...(option.recommended === true || /\(recommended\)/i.test(option.label) ? { recommended: true } : {}),
    })),
    multiSelect: question.multiSelect === true,
    allowOther: true,
    escapeLabel: "skip",
    tone: "attention",
  };
}

export function askUserAnswerValue(answer: ChoiceAnswer): readonly string[] | string {
  return answer.kind === "other" ? answer.text : [...answer.labels];
}

/** The one transcript line an answered question leaves: `? Auth method → OAuth`. */
export function askUserSummaryLine(question: { readonly question: string; readonly header?: string }, answer: ChoiceAnswer | undefined): string {
  const title = question.header ?? question.question;
  return `? ${title} → ${answer === undefined ? "(skipped)" : choiceAnswerText(answer)}`;
}

export const ASK_USER_HEADLESS_MESSAGE = "no user available in this session (headless, JSONL or piped input); decide yourself using the recommended option (or the safest one) and say which you chose";
