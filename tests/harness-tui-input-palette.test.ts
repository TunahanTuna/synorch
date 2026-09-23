import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AttachmentTray } from "../src/harness/tui/input/attachments.ts";
import { InputCompletionProvider, mentionPrefix } from "../src/harness/tui/input/autocomplete.ts";
import { imagePathFromPaste, sniffImage } from "../src/harness/tui/input/clipboard.ts";
import { DEFAULT_COMMAND_PALETTE, filterCommands, mergeCommands, requiresArgument } from "../src/harness/tui/input/commands.ts";
import { buildIndex, searchIndex, WorkspaceFileIndex } from "../src/harness/tui/input/file-index.ts";
import { parseSgrMouse, TranscriptViewport } from "../src/harness/tui/input/mouse.ts";

/** K1-U1: command palette filtering, @file completion, attachments, image sniffing and SGR mouse parsing. */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("the command palette filters by prefix, keeps local commands and knows required arguments", () => {
  const commands = mergeCommands(DEFAULT_COMMAND_PALETTE);
  assert.ok(commands.some((entry) => entry.name === "mouse"));
  assert.deepEqual(filterCommands(commands, "pe").map((entry) => entry.name)[0], "permissions");
  assert.equal(filterCommands(commands, "")[0]?.name, "plan");
  assert.equal(filterCommands(commands, "quit")[0]?.name, "exit");
  const plan = commands.find((entry) => entry.name === "plan");
  const log = commands.find((entry) => entry.name === "log");
  assert.ok(plan !== undefined && requiresArgument(plan));
  assert.ok(log !== undefined && !requiresArgument(log));
});

test("@ completion ranks basename matches first and inserts quoted paths", async () => {
  const files = ["src/harness/tui/pi-tui-renderer.ts", "src/cli.ts", "docs/my notes.md", "README.md", "tests/renderer.test.ts"];
  const index = new WorkspaceFileIndex({ root: "/repo", lister: async () => files });
  const provider = new InputCompletionProvider(DEFAULT_COMMAND_PALETTE, index);
  const signal = new AbortController().signal;

  const slash = await provider.getSuggestions(["/mo"], 0, 3, { signal });
  assert.equal(slash?.items[0]?.value, "/model");

  const found = await provider.getSuggestions(["look at @render"], 0, 15, { signal });
  assert.equal(found?.prefix, "@render");
  assert.equal(found?.items[0]?.value, "tests/renderer.test.ts");
  const applied = provider.applyCompletion(["look at @render"], 0, 15, { value: "docs/my notes.md", label: "docs/my notes.md" }, "@render");
  assert.equal(applied.lines[0], 'look at @"docs/my notes.md" ');

  const top = searchIndex(buildIndex(files), "");
  assert.deepEqual(top.slice(0, 3).map((entry) => entry.path), ["docs/", "src/", "tests/"]);
  assert.equal(mentionPrefix("email me@example"), undefined, "an @ inside a word is not a mention");
});

test("attachments: image chips and @mentions of existing paths are collected on submit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syn-input-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "app.ts"), "export {};\n");
  await writeFile(path.join(root, "shot.png"), PNG);
  const tray = new AttachmentTray(root);
  const image = await imagePathFromPaste(`"${path.join(root, "shot.png")}"`, root);
  assert.equal(image?.mediaType, "image/png");
  const chip = tray.addImage(image!, "paste-path");
  assert.equal(chip.label, "[image 1]");
  const collected = tray.collect(`compare ${chip.label} with @src/app.ts, @src/ and @missing.ts`);
  assert.deepEqual(
    collected.map((attachment) => [attachment.kind, attachment.displayPath]),
    [
      ["image", "shot.png"],
      ["file", "src/app.ts"],
      ["directory", "src"],
    ],
  );
  assert.deepEqual(tray.collect("no chip left"), [], "the tray clears after submit");
  assert.equal(sniffImage(Buffer.from("BM....")), "image/bmp");
});

test("SGR mouse reports parse and the transcript viewport maps clicks to rows", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<64;10;5M"), { type: "wheel", button: "none", x: 10, y: 5, wheel: -1, shift: false, alt: false, ctrl: false });
  assert.equal(parseSgrMouse("\x1b[<0;3;7m")?.type, "release");
  assert.equal(parseSgrMouse("\x1b[<32;3;7M")?.type, "drag");

  const rows = (lines: string[]) => ({ render: () => lines, invalidate: () => undefined });
  const first = rows(["a1", "a2"]);
  const second = rows(["b1", "b2", "b3"]);
  const header = rows(["header"]);
  const footer = rows(["footer"]);
  const viewport: TranscriptViewport = new TranscriptViewport(
    { children: [first, second], render: () => [], invalidate: () => undefined },
    { siblings: () => [header, viewport, footer], rows: () => 6, hint: (text) => text.slice(0, 20), up: "^" },
  );
  viewport.enabled = true;
  assert.deepEqual(viewport.render(40), ["a2", "b1", "b2", "b3"]);
  assert.equal(viewport.hit(3), second, "screen row 3 is b1");
  assert.equal(viewport.hit(2), first);
  assert.ok(viewport.scroll(3));
  const scrolled = viewport.render(40);
  assert.match(scrolled[0] ?? "", /^\^ 0 more/);
  assert.deepEqual(scrolled.slice(1), ["a1", "a2", "b1"]);
  assert.equal(viewport.hit(3), first, "row 3 is a1, below the header and the hint line");
});
