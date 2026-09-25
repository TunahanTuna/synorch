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
  no per-server approval since you installed the plugin). **Agents and hooks are listed but not
  supported yet; hooks never run.**

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
