import { createAuthCommand } from "../auth/index.ts";
import type { AuthMethodKind, AuthStatus, ChoiceAnswer, ChoiceQuestion, CommandIO, RouteBinding, TerminalRenderer } from "../contracts/index.ts";
import { setUserSetting } from "./config-command.ts";
import type { Runtime, RuntimeOverrides } from "./runtime.ts";

/**
 * First run without a conversation route: connect a provider (the same code path as `syn login`),
 * then save its default model as `routes.session` (the same writer as `syn config set`).
 */
export interface ConnectOption {
  readonly provider: "openai" | "anthropic";
  readonly method: AuthMethodKind;
  readonly label: string;
  readonly description: string;
  /** The `routes.session` value saved after sign-in (`provider/model[@adapter]`). */
  readonly route: string;
  readonly binding: RouteBinding;
}

/** In the order the question shows them. */
export const CONNECT_OPTIONS: readonly ConnectOption[] = [
  {
    provider: "openai",
    method: "oauth-subscription",
    label: "ChatGPT subscription",
    description: "sign in with your ChatGPT account in the browser",
    route: "openai/gpt-6-sol",
    binding: { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-chatgpt" },
  },
  {
    provider: "openai",
    method: "api-key",
    label: "OpenAI API key",
    description: "paste a key from platform.openai.com (billed per use)",
    route: "openai/gpt-6-sol@openai-responses",
    binding: { provider_id: "openai", model_id: "gpt-6-sol", adapter_id: "openai-responses" },
  },
  {
    provider: "anthropic",
    method: "api-key",
    label: "Anthropic API key",
    description: "paste a key from console.anthropic.com (billed per use)",
    route: "anthropic/opus-5.5",
    binding: { provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "anthropic-messages" },
  },
  {
    provider: "anthropic",
    method: "cli-bridge",
    label: "Claude Code",
    description: "your Claude subscription through the installed claude CLI",
    route: "anthropic/opus-5.5@claude-code",
    binding: { provider_id: "anthropic", model_id: "opus-5.5", adapter_id: "claude-code" },
  },
];

/** Which already-connected identity wins when several are: subscriptions before pay-per-use keys. */
const AUTO_PICK_ORDER: readonly (readonly [string, AuthMethodKind])[] = [
  ["openai", "oauth-subscription"],
  ["anthropic", "cli-bridge"],
  ["anthropic", "api-key"],
  ["openai", "api-key"],
];

export const MANUAL_CONNECT_COMMANDS = "syn login openai, then syn config set routes.session openai/gpt-6-sol";

/** Whether an auth status is usable for a route (the runtime's own rule: a bridge is "unknown" until Claude Code runs). */
export function identityConnected(method: AuthMethodKind, state: AuthStatus["state"] | undefined): boolean {
  return method === "cli-bridge" ? state === "unknown" || state === "connected" : state === "connected" || state === "expired";
}

/** The option to use without asking: the first connected identity in `AUTO_PICK_ORDER`. */
export function pickConnected(connected: (option: ConnectOption) => boolean): ConnectOption | undefined {
  for (const [provider, method] of AUTO_PICK_ORDER) {
    const option = CONNECT_OPTIONS.find((candidate) => candidate.provider === provider && candidate.method === method);
    if (option !== undefined && connected(option)) return option;
  }
  return undefined;
}

export interface ConnectHost {
  readonly runtime: Runtime;
  readonly renderer: TerminalRenderer;
  readonly overrides: RuntimeOverrides;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly ok: string;
  readonly sep: string;
  choose(question: ChoiceQuestion, signal: AbortSignal): Promise<ChoiceAnswer | undefined>;
  print(lines: readonly string[]): void;
  warn(line: string): void;
}

/** `syn login <provider> --method <method>` inside the session: the same handler, the session renderer's auth prompts. */
export async function signIn(host: ConnectHost, provider: string, method: AuthMethodKind): Promise<boolean> {
  const runtime = host.runtime;
  const handler = createAuthCommand({
    home: () => runtime.home,
    // The runtime's own store: its read cache sees the new credential at once.
    store: () => runtime.credentialStore(),
    providerOptions: { ...(host.overrides.authOptions ?? {}), ...(host.overrides.fetch === undefined ? {} : { fetch: host.overrides.fetch }), env: host.env },
  });
  const io: CommandIO = {
    cwd: host.cwd,
    env: host.env,
    renderer: host.renderer,
    signal: host.signal,
    stdout: (text) => host.print(text.trimEnd().split("\n")),
    stderr: (text) => {
      for (const line of text.trimEnd().split("\n")) if (line !== "") host.warn(line);
    },
  };
  const code = await handler(["login", provider, "--method", method], io).catch(() => 1);
  return code === 0;
}

async function statusOf(runtime: Runtime, option: ConnectOption, signal: AbortSignal): Promise<boolean> {
  const status = await runtime
    .authProvider(option.provider, option.method, "default")
    ?.status(signal)
    .catch(() => undefined);
  return identityConnected(option.method, status?.state);
}

/**
 * Picks a connected identity, or asks which to connect and signs in; then saves `routes.session`
 * and points this runtime's session tier at it. Undefined when the user dismissed the question.
 */
export async function connectProvider(host: ConnectHost): Promise<ConnectOption | undefined> {
  const { runtime, signal } = host;
  const connected = new Map<ConnectOption, boolean>();
  await Promise.all(CONNECT_OPTIONS.map(async (option) => connected.set(option, await statusOf(runtime, option, signal))));
  const found = pickConnected((option) => connected.get(option) === true);
  if (found !== undefined && (await adopt(host, found, true))) return found;
  for (;;) {
    const answer = await host.choose(
      {
        question: "Connect a model provider to start",
        header: "Sign in",
        subtitle: "Synorch needs one provider for the conversation; /model adds more later",
        options: CONNECT_OPTIONS.map((option, index) => ({ label: option.label, description: option.description, ...(index === 0 ? { recommended: true } : {}) })),
        allowOther: false,
        escapeLabel: "quit",
        tone: "neutral",
      },
      signal,
    ).catch(() => undefined);
    if (answer === undefined || answer.kind !== "selected") return undefined;
    const option = CONNECT_OPTIONS[answer.indices[0] ?? -1];
    if (option === undefined) return undefined;
    if (!(await signIn(host, option.provider, option.method))) {
      host.warn(`Sign-in to ${option.label} did not finish ${host.sep} pick again, or Esc to quit`);
      continue;
    }
    if (await adopt(host, option, false)) return option;
  }
}

/** Saves the option's model as `routes.session` and routes this session to it. */
async function adopt(host: ConnectHost, option: ConnectOption, already: boolean): Promise<boolean> {
  try {
    await host.runtime.setSessionRoute("session", undefined, option.binding);
  } catch (error) {
    host.warn(`${option.label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  let saved = true;
  try {
    await setUserSetting(host.runtime.home, "routes.session", option.route);
  } catch (error) {
    saved = false;
    host.warn(`routes.session not saved (${error instanceof Error ? error.message : String(error)}) ${host.sep} syn config set routes.session ${option.route}`);
  }
  host.print([`${host.ok} ${already ? "Using your connected" : "Connected"} ${option.label} ${host.sep} conversation model ${option.route}${saved ? " (saved as routes.session)" : ""}`]);
  return true;
}
