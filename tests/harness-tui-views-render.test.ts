import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessView, OrchestrationView } from "../src/harness/contracts/views.ts";
import { displayWidth, layoutGraph, PlainBoardTracker, renderGraph, renderView, viewContext } from "../src/harness/tui/views/index.ts";
import { ACTION, BOARD, BOARD_DONE, EVIDENCE, T0, USAGE, WHY } from "./harness-tui-views-fixtures.ts";

/** K1-U3: the rich views as pure text — layout, glyph sets, NO_COLOR and narrow widths. */

const NOW = T0 + 64_000;
const ALL: readonly HarnessView[] = [BOARD, BOARD_DONE, USAGE, EVIDENCE, ACTION, WHY];
const SGR = /\x1b\[/;

test("the live board shows one row per task with glyph, role, model, activity and elapsed", () => {
  const lines = renderView(BOARD, viewContext({ glyphs: "rich", width: 80, now: NOW, frame: 0 }));
  assert.match(lines[0] ?? "", /^● Workers · 4 tasks · 2 running\s+g graph · ↓ select · esc to stop$/);
  assert.match(lines[1] ?? "", /^ {2}✓ map-usage\s+explorer\s+luna\s+38 files mapped, 4 use mocks\s+14s$/);
  assert.match(lines[2] ?? "", /^ {2}⠋ convert-mocks\s+implementer astra editing tests\/http\.test\.ts\s+41s$/);
  assert.match(lines[3] ?? "", /checking · npm test/);
  assert.match(lines[4] ?? "", /○ review-migration reviewer\s+luna\s+waiting for 2 tasks$/);
});

test("a done board collapses to the pinned summary without model or elapsed columns", () => {
  const lines = renderView(BOARD_DONE, viewContext({ glyphs: "rich", width: 80 }));
  assert.equal(lines[0], "● Workers · 4 tasks · done in 4m 12s");
  assert.match(lines[2] ?? "", /✓ convert-mocks\s+implementer 4 files \+96 −71 · checks 1\/1$/);
  assert.match(lines[4] ?? "", /Accepted after 1 revision$/);
});

test("more than six tasks fold into done / waiting counts", () => {
  const many: OrchestrationView = {
    kind: "orchestration",
    done: false,
    tasks: Array.from({ length: 8 }, (_, index) => ({ key: `t${index}`, role: "implementer", state: index < 3 ? ("completed" as const) : index < 5 ? ("running" as const) : ("ready" as const) })),
  };
  const text = renderView(many, viewContext({ width: 80, now: NOW })).join("\n");
  assert.match(text, /✓ 3 done/);
  assert.match(text, /○ 3 waiting/);
  assert.match(text, /8 tasks · 2 running/);
});

test("every view fits 60, 80 and 120 columns in every glyph set and has no SGR without colour", () => {
  for (const glyphs of ["rich", "safe", "ascii"] as const) {
    for (const width of [60, 80, 120]) {
      const ctx = viewContext({ glyphs, width, now: NOW });
      const outputs = [...ALL.map((view) => renderView(view, ctx)), renderGraph(BOARD, ctx), renderGraph(BOARD, ctx, { stacked: true })];
      for (const lines of outputs) {
        for (const line of lines) {
          assert.ok(displayWidth(line) <= width, `${glyphs}/${width}: "${line}" is ${displayWidth(line)} wide`);
          assert.doesNotMatch(line, SGR);
          if (glyphs === "ascii") assert.match(line, /^[\x20-\x7e]*$/, `ascii output carries a non-ASCII character: "${line}"`);
        }
      }
    }
  }
});

test("colour paints with the 16-colour palette and still fits", () => {
  const ctx = viewContext({ glyphs: "rich", width: 60, now: NOW, color: true });
  for (const view of ALL) {
    const lines = renderView(view, ctx);
    assert.ok(lines.some((line) => SGR.test(line)), `${view.kind} is painted`);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 60);
      for (const match of line.matchAll(/\x1b\[(\d+)m/g)) assert.ok(Number(match[1]) < 50, `only basic SGR codes: ${match[0]}`);
    }
  }
});

test("the graph lays tasks out in topological levels and routes edges with box drawing", () => {
  const layout = layoutGraph(BOARD);
  assert.deepEqual(
    layout.levels.map((level) => level.map((entry) => entry.id)),
    [["map-usage"], ["convert-mocks", "convert-simple"], ["review-migration"]],
  );
  assert.ok(layout.hot.has("map-usage") && layout.hot.has("convert-mocks"), "the running path includes the running tasks and their ancestors");
  assert.ok(!layout.hot.has("review-migration"));
  const lines = renderGraph(BOARD, viewContext({ glyphs: "rich", width: 100, now: NOW }));
  const text = lines.join("\n");
  assert.match(lines[0] ?? "", /Plan graph · 4 tasks · 3 levels · 2 running/);
  // Edges leave on a box's first text row and enter on the second.
  assert.match(text, /│ ✓ map-usage\s+│─┬┐\s+║ ⠋ convert-mocks\s+║─┐\s+│ ○ review-migration │/);
  assert.match(text, /│ explorer · luna │ └┼─►║ implementer · astra ║ ├─►│ reviewer · luna/);
  assert.match(text, /╔═+╗/, "active tasks get a double border");
  assert.match(text, /║ ⠋ convert-simple\s+║─┘/);
  assert.match(text, /└─►║ implementer · astra ║/);
});

test("the graph wraps its levels vertically when they do not fit", () => {
  const lines = renderGraph(BOARD, viewContext({ glyphs: "ascii", width: 60, now: NOW }));
  const text = lines.join("\n");
  assert.match(text, /\+ level 1\n {2}\| \+ map-usage/);
  assert.match(text, /<- map-usage/);
  assert.match(text, /\+ level 3/);
});

test("edges that skip a level pass through dummy slots, and cycles are reported", () => {
  const skip: OrchestrationView = {
    kind: "orchestration",
    done: false,
    tasks: [
      { key: "a", role: "explorer", state: "completed" },
      { key: "b", role: "implementer", state: "running", dependsOn: ["a"] },
      { key: "c", role: "reviewer", state: "ready", dependsOn: ["b", "a"] },
    ],
  };
  const layout = layoutGraph(skip);
  assert.equal(layout.levels[1]?.length, 2, "a dummy slot carries a -> c through level 2");
  const wide = renderGraph(skip, viewContext({ width: 120, now: NOW })).join("\n");
  assert.match(wide, /►/);
  const cyclic: OrchestrationView = {
    kind: "orchestration",
    done: false,
    tasks: [
      { key: "x", role: "implementer", state: "ready", dependsOn: ["y"] },
      { key: "y", role: "implementer", state: "ready", dependsOn: ["x"] },
    ],
  };
  assert.match(renderGraph(cyclic, viewContext({ width: 80 })).join("\n"), /dependency cycle/);
});

test("usage shows dollars for API keys, plan + quota meters for subscriptions, and today vs session", () => {
  const text = renderView(USAGE, viewContext({ glyphs: "rich", width: 80 })).join("\n");
  assert.match(text, /anthropic opus-5\.5\s+deep\s+12\s+120k\s+8\.2k\s+90k\s+~\$0\.41/);
  assert.match(text, /openai gpt-6-sol\s+fast\s+4\s+22k\s+1\.1k\s+0\s+plan/);
  assert.match(text, /by provider\s+session\s+today/);
  assert.match(text, /claude-code 5h\s+█+░+\s+58% resets 14:20/);
  assert.match(text, /codex weekly\s+█+░\s+93%/);
  assert.match(text, /session\s+16 req · 142k in · 9\.3k out · 90k cache · ~\$0\.41/);
  assert.match(text, /today\s+42 req/);
  assert.match(text, /estimated/);
  const ascii = renderView(USAGE, viewContext({ glyphs: "ascii", width: 80 })).join("\n");
  assert.match(ascii, /\[#+-+\]\s+58%/);
});

test("evidence maps criteria to harness-run proof and labels review independence", () => {
  const text = renderView(EVIDENCE, viewContext({ glyphs: "rich", width: 100 })).join("\n");
  assert.match(text, /3 criteria · 1 passed · 1 failed · 1 not run/);
  assert.match(text, /\[✓ independently reviewed\]/);
  assert.match(text, /⎿ ✓ npm test -- tests\/harness-cli · exit 0 · 42 passed · 6s · run by Synorch/);
  assert.match(text, /○ docs mention the alias {2}not run\n {4}⎿ no proof recorded/);
  assert.match(text, /✗ lint is clean {2}failed/);
  const claimed = renderView(
    { kind: "evidence", criteria: [{ text: "tests pass", status: "unverifiable", proofs: [{ kind: "command", command: "npm test", exitCode: 0, runBy: "worker" }] }] },
    viewContext({ width: 100 }),
  ).join("\n");
  assert.match(claimed, /\[! not independently reviewed\]/);
  assert.match(claimed, /claimed by worker, not run by Synorch/);
  assert.match(claimed, /unverifiable/);
});

test("the action card states what, why and consequence; the why card names layer, rule and the way out", () => {
  const action = renderView(ACTION, viewContext({ glyphs: "rich", width: 60 }));
  assert.match(action[0] ?? "", /^╭─ Delete 14 files\? ─+╮$/);
  assert.match(action.join("\n"), /What {3}rm -r build\//);
  assert.match(action.join("\n"), /not\s+(│\n│\s+)?reversible/);
  assert.match(action.at(-1) ?? "", /^╰─+╯$/);
  const why = renderView(WHY, viewContext({ glyphs: "rich", width: 80 })).join("\n");
  assert.match(why, /Why was this denied\? Run curl/);
  assert.match(why, /Layer {5}workspace · \.ai\/policy\.yaml/);
  assert.match(why, /\(SHELL_PIPE_TO_SHELL\)/);
  assert.match(why, /\/allow curl\s+allow commands starting with curl/);
  assert.match(why, /\/trust\s+trust this folder/);
});

test("untrusted strings are sanitized before they reach the terminal", () => {
  const hostile: OrchestrationView = { kind: "orchestration", done: false, tasks: [{ key: "k\x1b]52;c;AAAA\x07ey", role: "implementer", state: "running", activity: "edit\x1b[2Jing" }] };
  for (const line of renderView(hostile, viewContext({ width: 80 }))) assert.doesNotMatch(line, /\x1b/);
});

test("plain mode prints board changes as task lines (§12)", () => {
  const tracker = new PlainBoardTracker();
  const ctx = viewContext({ glyphs: "ascii", width: 80, now: NOW });
  const first = tracker.update(BOARD, ctx);
  assert.equal(first[0], "workers: 4 tasks - map-usage (explorer, luna), convert-mocks (implementer, astra), convert-simple (implementer, astra), review-migration (reviewer, luna)");
  assert.ok(first.includes("task 1/4 map-usage: done in 14s - 38 files mapped, 4 use mocks"));
  assert.ok(first.includes("task 2/4 convert-mocks: editing tests/http.test.ts"));
  assert.ok(!first.some((line) => line.startsWith("task 4/4")), "tasks first seen waiting stay quiet");
  assert.deepEqual(tracker.update(BOARD, { ...ctx, now: NOW + 5000 }), [], "no change, no line");
  const done = tracker.update(BOARD_DONE, ctx);
  assert.ok(done.includes("task 4/4 review-migration: Accepted after 1 revision"));
  assert.equal(done.at(-1), "workers: done in 4m 12s");
});
