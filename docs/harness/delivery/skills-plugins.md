# Skills, commands and plugins (K7)

Synorch uses Claude Code's formats as they are: `SKILL.md` skills, markdown slash commands and
Claude Code plugins. Anything you already have for Claude Code works in Synorch on every provider
(OpenAI, Claude Code, Anthropic API), and you can add your own.

## Where skills and commands come from

Highest precedence first when two share a name (`/skills` shows the shadowed one too):

| Source  | Skills (`<name>/SKILL.md`)                                   | Commands (`<name>.md`)                  |
| ------- | ------------------------------------------------------------ | --------------------------------------- |
| project | `.synorch/skills/`, `.claude/skills/`, `.agents/skills/`     | `.synorch/commands/`, `.claude/commands/` |
| user    | `~/.synorch/skills/`                                         | `~/.synorch/commands/`                  |
| plugin  | plugins installed with `syn plugin install` (`<plugin>:<name>`) | same                                 |
| claude  | `~/.claude/skills/`, plugins enabled in Claude Code          | `~/.claude/commands/`, plugin commands  |
| builtin | the Synorch skills (a repository's legacy `.ai/skills/` is still served as before) | –             |

- Project items are repository content: they are listed as **needs trust** until the workspace is
  trusted (`/trust` or `syn trust`).
- Frontmatter: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`,
  `disable-model-invocation`, `user-invocable`; other keys are ignored. `allowed-tools` is shown but
  Synorch's permission mode still decides. Dynamic `` !`command` `` lines are not run.
- Placeholders: `$ARGUMENTS`, `$ARGUMENTS[n]`, `$0`, `$1`…, named `$arg`, `${CLAUDE_SKILL_DIR}`,
  `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`. Arguments a body never references are appended.

## Using them

- The model sees a one-line catalog and loads a skill with `load_skill` when it needs it.
- You run one yourself: every skill and command is in the `/` palette as `/<name> [args]`; the body
  and your arguments go into the next message.
- `/skills` (or `syn skills list`) lists name, source, state and description; `/skills show <name>`,
  `/skills enable|disable <name>` (saved as `skills.disabled` in `~/.synorch/config.yaml`).

## Plugins

A plugin is a directory in the Claude Code plugin format: `.claude-plugin/plugin.json` (`name`,
`version`, `description`) and any of `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`.

```
syn plugin install ./my-plugin            # a local directory
syn plugin install https://github.com/org/plugin.git
syn plugin marketplace add org/marketplace-repo   # .claude-plugin/marketplace.json
syn plugin install my-plugin@my-marketplace
syn plugin list | remove <name> | enable <name> | disable <name>
```

- Install shows what the plugin contains (skills, commands, MCP servers, agents, hooks) before it is
  installed; in a session `/plugins install <spec>` asks in the choice modal. Installing is your
  explicit trust decision for that plugin. Plugins live in `~/.synorch/plugins/installed/<name>/`.
- `name@marketplace` also resolves against the marketplaces Claude Code already knows.
- Marketplace plugin sources supported: relative path, `github`, `url`, `git-subdir`
  (`npm`, `archive` and `command` sources are not yet).
- Supported now: skills, commands and MCP servers (registered with the MCP manager; `/mcp` shows them,
  no per-server approval since you installed the plugin), agents (worker personas, below) and hooks
  (only after you approve them, below).
- `/plugins show <name>` (or `syn plugin show <name>`) lists a plugin's contents, every hook
  command and its agents.

## Hooks

Claude Code's hook format, as written for Claude (`hooks/hooks.json` of a plugin, or the manifest's
`hooks`), plus your own under `hooks:` in `~/.synorch/config.yaml` (user layer only; a repository's
configuration cannot add hooks):

```yaml
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ~/bin/check-command.sh
          timeout: 20        # seconds
```

Supported events (the ones that map onto Synorch's loop; others are listed as unsupported and never
run, as are `http`/`prompt`/`agent`/`mcp_tool` hook types):

| Event            | When                                                        | What a hook can do                                                  |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| SessionStart     | before the first turn (`source`: startup, resume or fork)   | stdout / `additionalContext` joins the first message                |
| UserPromptSubmit | each typed prompt (`prompt`)                                 | exit 2 / `decision: "block"` drops the prompt; stdout adds context |
| PreToolUse       | each tool call, after the policy decided, before any prompt | exit 2 / `permissionDecision: "deny"` denies; `"ask"` makes an allowed call ask |
| PostToolUse      | after a tool ran (`tool_response`)                           | `additionalContext`, `decision: "block"` reason or exit-2 stderr is appended to the result for the model |
| Stop             | after a completed turn (`stop_hook_active`)                  | exit 2 / `decision: "block"` continues with the reason (at most 3 turns in a row) |

Tool names follow Claude Code so Claude plugin matchers work; matchers also accept Synorch's names:

| Synorch       | Claude (`tool_name`) | `tool_input` adds                          |
| ------------- | -------------------- | ------------------------------------------ |
| `exec`        | `Bash`               | `command` (argv joined), `timeout`, `run_in_background` |
| `read_file`   | `Read`               | `file_path` (absolute)                     |
| `write_file`  | `Write`              | `file_path`                                |
| `apply_patch` | `Edit` (`MultiEdit` matches too) | `file_path` (first patched file), `file_paths` |
| `search`      | `Grep`               | `path` (absolute)                          |
| `glob`        | `Glob`               | `path` (absolute)                          |
| `list_dir`    | `LS`                 |                                            |
| `web_fetch` / `web_search` | `WebFetch` / `WebSearch` |                             |
| `todo`        | `TodoWrite`          |                                            |
| MCP tools     | `mcp__<server>__<tool>` (unchanged) |                             |

Other Synorch tools (`git_status`, `git_diff`, `process_*`) keep their own names. The original
Synorch arguments stay in `tool_input` next to the Claude-shaped keys.

How a hook runs: JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `permission_mode` mapped to
Claude's names, plus the event's fields; `transcript_path` is empty), in the workspace directory,
with your environment plus `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
`SYNORCH_HOOK_EVENT` and `SYNORCH_HOOK_SOURCE` (`${VAR}` placeholders in the command are expanded).
Shell form goes to `SYNORCH_HOOK_SHELL`, else `/bin/sh -c` (Git Bash on Windows when installed, cmd
otherwise); with `args` the command is spawned directly. Timeout: the hook's `timeout`, else 60 s
(30 s for UserPromptSubmit), at most 600 s; a timed-out hook never blocks. stdout and stderr are
capped at 64 KiB each. Exit 0 reads the JSON answer (`continue: false`, `decision`, `reason`,
`systemMessage`, `hookSpecificOutput.*`); exit 2 blocks with stderr as the reason; any other exit
code is a non-blocking error shown as a note. Matching hooks run one after another.

### Safety model

- **Your hooks** (config `hooks:`) run as written — you wrote them.
- **Plugin hooks run only after you approve them.** `/plugins install` asks in the choice modal
  with every hook command listed (`syn plugin install` asks too; `--allow-hooks` approves up front).
  The approval stores a digest of the hook definitions and the plugin directory in
  `~/.synorch/plugins/hook-approvals.json`; a changed plugin (new hooks or a new version) stops
  running its hooks and asks again at the next session start (interactive; headless sessions note it).
- **Claude Code plugins' hooks are off by default** in Synorch: `/plugins hooks approve
  <name@marketplace>` (or `syn plugin hooks approve`) turns them on. They are **never run on Claude
  Code native routes**: Claude Code runs its own plugins' hooks there, so Synorch never runs them
  twice (tools reached through the Synorch bridge on those routes skip them too). Your own and
  Synorch plugins' hooks still run there — on Synorch's bridge tools, and PreToolUse also on Claude's
  built-in tools through the native permission check.
- Hooks can deny or narrow, never widen: `permissionDecision: "allow"` and `updatedInput` are
  ignored; the policy engine and its hard rails decide first, and a hook only runs for calls the
  policy did not already deny. Harness-initiated calls (verification commands) run no hooks.
- `/plugins hooks` lists every hook source and whether it runs; `/plugins hooks revoke <plugin>`
  stops a plugin's hooks. `~/.claude/settings.json` hooks are not read (Synorch reads only
  `enabledPlugins` there); Claude runs them itself on Claude routes.

## Agents (worker personas)

A plugin's `agents/*.md` (Claude Code subagent format: frontmatter `name`, `description`, `tools`,
`model`; the body is the system prompt) are offered to the orchestrator as worker personas:

- The planning prompt lists each agent as `<plugin>:<name>` with its base role and tier. The
  orchestrator may set `agent` on a plan task; the agent's body (up to 8 KiB) is layered onto that
  task's packet as extra instructions under the task's role, scope and policy, which it never widens.
- Base role: implementer by default; an agent whose `tools` has no write/exec tool (Bash, Edit,
  Write, MultiEdit, NotebookEdit, PowerShell) is a reviewer (name or description mentions review or
  audit) or an explorer.
- `model`: `opus`/`sonnet` → `complex_worker`, `haiku` → `fast_worker` (the task's tier is set to
  it); `inherit` or a model id keeps the orchestrator's choice. Your routes for that tier still pick
  the actual provider and model.
- `/agents` lists them (`/agents show <id>`), `/plugins show <plugin>` too; `syn plugin agents`.

## Claude Code's own skills and plugins

On by default, read in place, never copied or changed:

- `~/.claude/skills/`, `~/.claude/commands/` (`skills.include_claude: false` turns them off).
- Plugins installed in Claude Code (`~/.claude/plugins/installed_plugins.json`), enabled or not as
  `enabledPlugins` in `~/.claude/settings.json` says (project/local-scope installs of this repo also
  follow its `.claude/settings*.json` once trusted). `plugins.include_claude: false` turns them off;
  `syn plugin disable <name@marketplace>` turns one off for Synorch only.
- Synorch reads only `~/.claude/skills/**`, `~/.claude/commands/**`, `~/.claude/plugins/**` and the
  `enabledPlugins` key of `~/.claude/settings.json` — never credentials or anything else there, and
  it never writes under `~/.claude`.
- On Claude Code routes Claude already loads its own skills and plugins, so Synorch does not add
  them again; your Synorch skills and plugins still reach Claude through `load_skill`.
