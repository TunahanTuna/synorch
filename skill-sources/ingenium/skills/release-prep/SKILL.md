---
name: release-prep
description: Prepare a release end-to-end - analyze commits since the last tag, decide the semver bump with stated reasoning, generate a categorized changelog (breaking/features/fixes), update every version location, write human release notes, and create the annotated tag and GitHub release only on confirmation. Use when cutting or preparing a release, writing a changelog, bumping versions, or drafting release notes. Türkçe tetikleyiciler - "release hazırla", "sürüm çıkar", "changelog oluştur", "versiyon artır", "yayın notları yaz", "release notu hazırla", "tag at".
argument-hint: "[versiyon | major|minor|patch]"
---

# Release Prep

You prepare releases with zero-surprise changelogs: everything user-visible is in the notes, nothing invented, versions consistent everywhere, and nothing published without confirmation.

Always communicate with the user in their own language.

## Phase 1 — Establish the baseline

- Last release: `git describe --tags --abbrev=0` (fall back to the version in the manifest, or ask if the repo has never been tagged).
- Collect the delta: `git log <last-tag>..HEAD --oneline --no-merges` and `git diff --stat <last-tag>..HEAD`.
- Confirm the working tree is clean and CI/tests are green before promising a release.

## Phase 2 — Categorize the changes

- If the repo uses conventional commits, parse types (`feat`, `fix`, `perf`, `BREAKING CHANGE`) — but spot-check diffs; commit messages lie by omission.
- Otherwise read the diffs and categorize yourself.
- Buckets: **Breaking** / **Features** / **Fixes** / **Performance** / **Internal** (refactors, deps, CI — usually collapsed to one line).
- Flag anything user-visible that lacks a clear commit message; those need honest changelog lines written from the diff.

## Phase 3 — Decide the version

- Semver: breaking → major, feature → minor, fix-only → patch. Pre-1.0: breaking → minor, everything else → patch.
- If the user passed a version or bump keyword as an argument, honor it — but warn if it contradicts the evidence (e.g. patch requested but a breaking change exists).
- State the decision and the one-line reason.

## Phase 4 — Apply the version everywhere

- Find every version location — search, don't assume: package manifests (all workspace packages that version together), `plugin.json`, version constants in code, docs badges, install snippets in README, API spec `info.version`.
- Update them consistently; mismatched versions across files is the classic release bug.
- Update `CHANGELOG.md` in Keep a Changelog format: new section at the top with version and date (get the date from the system, e.g. `git log -1 --format=%cd`), bucketed entries, links to PRs/issues where the repo convention does that.

## Phase 5 — Release notes for humans

Changelog lists what changed; release notes say why it matters. Write a short summary: the headline change, anything users must do (migrations, breaking-change steps), notable fixes. Write them in the repository's language; provide Turkish and English versions when the user asks or the audience is mixed.

## Phase 6 — Tag and publish (confirmation gate)

Only after the user confirms:

- Commit the version + changelog changes.
- Annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
- Push branch and tag: `git push && git push origin vX.Y.Z`.
- If the repo uses GitHub releases: `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>`.

## Rules

- Never rewrite or move a published tag; a botched release gets a new patch version.
- Verify the build passes with the bumped version before tagging.
- No secrets, internal URLs or customer names in changelogs or notes.
- The changelog is append-only history; never rewrite old entries beyond typo fixes.

