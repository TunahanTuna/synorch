# Install `syn` globally from this checkout

Goal: a `syn` command that works from any folder, without `node <repo>\dist\cli.js` and without `syn init`
(the built-in canonical structure in `src/harness/cli/canonical.ts` is used when a repo has no `.ai/`).

Requires Node.js 24+ and pnpm. Run from the repo root.

## Option A — self-contained copy (recommended)

```powershell
pnpm install
pnpm run install:global
```

`scripts/install-global.mjs` runs `pnpm build`, `npm pack` into a temp folder and `npm install -g <tarball>`.
The installed copy lives under npm's global prefix (`npm prefix -g`, on Windows usually
`%APPDATA%\npm`) and does not depend on this checkout — you can switch branches or delete `dist/` freely.
Re-run the same command to update. Extra arguments go to `npm install -g`
(e.g. `pnpm run install:global -- --prefix C:\scratch\syn` for a throwaway install).

## Option B — linked to the checkout (live rebuilds)

```powershell
pnpm install
pnpm run link:global      # pnpm build && npm install -g .
```

`npm install -g .` links the global `syn` to this folder, so every later `pnpm build` is picked up
immediately. The checkout must stay in place and keep its `node_modules`.

## Use

```powershell
syn                 # interactive terminal: opens the agent session (like `claude`)
syn --version       # 0.3.0 (<short commit>) — the commit comes from dist/build-info.json
syn doctor --runtime
syn agent --help
```

Piped/non-interactive `syn` with no arguments still prints the help text (legacy behaviour).
Open a new terminal after the first install so the updated `PATH` is picked up.

## Uninstall

```powershell
npm uninstall -g synorch
```

## How the package stays self-contained

- `bin` points `syn`/`synorch` at `dist/cli.js` (`#!/usr/bin/env node`); npm generates the `syn.cmd`/`syn.ps1` shims on Windows.
- `dist/` is compiled JavaScript; Node's type stripping is not needed (and does not run inside `node_modules`).
- Runtime assets resolve from `import.meta.url`, never from the cwd: bundled skills (`skill-sources/`, listed in `files`),
  the Claude Code MCP relay (`dist/harness/providers/claude-code/mcp-relay.js`), and `dist/build-info.json`.
- Templates, protocols, roles and the built-in canonical structure are TypeScript modules compiled into `dist/`.
- `pnpm build` cleans `dist/` first, so stale files from deleted sources never ship.
