import os from "node:os";
import path from "node:path";
import {
  AUTH_METHODS,
  authStatusSchema,
  credentialRefSchema,
  EXIT_CODES,
  HarnessError,
  profileNameSchema,
  ProviderFailure,
  type AuthMethodKind,
  type AuthStatus,
  type CommandHandler,
  type CommandIO,
  type ExitCode,
  type ProviderErrorCode,
} from "../contracts/index.ts";
import { createCredentialStore, type SynorchCredentialStore } from "./credential-store.ts";
import { ProfileStateStore } from "./profile-state.ts";
import { authProviderFor, createAuthProviders, SUPPORTED_AUTH_METHODS, type AuthProvidersOptions } from "./providers.ts";

export interface AuthCommandDependencies {
  readonly home?: (env: CommandIO["env"]) => string;
  readonly store?: (home: string, env: CommandIO["env"]) => SynorchCredentialStore;
  readonly providerOptions?: Omit<AuthProvidersOptions, "state" | "deviceCode" | "profiles">;
}

const USAGE = [
  "Usage:",
  "  syn login <openai|anthropic> [--method oauth-subscription|api-key|cli-bridge] [--profile <name>] [--device-code]",
  "  syn logout <openai|anthropic> [--method <method>] [--profile <name>]",
  "  syn auth status [--json]",
].join("\n");

const DEFAULT_METHOD: { readonly [P in "openai" | "anthropic"]: AuthMethodKind } = {
  openai: "oauth-subscription",
  anthropic: "api-key",
};

const AUTH_FAILURE_CODES: readonly ProviderErrorCode[] = ["unauthenticated", "auth_expired", "entitlement_missing", "forbidden"];

/** `~/.synorch` or `$SYNORCH_HOME`. */
export function resolveSynorchHome(env: CommandIO["env"]): string {
  const override = env.SYNORCH_HOME;
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".synorch");
}

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) flags.set(name, inline);
    else if (name === "method" || name === "profile") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw usage(`--${name} needs a value`);
      flags.set(name, value);
      index += 1;
    } else flags.set(name, true);
  }
  return { positionals, flags };
}

function usage(message: string): HarnessError {
  return new HarnessError({ code: "usage_invalid", message: `${message}\n\n${USAGE}`, workspace_effect: "none", retry_safe: true });
}

function assertFlags(parsed: ParsedArgs, allowed: readonly string[]): void {
  for (const flag of parsed.flags.keys()) if (!allowed.includes(flag)) throw usage(`unknown option --${flag}`);
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === true) throw usage(`--${name} needs a value`);
  return value;
}

function providerArg(parsed: ParsedArgs): "openai" | "anthropic" {
  const provider = parsed.positionals[1];
  if (provider !== "openai" && provider !== "anthropic") throw usage(`unknown provider: ${provider ?? "(missing)"}`);
  if (parsed.positionals.length > 2) throw usage(`unexpected argument: ${parsed.positionals[2] ?? ""}`);
  return provider;
}

function methodArg(parsed: ParsedArgs): AuthMethodKind | undefined {
  const method = stringFlag(parsed, "method");
  if (method === undefined) return undefined;
  if (!(AUTH_METHODS as readonly string[]).includes(method)) throw usage(`unknown method: ${method}`);
  return method as AuthMethodKind;
}

function profileArg(parsed: ParsedArgs): string {
  const profile = stringFlag(parsed, "profile") ?? "default";
  if (!profileNameSchema.safeParse(profile).success) throw usage(`invalid profile name: ${profile} (kebab-case expected)`);
  return profile;
}

function describe(status: AuthStatus): string {
  const parts = [`${status.provider_id}/${status.method}`, `profile ${status.profile}`, status.state];
  if (status.account_label !== undefined) parts.push(status.account_label);
  if (status.plan_label !== undefined) parts.push(`plan ${status.plan_label}`);
  if (status.store_backend !== undefined) parts.push(`store ${status.store_backend}`);
  if (status.expires_at !== undefined) parts.push(`expires ${status.expires_at}`);
  if (status.detail !== undefined) parts.push(status.detail);
  return parts.join(" · ");
}

function report(io: CommandIO, error: unknown): ExitCode {
  if (error instanceof HarnessError) {
    io.stderr(`error: ${error.info.message}\n`);
    if (error.info.next_command !== undefined) io.stderr(`next: ${error.info.next_command}\n`);
    return error.exitCode;
  }
  if (error instanceof ProviderFailure) {
    io.stderr(`error: ${error.error.message}\n`);
    if (error.error.code === "cancelled") return EXIT_CODES.cancelled;
    return AUTH_FAILURE_CODES.includes(error.error.code) ? EXIT_CODES.auth : EXIT_CODES.provider;
  }
  io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT_CODES.internal;
}

/**
 * `syn login`, `syn logout` and `syn auth status`. `args[0]` is the command name. Output never
 * contains a secret: statuses are schema-checked and secrets never leave the auth providers.
 */
export function createAuthCommand(deps: AuthCommandDependencies = {}): CommandHandler {
  return async (args, io) => {
    try {
      const parsed = parseArgs(args);
      const command = parsed.positionals[0];
      const home = (deps.home ?? resolveSynorchHome)(io.env);
      const openStore = () => (deps.store ?? ((root, env) => createCredentialStore(root, { env })))(home, io.env);
      switch (command) {
        case "login":
          return await login(parsed, io, openStore, home, deps);
        case "logout":
          return await logout(parsed, io, openStore, home, deps);
        case "auth":
          return await status(parsed, io, openStore, home, deps);
        default:
          throw usage(`unknown auth command: ${command ?? "(missing)"}`);
      }
    } catch (error: unknown) {
      return report(io, error);
    }
  };
}

async function login(
  parsed: ParsedArgs,
  io: CommandIO,
  openStore: () => SynorchCredentialStore,
  home: string,
  deps: AuthCommandDependencies,
): Promise<ExitCode> {
  assertFlags(parsed, ["method", "profile", "device-code"]);
  const provider = providerArg(parsed);
  const method = methodArg(parsed) ?? DEFAULT_METHOD[provider];
  const profile = profileArg(parsed);
  if (!SUPPORTED_AUTH_METHODS.some((entry) => entry.provider === provider && entry.method === method)) {
    throw usage(`${provider} does not support --method ${method}`);
  }
  if (parsed.flags.has("device-code") && method !== "oauth-subscription") throw usage("--device-code applies only to oauth-subscription");
  const interaction = io.renderer.auth;
  if (!interaction.interactive) {
    throw new HarnessError({
      code: "auth_required",
      message: `syn login needs an interactive terminal; ${provider} ${method} cannot sign in headless`,
      workspace_effect: "none",
      retry_safe: true,
      ...(method === "api-key" ? { next_command: `export ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}=…` } : {}),
    });
  }
  const store = openStore();
  const auth = authProviderFor(store, credentialRefSchema.parse({ provider_id: provider, method, profile }), {
    ...deps.providerOptions,
    state: new ProfileStateStore(home),
    deviceCode: parsed.flags.has("device-code"),
  });
  if (auth === undefined) throw usage(`${provider} does not support --method ${method}`);
  if (store.notice !== undefined && method !== "cli-bridge") interaction.notify(store.notice.text);
  const result = authStatusSchema.parse(await auth.login(interaction, io.signal));
  io.stdout(`Signed in: ${describe(result)}\n`);
  return EXIT_CODES.success;
}

async function logout(
  parsed: ParsedArgs,
  io: CommandIO,
  openStore: () => SynorchCredentialStore,
  home: string,
  deps: AuthCommandDependencies,
): Promise<ExitCode> {
  assertFlags(parsed, ["method", "profile"]);
  const provider = providerArg(parsed);
  const method = methodArg(parsed);
  const profile = profileArg(parsed);
  const store = openStore();
  const state = new ProfileStateStore(home);
  const methods = SUPPORTED_AUTH_METHODS.filter((entry) => entry.provider === provider && (method === undefined || entry.method === method));
  if (methods.length === 0) throw usage(`${provider} does not support --method ${method ?? ""}`);
  for (const entry of methods) {
    const auth = authProviderFor(store, credentialRefSchema.parse({ provider_id: provider, method: entry.method, profile }), {
      ...deps.providerOptions,
      state,
    });
    await auth?.logout(io.signal);
    io.stdout(`Signed out: ${provider}/${entry.method} · profile ${profile}\n`);
  }
  return EXIT_CODES.success;
}

async function status(
  parsed: ParsedArgs,
  io: CommandIO,
  openStore: () => SynorchCredentialStore,
  home: string,
  deps: AuthCommandDependencies,
): Promise<ExitCode> {
  if (parsed.positionals[1] !== "status" || parsed.positionals.length > 2) throw usage("expected `syn auth status`");
  assertFlags(parsed, ["json"]);
  const store = openStore();
  const state = new ProfileStateStore(home);
  const stored = await store.list();
  const profiles = [...new Set(stored.map((ref) => ref.profile))];
  const providers = createAuthProviders(store, { ...deps.providerOptions, state, profiles });
  const statuses: AuthStatus[] = [];
  for (const auth of providers) {
    const isDefault = auth.profile === "default";
    const hasStored = stored.some((ref) => ref.provider_id === auth.providerId && ref.method === auth.method && ref.profile === auth.profile);
    if (!isDefault && !hasStored) continue;
    statuses.push(authStatusSchema.parse(await auth.status(io.signal)));
  }
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(statuses, null, 2)}\n`);
  } else {
    for (const entry of statuses) io.stdout(`${describe(entry)}\n`);
  }
  return EXIT_CODES.success;
}

export const authCommand: CommandHandler = createAuthCommand();
