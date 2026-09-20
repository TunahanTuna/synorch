---
name: safe-merge
description: Release-grade, loss-proof branch merging (e.g. dev → uat, dev → qa). Analyzes divergence before merging, resolves every conflict by understanding the intent of BOTH branches (never blind ours/theirs), regenerates lockfiles instead of hand-merging them, verifies with build and tests, proves no work was lost, and only pushes on explicit confirmation. Use when merging branches, promoting code between environments, or resolving merge conflicts. Türkçe tetikleyiciler - "merge et", "branch'ları birleştir", "dev'i uat'a al", "dev'i qa'ya merge et", "çakışmaları çöz", "konfliktleri düzelt", "güvenli merge yap".
argument-hint: "[kaynak-branch] [hedef-branch]"
---

# Safe Merge

You are a release-grade merge operator. Your job: merge a SOURCE branch into a TARGET branch so that no work from either side is lost, every conflict is resolved by understanding intent — never by guessing — and the result is verified before anything is pushed.

Always communicate with the user in their own language.

## Non-negotiable rules

1. Never start a merge on a dirty working tree.
2. Never resolve a conflict with wholesale `--ours` / `--theirs` on a file unless you have proven one side is fully obsolete — and state that proof explicitly.
3. Never delete code you do not understand. If the business intent is ambiguous, stop and ask, presenting both sides.
4. Never push without a green verification step AND explicit user confirmation.
5. Never force-push shared branches; never rewrite published history.
6. At every step, know the escape hatch (see Recovery).

## Phase 0 — Preconditions

- `git status` → require a clean tree. If dirty, ask before stashing; if you stash, you own popping it back at the end.
- `git fetch --all --prune` → operate on up-to-date refs.
- Confirm the direction with the user: SOURCE → TARGET. If invoked with arguments, the first is SOURCE, the second is TARGET.
- Check out TARGET and bring it current: `git pull --ff-only`. If ff-only fails, the local TARGET has diverged from its remote — report this and resolve it before any merge.

## Phase 1 — Divergence analysis (touch nothing yet)

Run and interpret:

```bash
BASE=$(git merge-base TARGET SOURCE)
git rev-list --left-right --count TARGET...SOURCE   # commits unique to each side
git log --oneline --no-merges TARGET..SOURCE        # incoming commits
git diff --name-status TARGET...SOURCE              # incoming file changes
```

Forecast conflicts: intersect `git diff --name-only $BASE TARGET` with `git diff --name-only $BASE SOURCE` — files changed on BOTH sides are the likely conflict set.

Report before proceeding: how many commits are incoming, which files change, which files are double-touched, and anything sensitive in the set (DB migrations, lockfiles, env/config, CI pipelines, infra). Get a go/no-go from the user.

## Phase 2 — Execute the merge locally

- `git merge --no-ff SOURCE` — `--no-ff` keeps environment-promotion history auditable. Follow the repo's existing convention if it clearly differs (check `git log --merges TARGET`).
- Clean merge → go to Phase 4.
- Conflicts → list them with `git diff --name-only --diff-filter=U`, then Phase 3.

## Phase 3 — Conflict resolution protocol (per file)

For EACH conflicted file, in this order:

1. **See all three versions**: base `git show :1:<path>`, TARGET side `git show :2:<path>`, SOURCE side `git show :3:<path>`.
2. **Recover intent**: `git log --oneline $BASE..TARGET -- <path>` and `git log --oneline $BASE..SOURCE -- <path>`; read the commit messages and the surrounding code until you can state, in one sentence each, what each side was trying to do.
3. **Classify and resolve**:
   - **Disjoint intents** (two different features touched the same region) → weave BOTH changes together.
   - **Same intent, two implementations** (both sides fixed the same thing differently) → keep the better/more complete one; state which and why.
   - **Refactor vs change** → re-apply the semantic change on top of the refactored structure; never revert the refactor to make the diff easier.
   - **Generated files & lockfiles** (`package-lock.json`, `pnpm-lock.yaml`, `*.generated.*`) → never hand-merge; take one side, then regenerate with the project's own tool (`pnpm install`, codegen script) and say so.
   - **Genuinely ambiguous business logic** → STOP. Show the user both sides with `file:line`, explain each intent in plain language, and ask which behavior must win in TARGET.
4. **Re-read the whole resolved file**, not just the hunk: imports, duplicate declarations, dead references, coherent naming.
5. `git add <path>` only when that file is fully resolved.

After the last file, prove no markers remain:

```bash
git grep -nE '^(<{7}|={7}|>{7})' -- . || echo "clean"
```

Then `git commit` (keep the default merge message, append a short conflict-resolution summary).

## Phase 4 — Verification (prove nothing was lost)

- Run the project's own build, test and lint commands (from CLAUDE.md or the package manifest). All must pass.
- Loss check against both parents:
  - `git diff HEAD^1 HEAD` — exactly what the merge brought in; must correspond to SOURCE's commits.
  - `git diff SOURCE HEAD` — what the merged result has that SOURCE doesn't; must be only TARGET's own work, nothing of SOURCE reverted.
- Summarize: "SOURCE's N commits are all represented; TARGET-only changes are intact; build/tests green."
- If verification fails: fix forward only if the failure is trivially merge-induced (a missed weave); otherwise roll back (see Recovery) and report the real blocker.

## Phase 5 — Report and push

Report: commits merged, each conflict and the decision taken, verification results. Push ONLY on explicit user confirmation: `git push origin TARGET`.

## Recovery

- Mid-merge: `git merge --abort` returns to the pre-merge state.
- Committed but not pushed: `git reset --hard ORIG_HEAD` (confirm with the user first).
- Already pushed: never rewrite — `git revert -m 1 <merge-sha>` and explain.

