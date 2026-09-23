import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  AUTH_METHODS,
  modelTierSchema,
  POLICY_MODES,
  profileNameSchema,
  providerIdSchema,
  runIdSchema,
  sessionIdSchema,
  type AuthMethodKind,
  type ModelTier,
  type PolicyMode,
  type ProviderId,
  type RunId,
  type SessionId,
} from "../contracts/index.ts";

/**
 * Argument parsing for the runtime commands of the CLI contract (§2). Parsing is strict: unknown
 * options, missing values and extra positionals are usage errors (exit code 2). `login`, `logout`
 * and `auth` are validated here and handed to their owning module with the raw arguments; `memory`
 * sub-commands are validated by name and their options are left to the memory module.
 */

export const MEMORY_SUBCOMMANDS = ["status", "search", "show", "related", "review", "accept", "reject", "open", "reindex"] as const;
export const COLOR_MODES = ["always", "never", "auto"] as const;

export type ColorMode = (typeof COLOR_MODES)[number];
export type MemorySubcommand = (typeof MEMORY_SUBCOMMANDS)[number];

export class UsageError extends Error {
  public readonly command: string | undefined;

  public constructor(message: string, command: string | undefined) {
    super(message);
    this.name = "UsageError";
    this.command = command;
  }
}

export interface CommonFlags {
  readonly target: string | undefined;
  readonly plain: boolean;
  readonly color: ColorMode;
}

export interface RouteOverride {
  readonly tier: ModelTier;
  readonly route: string;
}

export interface SessionFlags {
  readonly policy: PolicyMode;
  readonly profiles: readonly RouteOverride[];
}

export type ParsedCommand =
  | { readonly kind: "help"; readonly command: string }
  | {
      readonly kind: "agent";
      readonly common: CommonFlags;
      readonly session: SessionFlags;
      readonly resume: SessionId | undefined;
      readonly fork: { readonly sessionId: SessionId; readonly upToSeq: number | undefined } | undefined;
      /** `--continue`: reopen the most recent conversation of this workspace. */
      readonly continue: boolean;
      /** `--legacy`: the pre-ADR-21 orchestrated session (every message is a coordinator run). */
      readonly legacy: boolean;
      /** `--debug` (or `SYN_DEBUG=1`): raw event lines under the conversation (L2). */
      readonly debug: boolean;
    }
  | { readonly kind: "run"; readonly common: CommonFlags; readonly session: SessionFlags; readonly goal: string; readonly goalFromStdin: boolean; readonly jsonl: boolean; readonly streamDeltas: boolean; readonly trustWorkspace: boolean }
  | { readonly kind: "trust"; readonly common: CommonFlags; readonly revoke: boolean }
  | { readonly kind: "runs"; readonly common: CommonFlags; readonly json: boolean }
  | { readonly kind: "show"; readonly common: CommonFlags; readonly id: RunId | SessionId; readonly json: boolean }
  | { readonly kind: "doctor-runtime"; readonly common: CommonFlags; readonly probeModel: boolean; readonly json: boolean }
  | { readonly kind: "login"; readonly common: CommonFlags; readonly provider: ProviderId; readonly method: AuthMethodKind | undefined; readonly profile: string | undefined; readonly deviceCode: boolean; readonly args: readonly string[] }
  | { readonly kind: "logout"; readonly common: CommonFlags; readonly provider: ProviderId; readonly profile: string | undefined; readonly args: readonly string[] }
  | { readonly kind: "auth-status"; readonly common: CommonFlags; readonly json: boolean; readonly args: readonly string[] }
  | { readonly kind: "memory"; readonly subcommand: MemorySubcommand; readonly args: readonly string[] };

const COMMON_OPTIONS = {
  target: { type: "string", short: "t" },
  plain: { type: "boolean", default: false },
  color: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

const SESSION_OPTIONS = {
  policy: { type: "string" },
  profile: { type: "string", multiple: true },
} as const;

function parse<const O extends ParseArgsOptionsConfig>(command: string, args: readonly string[], options: O) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.split(". To specify a positional")[0] ?? error.message : String(error);
    throw new UsageError(message, command);
  }
}

function oneOf<const T extends readonly string[]>(command: string, flag: string, value: string | undefined, allowed: T, fallback: T[number]): T[number] {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new UsageError(`Invalid ${flag}: ${value}. Expected ${allowed.join(", ")}.`, command);
}

function common(command: string, values: { target?: string | undefined; plain?: boolean | undefined; color?: string | undefined }): CommonFlags {
  if (values.target !== undefined && values.target.trim() === "") throw new UsageError("--target must not be empty.", command);
  return {
    target: values.target,
    plain: values.plain === true,
    color: oneOf(command, "--color", values.color, COLOR_MODES, "auto"),
  };
}

function session(command: string, values: { policy?: string | undefined; profile?: string[] | undefined }): SessionFlags {
  const profiles = (values.profile ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    const tier = modelTierSchema.safeParse(separator === -1 ? entry : entry.slice(0, separator));
    const route = separator === -1 ? "" : entry.slice(separator + 1).trim();
    if (!tier.success || route === "") {
      throw new UsageError(`Invalid --profile: ${entry}. Expected <tier>=<route> with tier ${modelTierSchema.options.join(", ")}.`, command);
    }
    return { tier: tier.data, route };
  });
  const tiers = profiles.map((profile) => profile.tier);
  const duplicate = tiers.find((tier, index) => tiers.indexOf(tier) !== index);
  if (duplicate !== undefined) throw new UsageError(`--profile sets tier ${duplicate} more than once.`, command);
  return { policy: oneOf(command, "--policy", values.policy, POLICY_MODES, "autonomous"), profiles };
}

function noPositionals(command: string, positionals: readonly string[]): void {
  if (positionals.length > 0) throw new UsageError(`Unexpected positional arguments: ${positionals.join(" ")}`, command);
}

function sessionId(command: string, flag: string, value: string): SessionId {
  const parsed = sessionIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`Invalid ${flag}: ${value}. Expected a session id (ses_<ULID>).`, command);
  return parsed.data;
}

function provider(command: string, positionals: readonly string[]): ProviderId {
  if (positionals.length === 0) throw new UsageError(`syn ${command} requires a provider, for example: syn ${command} openai`, command);
  if (positionals.length > 1) throw new UsageError(`Unexpected positional arguments: ${positionals.slice(1).join(" ")}`, command);
  const parsed = providerIdSchema.safeParse(positionals[0]);
  if (!parsed.success) throw new UsageError(`Invalid provider: ${String(positionals[0])}. Provider ids are kebab-case.`, command);
  return parsed.data;
}

function credentialProfile(command: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!profileNameSchema.safeParse(value).success) throw new UsageError(`Invalid --profile: ${value}. Profile names are kebab-case.`, command);
  return value;
}

/** Parses `argv` (without the executable and script) for one runtime command. */
export function parseHarnessArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...args] = argv;
  switch (command) {
    case "agent": {
      const { values, positionals } = parse(command, args, {
        ...COMMON_OPTIONS,
        ...SESSION_OPTIONS,
        resume: { type: "string" },
        fork: { type: "string" },
        continue: { type: "boolean", short: "c", default: false },
        legacy: { type: "boolean", default: false },
        debug: { type: "boolean", default: false },
      });
      if (values.help) return { kind: "help", command };
      noPositionals(command, positionals);
      if (values.resume !== undefined && values.fork !== undefined) throw new UsageError("--resume and --fork cannot be combined.", command);
      if (values.continue && (values.resume !== undefined || values.fork !== undefined)) throw new UsageError("--continue cannot be combined with --resume or --fork.", command);
      if (values.continue && values.legacy) throw new UsageError("--continue is not available with --legacy (use --resume <session>).", command);
      let fork: { readonly sessionId: SessionId; readonly upToSeq: number | undefined } | undefined;
      if (values.fork !== undefined) {
        const [id = "", seq, ...rest] = values.fork.split("@");
        if (rest.length > 0 || (seq !== undefined && !/^[1-9]\d*$/.test(seq))) {
          throw new UsageError(`Invalid --fork: ${values.fork}. Expected <session>[@<seq>] with a positive seq.`, command);
        }
        fork = { sessionId: sessionId(command, "--fork", id), upToSeq: seq === undefined ? undefined : Number(seq) };
      }
      return {
        kind: "agent",
        common: common(command, values),
        session: session(command, values),
        resume: values.resume === undefined ? undefined : sessionId(command, "--resume", values.resume),
        fork,
        continue: values.continue,
        legacy: values.legacy,
        debug: values.debug,
      };
    }
    case "run": {
      const { values, positionals } = parse(command, args, {
        ...COMMON_OPTIONS,
        ...SESSION_OPTIONS,
        mode: { type: "string" },
        json: { type: "boolean", default: false },
        "stream-deltas": { type: "boolean", default: false },
        "trust-workspace": { type: "boolean", default: false },
      });
      if (values.help) return { kind: "help", command };
      if (values.mode !== undefined && values.mode !== "jsonl") throw new UsageError(`Invalid --mode: ${values.mode}. The only machine mode is jsonl.`, command);
      const jsonl = values.mode === "jsonl" || values.json;
      if (values["stream-deltas"] && !jsonl) throw new UsageError("--stream-deltas requires --mode jsonl (or --json).", command);
      if (jsonl && values.plain) throw new UsageError("--plain cannot be combined with --mode jsonl.", command);
      if (positionals.length === 0) throw new UsageError('syn run requires a goal, for example: syn run "fix the failing test"', command);
      if (positionals.length > 1) throw new UsageError(`Unexpected positional arguments: ${positionals.slice(1).join(" ")} (quote the goal)`, command);
      const goal = positionals[0] ?? "";
      if (goal.trim() === "") throw new UsageError("The goal must not be empty.", command);
      return {
        kind: "run",
        common: common(command, values),
        session: session(command, values),
        goal,
        goalFromStdin: goal === "-",
        jsonl,
        streamDeltas: values["stream-deltas"],
        trustWorkspace: values["trust-workspace"],
      };
    }
    case "trust": {
      const { values, positionals } = parse(command, args, { ...COMMON_OPTIONS, revoke: { type: "boolean", default: false } });
      if (values.help) return { kind: "help", command };
      noPositionals(command, positionals);
      return { kind: "trust", common: common(command, values), revoke: values.revoke };
    }
    case "runs": {
      const { values, positionals } = parse(command, args, { ...COMMON_OPTIONS, json: { type: "boolean", default: false } });
      if (values.help) return { kind: "help", command };
      noPositionals(command, positionals);
      return { kind: "runs", common: common(command, values), json: values.json };
    }
    case "show": {
      const { values, positionals } = parse(command, args, { ...COMMON_OPTIONS, json: { type: "boolean", default: false } });
      if (values.help) return { kind: "help", command };
      if (positionals.length !== 1) throw new UsageError("syn show requires exactly one run or session id.", command);
      const value = positionals[0] ?? "";
      const run = runIdSchema.safeParse(value);
      const ses = sessionIdSchema.safeParse(value);
      if (!run.success && !ses.success) throw new UsageError(`Invalid id: ${value}. Expected run_<ULID> or ses_<ULID>.`, command);
      return { kind: "show", common: common(command, values), id: run.success ? run.data : (ses.data as SessionId), json: values.json };
    }
    case "doctor": {
      const { values, positionals } = parse(command, args, {
        ...COMMON_OPTIONS,
        runtime: { type: "boolean", default: false },
        "probe-model": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      });
      if (!values.runtime) throw new UsageError("The runtime doctor requires --runtime.", command);
      if (values.help) return { kind: "help", command };
      noPositionals(command, positionals);
      return { kind: "doctor-runtime", common: common(command, values), probeModel: values["probe-model"], json: values.json };
    }
    case "login": {
      const { values, positionals } = parse(command, args, {
        ...COMMON_OPTIONS,
        method: { type: "string" },
        profile: { type: "string" },
        "device-code": { type: "boolean", default: false },
      });
      if (values.help) return { kind: "help", command };
      const method = values.method === undefined ? undefined : oneOf(command, "--method", values.method, AUTH_METHODS, "api-key");
      return {
        kind: "login",
        common: common(command, values),
        provider: provider(command, positionals),
        method,
        profile: credentialProfile(command, values.profile),
        deviceCode: values["device-code"],
        args,
      };
    }
    case "logout": {
      const { values, positionals } = parse(command, args, { ...COMMON_OPTIONS, profile: { type: "string" } });
      if (values.help) return { kind: "help", command };
      return { kind: "logout", common: common(command, values), provider: provider(command, positionals), profile: credentialProfile(command, values.profile), args };
    }
    case "auth": {
      const { values, positionals } = parse(command, args, { ...COMMON_OPTIONS, json: { type: "boolean", default: false } });
      if (values.help) return { kind: "help", command };
      if (positionals[0] !== "status" || positionals.length > 1) {
        throw new UsageError(positionals.length === 0 ? "syn auth requires a sub-command: status" : `Unknown auth sub-command: ${positionals.join(" ")}. Expected status.`, command);
      }
      return { kind: "auth-status", common: common(command, values), json: values.json, args };
    }
    case "memory": {
      const [subcommand, ...rest] = args;
      if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") return { kind: "help", command };
      if (!(MEMORY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
        throw new UsageError(`Unknown memory sub-command: ${subcommand}. Expected ${MEMORY_SUBCOMMANDS.join(", ")}.`, command);
      }
      return { kind: "memory", subcommand: subcommand as MemorySubcommand, args: [subcommand, ...rest] };
    }
    default:
      throw new UsageError(`Unknown runtime command: ${String(command)}`, undefined);
  }
}

/** Whether the raw arguments ask for machine output, so even a usage error is reported as frames. */
export function requestsJsonl(argv: readonly string[]): boolean {
  if (argv[0] !== "run") return false;
  const terminator = argv.indexOf("--");
  const flags = terminator === -1 ? argv : argv.slice(0, terminator);
  return flags.some((flag, index) => flag === "--json" || flag === "--mode=jsonl" || (flag === "--mode" && flags[index + 1] === "jsonl"));
}
