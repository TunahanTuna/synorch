# Terminal polish: UX evidence (before / after)

> 2026-09-24 · [terminal polish brief](../../design/terminal-polish-brief.md) P0 baseline and the P0/P1 slices built on it.
> Frames are text snapshots of the visible terminal rows, not images.

## How the frames were made

`node tests/fixtures/ux/capture.ts <out-dir> [--color] [--ascii] [--only <name>]` runs the real
`syn agent` (real runtime, store, policy and tools; a scripted model streaming word-sized deltas with
a small delay) inside a headless xterm (`@xterm/headless`) through the renderer's `terminal` seam, at
**80×24, 120×40 and 40×20**. For every scenario it records the visible rows, Enter → user line and
Enter → activity line latency, the number of full redraws (writes that clear screen + scrollback),
and, while the reader is scrolled up, whether the viewport moved.

- `before/` — commit `c7608d6` (the brief's base), captured with the same script.
- `after/` — this branch.

Scenarios: `01-startup` (first screen, `?`), `02-short-question`, `03-direct-edit` (read, edit, test,
`/diff`), `04-tool-heavy` (~20 tools incl. a failing read, Ctrl+O), `05-approval` (ask mode),
`06-esc-interrupt`, `07-scrolled-up-stream` (60-line answer while scrolled up 8 lines), `08-board`
(live orchestration board from the view fixtures; a full plan run is not scripted here).

**Not covered:** a real Windows Terminal / ConPTY session (no PTY library in the repo). The headless
xterm parses the same bytes, but paint time, font fallback and ConPTY chunking are not measured. The
owner's 10-minute trial (HREQ-039) is still the gate.

## Frictions found in the baseline

| # | Where | What the frames show |
| --- | --- | --- |
| F1 | First screen | Header says `autonomous` (policy name), footer says `auto mode`: two names for one thing. The editor is two bare rules with no prompt and no hint; nothing says what to type or where help is. |
| F2 | Narrow footer | At 40 columns the footer is cut mid-field: `ws · master · sol-large · auto mode...` / `ask mode ...` — the permission mode is the part that gets lost. |
| F3 | Enter → activity | The user line appears in 1–4 ms, but the activity line waits for the session's `turn/started`: 17–85 ms. |
| F4 | Streaming | The activity line says `Thinking…` while the answer is visibly streaming. |
| F5 | Tool rows | Three lines per tool (blank, `● Title`, `⎿ summary`): 20 tools fill two screens. Status is colour only — with `NO_COLOR` a failed read and a successful one both show `●`. `⎿ ✓ exit 0 · …` repeats the status, `1 lines`, raw `ENOENT … stat 'C:\Users\…\Temp\…'` with an absolute temp path. |
| F6 | Turn end | No result line: after an edit you scroll up to find what changed; whether tests ran is only in the model's own words ("The test passes now"). |
| F7 | Approval | Drawn as an overlay composited over the transcript and footer; at 40 columns lines overlap and are unreadable. Text uses internal names (`apply_patch [workspace-write] write src/add.mjs`, `why workspace-write needs your approval`) and does not show the edit being approved. `✓ Allowed` lands after the tool's result line, out of order. |
| F8 | `/diff` | Lists file names only; no content, no counts. |
| F9 | Working | While Synorch works, nothing says that typing steers it. |
| F10 | Mouse mode | The app-managed viewport says "N more lines above" but not that new output arrived below. |

What already worked and was kept: **no full redraws while streaming** (0 in every scenario),
the terminal's own scrollback keeps the reader's place while output grows (`viewportY` unchanged
while scrolled up: 42→42, 75→75), Esc keeps the partial answer and says `Interrupted`, the board
updates in place and pins a summary. Ctrl+O causes 2 full redraws by design (it re-renders history).

## What changed (after)

| Friction | Change |
| --- | --- |
| F1, F2 | Header is static: `Synorch 0.3.0 · folder (branch)` + at most one safety warning (the header is never redrawn, so it only holds what cannot change). Model, permission mode and ctx% live in the footer, which updates in place, with `? shortcuts` right-aligned. Narrow screens drop fields by priority (hint → cost → branch → folder → model); the mode and ctx% never drop. The editor has a `>` prompt and a placeholder (`Ask anything or describe a change · / commands · @ files`); `?` on an empty editor shows a shortcut table that reflows to the width. |
| F3 | Enter marks the turn as pending: the activity line appears with the user line (1–3 ms in every scenario). It clears on the session's turn events or on an error notice. |
| F4 | `Responding…` while text streams; `Thinking` / `Reading` / `Running …` / `Editing` otherwise. |
| F5 | One line per tool at L0: `✓ Read src/add.mjs  3 lines`, `✓ Edit src/add.mjs  +1 −1`, `✓ Run node --test  12 passed · 1.2s`. Distinct glyphs per status (`✓ ✗ ! ●`; ASCII `+ x ! *`), so colour is never the only signal. Failures, denials and interruptions keep their reason on a `⎿` line. Consecutive tool rows have no blank line between them. Errors in plain words (`file not found`), absolute paths shortened. Plain mode keeps its existing `tool: … - summary` lines. |
| F6 | Turn-end result line, only when files changed or tests ran: `✓ Changed src/add.mjs (+1 −1) · Tests: 12 passed · /diff for details`. An edit without a test run says `! … Tests: not run`; a failing run says `✗ … Tests: 3 failed`. It is computed from the tool results, never from the model's text. Plain mode prints it as `result: …`. |
| F7 | Approval (and the model picker / secret prompts) render **inline in place of the editor**, between two rules, wrapping with the width; the draft is kept. The prompt names the action as the transcript does (`Edit src/add.mjs  +1 −1`, `$ npm run lint --fix`) with the edit's diff (≤ 8 lines), what allowing means, numbered choices and a key hint. The policy's generic reason is hidden; a specific one stays (`why: …`). The footer shows `approval waiting`. A one-off decision no longer prints a separate line (the tool row shows it); a lasting grant prints `✓ Allowed for the rest of this session`. |
| F8 | `/diff` shows every file Synorch changed in this conversation (undone edits excluded), from the content before its first edit to the file on disk now: `+added −removed` per file and a compact diff with line numbers and two lines of context (≤ 40 lines per file, then a count and the `git diff` command). Worker-integrated files are listed below. Plain mode prints the same view. |
| F9 | While work runs the placeholder reads `Type to steer Synorch · it reads your message at its next step`. |
| F10 | Mouse mode: `↓ new output below` joins the scroll hint when lines arrive while you read history. |

P1 polish in the same pass: the editor's rules and placeholder follow the ASCII glyph set
(`SYN_GLYPHS=ascii` screens are 7-bit), `NO_COLOR` screens keep every meaning through glyphs,
the result line wraps with an indent at 40 columns, diff lines are removal-before-addition.

## Numbers (headless xterm, this machine)

`before/metrics.txt` and `after/metrics.txt` hold every run. Summary:

| | before | after |
| --- | --- | --- |
| Enter → user line | 1–4 ms | 1–5 ms |
| Enter → activity line | 17–50 ms (85 ms in one earlier run) | 1–3 ms |
| Full redraws while streaming / scrolled up | 0 | 0 |
| Reader's viewport moved while scrolled up | no | no |
| Rows for the whole 20-tool turn incl. header and editor (80×24) | ~58 | ~43 (tool rows alone: 34 → 16) |

## Try it

1. `syn agent` in Windows Terminal: read the first screen (folder, model, mode, prompt, hint), press `?`.
2. Ask a question; watch the activity line appear with your message and say `Responding…`.
3. Ask for a small fix with a test; read the result line, then `/diff`.
4. `Shift+Tab` to ask mode and ask for an edit: approve with `1`, deny with `3`/Esc.
5. Resize to ~40 columns and repeat; set `NO_COLOR=1` and `SYN_GLYPHS=ascii`.

## Remaining rough edges

- No real-PTY measurement; paint latency and flicker on ConPTY are unmeasured.
- Ctrl+O and opening a worker view still repaint the whole screen (history is re-rendered).
- In the native (non-mouse) mode the terminal owns scrollback, so Synorch cannot show a
  "new output below" marker there; it only guarantees it never yanks the view (no full redraws).
- The long answer pushes the editor down line by line while it streams; a
  fixed-height live region would need the alternate screen, which ADR-04 rejected for scrollback.
- The header no longer shows the model; it is in the footer.
