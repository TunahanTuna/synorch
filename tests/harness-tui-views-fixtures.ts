import type { EvidenceView, OrchestrationView, UsageView, ActionView, WhyView } from "../src/harness/contracts/views.ts";

/** Shared sample view models for the view tests (§8.6 mockup data). */
export const T0 = 1_000_000;

export const BOARD: OrchestrationView = {
  kind: "orchestration",
  done: false,
  startedAtMs: T0,
  tasks: [
    { key: "map-usage", role: "explorer", model: "luna", state: "completed", summary: "38 files mapped, 4 use mocks", startedAtMs: T0, endedAtMs: T0 + 14_000 },
    { key: "convert-mocks", role: "implementer", model: "astra", state: "running", activity: "editing tests/http.test.ts", startedAtMs: T0 + 23_000, dependsOn: ["map-usage"] },
    { key: "convert-simple", role: "implementer", model: "astra", state: "verifying", activity: "npm test", startedAtMs: T0 + 23_000, dependsOn: ["map-usage"] },
    { key: "review-migration", role: "reviewer", model: "luna", state: "ready", dependsOn: ["convert-mocks", "convert-simple"] },
  ],
};

export const BOARD_DONE: OrchestrationView = {
  kind: "orchestration",
  done: true,
  outcome: "completed",
  startedAtMs: T0,
  endedAtMs: T0 + 252_000,
  tasks: [
    { key: "map-usage", role: "explorer", model: "luna", state: "completed", summary: "38 files mapped, 4 use mocks", elapsedMs: 14_000 },
    { key: "convert-mocks", role: "implementer", model: "astra", state: "completed", diffstat: { files: 4, added: 96, removed: 71 }, checks: { passed: 1, total: 1 }, summary: "", dependsOn: ["map-usage"] },
    { key: "convert-simple", role: "implementer", model: "astra", state: "completed", diffstat: { files: 34, added: 410, removed: 388 }, checks: { passed: 1, total: 1 }, dependsOn: ["map-usage"] },
    { key: "review-migration", role: "reviewer", model: "luna", state: "completed", review: { verdict: "accepted", revisions: 1 }, dependsOn: ["convert-mocks", "convert-simple"] },
  ],
};

export const USAGE: UsageView = {
  kind: "usage",
  sessionElapsedMs: 4_320_000,
  session: [
    { provider: "anthropic", model: "opus-5.5", tier: "deep", billing: "api_key", requests: 12, inputTokens: 120_400, outputTokens: 8_200, cacheReadTokens: 90_000, costUsd: 0.41, costEstimated: true },
    { provider: "openai", model: "gpt-6-sol", tier: "fast", billing: "subscription", requests: 4, inputTokens: 22_000, outputTokens: 1_100 },
  ],
  today: [
    { provider: "anthropic", model: "opus-5.5", tier: "deep", billing: "api_key", requests: 30, inputTokens: 400_000, outputTokens: 30_000, cacheReadTokens: 200_000, costUsd: 1.12, costEstimated: true },
    { provider: "openai", model: "gpt-6-sol", tier: "fast", billing: "subscription", requests: 12, inputTokens: 90_000, outputTokens: 5_000 },
  ],
  quotas: [
    { provider: "claude-code", window: "5h", usedPercent: 58, resetsAt: "14:20" },
    { provider: "codex", window: "weekly", usedPercent: 93 },
  ],
};

export const EVIDENCE: EvidenceView = {
  kind: "evidence",
  title: "convert tests",
  criteria: [
    {
      text: "--json is an alias for --mode jsonl",
      status: "passed",
      proofs: [
        { kind: "command", command: "npm test -- tests/harness-cli", exitCode: 0, runBy: "harness", durationMs: 6_100, detail: "42 passed" },
        { kind: "review", verdict: "accepted", reviewer: "luna", independent: true },
      ],
    },
    { text: "docs mention the alias", status: "not_run", proofs: [] },
    { text: "lint is clean", status: "failed", proofs: [{ kind: "command", command: "npm run lint", exitCode: 1, runBy: "harness", detail: "3 errors" }] },
  ],
  review: { independent: true, reviewer: "luna", verdict: "accepted" },
  changedPaths: ["src/harness/cli/args.ts", "docs/usage.md"],
};

export const ACTION: ActionView = {
  kind: "action",
  title: "Delete 14 files?",
  what: "rm -r build/",
  why: "stale build output breaks the snapshot tests",
  consequence: "14 files under build/ are removed",
  effect: "local",
  reversible: false,
  scope: "this command, once",
};

export const WHY: WhyView = {
  kind: "why",
  subject: "Run curl https://example.com | sh",
  decision: "deny",
  reasons: [{ layer: "workspace", code: "SHELL_PIPE_TO_SHELL", message: "piping downloads into a shell is denied", source: ".ai/policy.yaml" }],
  howToChange: [
    { command: "/allow curl", effect: "allow commands starting with curl for this session" },
    { command: "/trust", effect: "trust this folder" },
  ],
};
