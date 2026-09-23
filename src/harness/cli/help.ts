/**
 * Help texts for the runtime commands. The top-level `syn --help` keeps its original text byte for
 * byte (legacy snapshot, AC-1); each runtime command documents itself with `syn <command> --help`.
 */

const COMMON = `Common options:
  -t, --target <path>          Workspace root (default: current directory).
      --plain                  Append-only output without cursor movement (also SYN_PLAIN=1, TERM=dumb).
      --color always|never|auto
                               Colour override; auto honours NO_COLOR and FORCE_COLOR.
  -h, --help                   Show this help.`;

const SESSION = `Session options:
      --policy autonomous|ask  Approval mode for this session (default: autonomous).
      --profile <tier>=<route> Session-only model route override; repeatable, never persisted.`;

const EXIT_CODES = `Exit codes:
  0 success, 1 internal, 2 usage, 3 approval, 4 provider/tool, 5 verification,
  6 policy, 7 auth, 8 session locked, 9 budget, 130 cancelled.`;

const KEYS = `Keys (interactive):
  Enter sends, Shift+Enter inserts a newline. Ctrl+C cancels the active request; with
  nothing running it offers a safe exit and a second Ctrl+C exits. Esc cancels only.`;

export const COMMAND_HELP: { readonly [command: string]: string } = {
  agent: `syn agent — talk with Synorch, a coding agent for this workspace

Usage:
  syn agent [--continue | --resume <session> | --fork <session>[@<seq>]] [options]

Each message is answered right away. Synorch reads, edits and runs commands in this workspace
directly (every edit is checkpointed; /undo reverts the last one); /plan <goal> hands a large
goal to parallel workers with independent review.

Conversation:
  -c, --continue      Reopen the most recent conversation of this workspace.
  --resume <session>  Reopen a saved conversation.
  --debug             Show the raw event lines under the conversation (also SYN_DEBUG=1).
  --legacy            The previous orchestrated session (every message is a worker run).

${SESSION}

${COMMON}

${KEYS} Ctrl+O shows tool details.

In-session commands: /undo /allow <command> /trust /plan <goal> /diff /context /permissions
/model /log /cancel /help /exit (with --legacy: /plan /tasks /context /permissions /model /diff
/evidence /cancel /memory /help /exit)

${EXIT_CODES}
`,
  run: `syn run — run one goal to completion

Usage:
  syn run "<goal>" [--mode jsonl | --json] [--stream-deltas] [--trust-workspace] [options]
  syn run - [options]            Read the goal from stdin.

Output:
  A terminal gets the interactive view; pipes, CI and --plain get append-only lines.
  --mode jsonl (alias --json) writes only JSONL frames to stdout (hello first, exactly one
  result or error last) and everything human to stderr. --stream-deltas adds delta frames.

Workspace trust:
  Without a full OS sandbox, verification and build/test commands run repository code, and
  any code the AI writes during the session, with your user permissions: it can reach files
  outside the workspace, including your Synorch credentials. Such commands need a trusted
  workspace (syn trust). --trust-workspace trusts it for this run only; a headless run that
  needs trust and lacks it exits 3.

${SESSION}

${COMMON}

${EXIT_CODES}
`,
  runs: `syn runs — list sessions and runs of this project

Usage:
  syn runs [--json] [options]

${COMMON}
`,
  show: `syn show — plan, tasks, attempts, approvals, evidence, cost and routes of one run

Usage:
  syn show <run_…|ses_…> [--json] [options]

${COMMON}
`,
  doctor: `syn doctor --runtime — runtime health: Node and terminal, sandbox, store, auth, capabilities

Usage:
  syn doctor --runtime [--probe-model] [--json] [options]

  No paid request is made unless --probe-model is given. Without --runtime, syn doctor keeps
  validating the generated structure exactly as before.

${COMMON}
`,
  login: `syn login — connect a provider identity

Usage:
  syn login <provider> [--method oauth-subscription|api-key|cli-bridge] [--profile <name>] [--device-code]

${COMMON}
`,
  logout: `syn logout — delete a stored credential

Usage:
  syn logout <provider> [--profile <name>]

${COMMON}
`,
  auth: `syn auth status — list provider identities without secrets

Usage:
  syn auth status [--json]

${COMMON}
`,
  trust: `syn trust — let this workspace's tests and build scripts run without a full sandbox

Usage:
  syn trust [--target <path>]          Trust the workspace (stored in <synorch home>/trust.json).
  syn trust --revoke [--target <path>] Remove the trust record.

  Without a full OS sandbox (Windows today), Synorch cannot confine code that verification and
  build/test commands run, including any code the AI writes during the session: it runs with
  your user permissions and can read and change files outside the workspace, including your
  Synorch credentials. Such commands run only in a trusted workspace. Trust is keyed by the
  workspace path and repository identity, lives only in your user scope and is never read from
  the repository. Grants and revocations are audited. The interactive prompt also offers
  "Trust for this session only", which is never saved.

${COMMON}
`,
  memory: `syn memory — project memory

Usage:
  syn memory status|search|show|related|review|accept|reject|open|reindex [arguments]
`,
};

export function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? `No help is available for ${command}.\n`;
}
