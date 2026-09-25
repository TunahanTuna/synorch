import assert from "node:assert/strict";
import { test } from "node:test";
import { askUserInputSchema, parseTypedChoice, type AskUserQuestion, type ChoiceAnswer, type ChoiceQuestion } from "../src/harness/contracts/index.ts";
import type { BackendApprovalContext } from "../src/harness/core/index.ts";
import { createClaudeNativeApprovals } from "../src/harness/cli/claude-native-approvals.ts";
import { ChoiceModal, type ChoiceKey } from "../src/harness/tui/choice-modal.ts";
import { GLYPH_SETS } from "../src/harness/tui/conversation-view.ts";
import { createStyler } from "../src/harness/tui/style.ts";

/** K5: the shared choice modal, the `ask_user` schema and Claude Code's AskUserQuestion routing. */

const KEYS: Record<ChoiceKey, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", space: " ", backspace: "\x7f", tab: "\t", pageUp: "\x1b[5~", pageDown: "\x1b[6~" };

function modal(question: ChoiceQuestion): { readonly modal: ChoiceModal; readonly result: () => ChoiceAnswer | "cancelled" | undefined; press(...keys: string[]): void } {
  const instance = new ChoiceModal(question, { style: createStyler(false), glyphs: GLYPH_SETS.rich, isKey: (data, key) => data === KEYS[key] });
  let result: ChoiceAnswer | "cancelled" | undefined;
  instance.onSubmit = (answer) => (result = answer);
  instance.onCancel = () => (result = "cancelled");
  return { modal: instance, result: () => result, press: (...keys) => keys.forEach((key) => instance.handleInput(key)) };
}

const AUTH: ChoiceQuestion = {
  question: "Which auth method?",
  header: "Auth",
  options: [
    { label: "API key", description: "simplest" },
    { label: "OAuth", description: "browser login", recommended: true },
    { label: "SSO", disabled: "needs an enterprise plan" },
  ],
};

test("choice modal: starts on the recommended option, arrows + Enter select, digits pick, Esc cancels", () => {
  const first = modal(AUTH);
  const lines = first.modal.render(80).join("\n");
  assert.match(lines, /\[Auth\] \? Which auth method\?/);
  assert.match(lines, /❯ 2\. OAuth {2}Recommended/);
  assert.match(lines, /4\. Other…/);
  first.press(KEYS.up, KEYS.enter);
  assert.deepEqual(first.result(), { kind: "selected", indices: [0], labels: ["API key"] });

  const digit = modal(AUTH);
  digit.press("3");
  assert.equal(digit.result(), undefined, "a disabled option is not chosen");
  digit.press("2");
  assert.deepEqual(digit.result(), { kind: "selected", indices: [1], labels: ["OAuth"] });

  const esc = modal(AUTH);
  esc.press(KEYS.escape);
  assert.equal(esc.result(), "cancelled");
});

test("choice modal: Other… opens a text line; Esc goes back, Enter sends the typed answer", () => {
  const other = modal(AUTH);
  other.press("4");
  assert.equal(other.modal.state.typing, true);
  other.press("m", "T", "L", "S", "x", KEYS.backspace);
  other.press(KEYS.escape);
  assert.equal(other.result(), undefined, "Esc on the text line returns to the options");
  assert.equal(other.modal.state.typing, false);
  other.press(KEYS.enter);
  other.press(KEYS.enter);
  assert.deepEqual(other.result(), { kind: "other", text: "mTLS" });
});

test("choice modal: multi-select toggles with Space and digits, Enter confirms in option order", () => {
  const multi = modal({ question: "Which sections?", options: [{ label: "Intro" }, { label: "Body" }, { label: "Summary" }], multiSelect: true, allowOther: false });
  multi.press("3", KEYS.up, KEYS.up, KEYS.space, KEYS.enter);
  assert.deepEqual(multi.result(), { kind: "selected", indices: [0, 2], labels: ["Intro", "Summary"] });
  assert.doesNotMatch(multi.modal.render(80).join("\n"), /Other/);
});

test("ask_user schema: 1-4 questions, 2-4 options, one recommended; typed plain answers parse", () => {
  const question = { question: "Auth?", header: "Auth", options: [{ label: "OAuth", description: "", recommended: true }, { label: "Key", description: "" }] };
  assert.equal(askUserInputSchema.safeParse({ questions: [question] }).success, true);
  assert.equal(askUserInputSchema.safeParse({ questions: [] }).success, false);
  assert.equal(askUserInputSchema.safeParse({ questions: [{ ...question, options: question.options.slice(0, 1) }] }).success, false);
  assert.equal(askUserInputSchema.safeParse({ questions: [{ ...question, options: question.options.map((option) => ({ ...option, recommended: true })) }] }).success, false);
  assert.equal(askUserInputSchema.safeParse({ questions: [1, 2, 3, 4, 5].map((n) => ({ ...question, question: `q${n}` })) }).success, false);

  const choice: ChoiceQuestion = { question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true };
  assert.deepEqual(parseTypedChoice(choice, "1, 3"), { kind: "selected", indices: [0, 2], labels: ["A", "C"] });
  assert.deepEqual(parseTypedChoice(choice, "b"), { kind: "selected", indices: [1], labels: ["B"] });
  assert.deepEqual(parseTypedChoice(choice, "something else"), { kind: "other", text: "something else" });
  assert.equal(parseTypedChoice({ ...choice, allowOther: false }, "something else"), undefined);
});

function context(role: BackendApprovalContext["role"]): BackendApprovalContext {
  return { role, runId: undefined, taskId: undefined, attemptId: undefined, policy: undefined as never, record: async () => undefined };
}

test("Claude Code AskUserQuestion: answered in Synorch's modal and returned as updatedInput.answers; never auto-allowed", async () => {
  const asked: AskUserQuestion[][] = [];
  const handler = createClaudeNativeApprovals({
    broker: { availability: "interactive", request: async () => assert.fail("a question is not a permission") },
    permissionMode: () => "full",
    commandGrants: async () => [],
    askUser: async (questions) => {
      asked.push([...questions]);
      return { kind: "answered", answers: { answers: { "How should I format the output?": ["Summary"], "Which sections?": ["Intro", "Summary"] } } };
    },
  });
  const input = {
    questions: [
      { question: "How should I format the output?", header: "Format", options: [{ label: "Summary (Recommended)", description: "Brief" }, { label: "Detailed", description: "Full" }], multiSelect: false },
      { question: "Which sections?", header: "Sections", options: [{ label: "Intro", description: "" }, { label: "Summary", description: "" }], multiSelect: true },
    ],
  };
  const signal = new AbortController().signal;
  const decision = await handler("AskUserQuestion", input, context("session"), signal);
  assert.equal(decision.allow, true);
  assert.deepEqual(decision.updatedInput, { ...input, answers: { "How should I format the output?": "Summary", "Which sections?": "Intro, Summary" } });
  assert.equal(asked[0]?.[1]?.multiSelect, true);

  const worker = await handler("AskUserQuestion", input, context("implementer"), signal);
  assert.equal(worker.allow, false, "workers report blockers instead of asking");
  assert.match(worker.reason, /decide yourself/);
});
