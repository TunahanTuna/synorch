import { z } from "zod";
import { AGENT_ROLES, type Tool } from "../../contracts/index.ts";
import { actionOf, builtinMetadata, defineTool, errorResult, okResult } from "./shared.ts";

/**
 * K4.2 `todo`: the agent's visible checklist for a longer piece of work. Each call sends the whole
 * list (replacing the previous one); the call itself is recorded in the session log, so the list
 * survives resume and the conversation view renders it as one compact checklist updated in place.
 * It is a focus aid, not the orchestration DAG.
 */

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

const todoItemSchema = z.strictObject({
  id: z.string().trim().min(1).max(40).optional(),
  text: z.string().trim().min(1).max(300),
  status: z.enum(TODO_STATUSES).default("pending"),
});

const todoInput = z.strictObject({
  items: z.array(todoItemSchema).max(50),
});
type TodoInput = z.infer<typeof todoInput>;
export type TodoItem = z.infer<typeof todoItemSchema>;

const MARKS: { readonly [S in TodoStatus]: string } = { done: "[x]", in_progress: "[>]", pending: "[ ]" };

/** `2/5 done · now: wire the tests` */
export function todoSummary(items: readonly Pick<TodoItem, "text" | "status">[]): string {
  const done = items.filter((item) => item.status === "done").length;
  const current = items.find((item) => item.status === "in_progress");
  return `${done}/${items.length} done${current === undefined ? "" : ` · now: ${current.text}`}`;
}

export function todoText(items: readonly Pick<TodoItem, "text" | "status">[]): string {
  if (items.length === 0) return "checklist cleared";
  return [`checklist ${todoSummary(items)}`, ...items.map((item) => `${MARKS[item.status]} ${item.text}`)].join("\n");
}

export function createTodoTool(): Tool<TodoInput> {
  const metadata = builtinMetadata({
    name: "todo",
    description:
      "Keep a visible checklist for multi-step work: send the whole list each time with each item's status (pending, in_progress, done). Mark one item in_progress while you work on it and done as soon as it is finished; an empty list clears it. Use it for tasks with 3+ steps, not for trivial ones.",
    effect: "control",
    idempotent: true,
    network: "none",
    output_limit_bytes: 64 * 1024,
    timeout_ms: 5_000,
    cancellable: false,
    concurrency: "parallel",
    // The orchestrator's plan is its DAG; every agent doing the work keeps a checklist.
    visible_to: AGENT_ROLES.filter((role) => role !== "orchestrator"),
  });
  return defineTool(metadata, todoInput, {
    normalize: async (input, context) => actionOf(metadata, input, context),
    async execute(input) {
      const active = input.items.filter((item) => item.status === "in_progress").length;
      if (active > 3) return errorResult("invalid_arguments", `${active} items are in_progress; keep at most one or two in progress at a time`);
      return okResult(todoText(input.items));
    },
  });
}
