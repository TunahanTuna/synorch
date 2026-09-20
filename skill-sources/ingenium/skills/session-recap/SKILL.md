---
name: session-recap
description: Recover and distill what happened in a previous Claude Code session in this project, so work continues in a fresh session without replaying it - locate the on-disk transcripts under ~/.claude/projects, list recent real sessions, extract the user's verbatim intent, files touched, research performed, dead ends, denied tools and interruptions with a bundled script instead of reading raw JSONL into context, cross-check every claim against git to flag what was committed, left uncommitted or changed since, then emit a resumable brief and save it under .claude/sessions/. Use when starting a fresh session on work that was already in progress, when asking what was done last time or where things were left off, when a previous session ran out of context, or when a summary of prior work is needed. Türkçe tetikleyiciler - "geçen sefer ne yapmıştık", "son oturumu özetle", "kaldığımız yerden devam", "önceki session'ı getir", "dün ne yaptık", "en son nerede kalmıştık", "context doldu özet çıkar", "önceki konuşmanın özetini çıkar".
---

# Session Recap

Claude Code already writes every session to disk. So "what were we doing?" is not a memory problem — it is an **extraction** problem, and extraction beats recollection every time. This skill reads the transcript mechanically, then makes git the judge of whether any of it is still true. Its output is a brief written to be *resumed from*, not a story to be read.

Always communicate with the user in their own language.

## Non-negotiables

1. **Never read a raw `.jsonl` transcript into context.** They reach megabytes; loading one spends the budget the recap exists to protect. The bundled script is the only reader.
2. **A transcript records what was *said*, not what is *true*.** An assistant claiming "fixed it" proves nothing. Every claim about current state gets confirmed against git or the file, or it ships labelled unverified.
3. The user's own prompts are the intent ground truth. Preserve their wording for goals and constraints; do not paraphrase a requirement into something softer.
4. Report gaps as gaps. A recap that quietly omits an unresolved failure is worse than no recap.

## Phase 1 — Find the session

Run the bundled extractor (path is relative to this skill's base directory):

```bash
python scripts/extract_session.py --list
```

It resolves the transcript directory from the current `cwd` (each project maps to `~/.claude/projects/<cwd with every non-alphanumeric character replaced by ->`, with a `cwd`-matching fallback), then lists recent sessions newest-first with title, id, time window, prompt count, files touched, and opening prompt. Sessions with **no typed prompt** — headless `-p` runs, aborted starts — are hidden as noise; `--all` reveals them.

**Identifying the live session is your job, not the script's.** It flags any transcript written in the last 60s as `POSSIBLY THE SESSION YOU ARE IN` and prints a `Suggested:` id, but idle time is only a hint — a second session open in another window defeats it, in both directions. You hold the ground truth the script cannot: you know what was said in *this* conversation. So before summarizing, compare the candidate's opening prompt and prompt count against this conversation. If they match, it is this session — take the next one down, or pass `--exclude-session <id>`.

Say which session was picked in one line, so a wrong pick costs the user one word to correct. If they named a topic ("the Tailwind one"), match on title and opening prompt instead of asking. If they want *this* session summarized for a handoff to a new window, that is a legitimate request — pass its id explicitly.

## Phase 2 — Extract the digest

```bash
python scripts/extract_session.py --session <id-prefix>      # explicit id — bypasses every filter
python scripts/extract_session.py --session latest           # newest non-flagged, non-excluded
python scripts/extract_session.py --session latest --json     # machine-shaped
```

An explicit id always wins over the filters, so a session you deliberately named is never "not found".

The digest carries: title, window, cwd, branches, record count, **verbatim user prompts in order**, files touched with edit-call counts, research (`WebSearch`/`WebFetch` queries and URLs), skills loaded, subagents dispatched, commands run, tool errors, denied tool calls, interruption count, and the final assistant state.

Long sessions: `--prompt-chars 200` tightens the biggest section. If the digest is still large, read it and work from it — do not paste it wholesale into the recap.

## Phase 3 — Make git the judge

The digest's `window` gives exact bounds. Establish what survived:

```bash
git log --since="<started>" --until="<ended>" --format='%h %ad %s' --date=short
git status --short
git log --since="<ended>" --format='%h %s' -- <file-from-digest>   # changed after the session
git stash list
```

Classify every touched file: **committed** (in a window commit), **uncommitted** (in `git status`), **superseded** (commits after the window touched it), or **vanished** (no longer exists — say so plainly; the work may have been reverted). Untracked-and-absent from both git and disk is the loudest signal in the whole recap.

Also reconcile the branch: if the digest's branch differs from the current one, the work may not be reachable from here at all. Check before assuming.

## Phase 4 — Compose the brief

Write to `.claude/sessions/<YYYY-MM-DD>-<slug>.md` **and** print it in the chat. Fixed sections, in this order — front-load resumption, because that is what the reader needs first:

1. **Resume here** — one paragraph of state plus the single concrete next action. Written so someone with zero context can act on it.
2. **Goal / acceptance** — what the work was for, in the user's own words.
3. **Done, with evidence** — per item: what changed, which files (`path:line` where known), and its git classification from Phase 3.
4. **Decisions and why** — so the next session does not relitigate settled choices. Include ones the user made in their prompts.
5. **Dead ends — do not retry** — from tool errors, denied calls, interruptions and user corrections, each with the reason it failed. The highest-value section and the first thing ordinary summarization loses.
6. **Research findings** — the queries *and* the conclusion drawn from them. A bare URL list is not a finding.
7. **Open ends / unverified** — tests not run, builds not attempted, claims not confirmed, questions left hanging.
8. **Staleness** — what changed in the repo after the session; explicit "recap is current as of `<commit>`".
9. **Anchors** — `file:line` and symbol names for the next session to read directly, not prose directions.

Sections with nothing in them are marked `—`, never padded. Target 60–150 lines; a recap that rivals the transcript has failed at its job.

If `.claude/` is tracked by git in this repo, say so once and let the user decide whether the recap gets committed — never commit it unasked, and never silently edit `.gitignore`.

## Phase 5 — Hand off

Close with the next action as a question the user can answer with one word ("Kaldığı yerden `xs:` breakpoint denetimine devam edeyim mi?"). If the recap surfaced a contradiction — a file the transcript claims was written but git has never seen — raise that before proposing any work.

## Rules

- Prompt count and file count are the session's weight class. A 3-prompt session gets a 15-line recap; reserve the full nine sections for real work.
- Prefer the user's phrasing over your own for goals, constraints and rejections.
- Subagent (`isSidechain`) activity is summarized as outcomes, never replayed.
- A session spanning several unrelated tasks gets segmented by topic, not flattened into one narrative.
- The digest is disposable; the brief is the artifact. Do not keep the digest around after writing the brief.

## Anti-patterns

Reading transcripts with Read/Grep instead of the script; repeating the assistant's self-congratulation as fact; a chronological retelling ("first we…, then we…") instead of a resumable state; dropping dead ends because they feel like failure; trusting the `POSSIBLY THE SESSION YOU ARE IN` flag instead of checking the candidate against this conversation; recaps with no git verification (fiction with timestamps); paraphrasing a hard requirement into a vague one; committing recap files nobody asked to commit.

