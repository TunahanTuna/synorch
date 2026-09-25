import os from "node:os";
import path from "node:path";
import {
  ASK_USER_HEADLESS_MESSAGE,
  askUserAnswerValue,
  askUserChoiceQuestion,
  createId,
  credentialRefSchema,
  deriveProjectId,
  EVENT_VERSIONS,
  HarnessError,
  parseTypedChoice,
  providerIdSchema,
  ProviderFailure,
  type AgentDriver,
  type AnyModelAdapter,
  type ApprovalBroker,
  type AskUserAnswers,
  type AskUserQuestion,
  type AuthProvider,
  type BlobStore,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Coordinator,
  type CredentialResolver,
  type EffectivePolicy,
  type EventStore,
  type MemoryStore,
  type ModelRoute,
  type ModelRouter,
  type ModelTier,
  type AgentRole,
  type AuthMethodKind,
  type RouteBinding,
  type RouteRule,
  type PolicyEngine,
  type PermissionMode,
  type PolicyMode,
  type ProjectId,
  type ReasoningEffort,
  type RecoveryReport,
  type RenderEvent,
  type ResolvedCredential,
  type SandboxReport,
  type SessionEvent,
  type SessionEventDraft,
  type SessionId,
  type SessionStore,
  type ToolGateway,
  type ToolRegistry,
  type TrustGrantSource,
  type WorkspaceTrustState,
} from "../contracts/index.ts";
import { SYNORCH_VERSION } from "../../domain/product.ts";
import {
  authProviderFor,
  CLAUDE_BRIDGE_NOTICE,
  createCredentialStore,
  ProfileStateStore,
  type AuthProvidersOptions,
  type SynorchCredentialStore,
} from "../auth/index.ts";
import {
  createCompactor,
  createContextBuilder,
  createSkillContextRegistry,
  createSkillLoadCallback,
  createSourceReader,
  type ContextBuilder,
} from "../context/index.ts";
import { createAgentDriver, recoverSession } from "../core/index.ts";
import { buildProposal, createMemoryStore, readGitBranch, resolveMemoryRoot } from "../memory/index.ts";
import {
  createBudgetGateSlot,
  createCoordinator,
  createDelegationSlot,
  createModelPlanner,
  createReportSlot,
  createWorkerFactory,
  delegationCallbacks,
  pruneOrphanedAttempts,
  reportCallbacks,
  type BudgetGateSlot,
  type CoordinatorLimits,
  type OrchestrationCoordinator,
  type VerificationRunner,
} from "../orchestration/index.ts";
import { classifyCommand, classifyVerificationCommand, createHeadlessApprovalBroker, createPolicyEngine, createWorkspaceTrustStore } from "../policy/index.ts";
import {
  createAnthropicMessagesAdapter,
  createClaudeCodeAdapter,
  createModelRouter,
  createOpenAIChatGPTAdapter,
  createOpenAIResponsesAdapter,
  createScriptedAdapter,
  buildModelCatalog,
  bridgeEnvironment,
  CHATGPT_CODEX_BASE_URL,
  createWebSearchRunner,
  fetchCodexModels,
  findOnPath,
  resolveEffort,
  SEARCH_KEY_ENV,
  SYNORCH_ORIGINATOR,
  type CatalogIdentity,
  type CatalogModel,
  type EffortResolution,
  type FetchLike,
  type KeyedSearchBackend,
  type ResponsesAdapterOptions,
  type WebSearchSources,
  type ClaudeCodeMode,
} from "../providers/index.ts";
import { McpManager } from "../mcp/index.ts";
import { createBlobStore, createSessionStore } from "../store/index.ts";
import { BackgroundProcessManager, createRedactor, createSandboxRunner, createToolGateway, createToolRegistry, createWebSession, probeSandbox, type WebSession } from "../tools/index.ts";
import { createClaudeNativeApprovals } from "./claude-native-approvals.ts";
import { createCommandGrantStore } from "./command-grants.ts";
import type { EffortOverride, RouteOverride } from "./args.ts";
import { loadCanonicalStructure, type CanonicalStructure } from "./canonical.ts";
import { checkEndpoint, DEFAULT_ADAPTER_FOR_PROVIDER, loadRuntimeConfig, resolveHome, type ConfiguredAdapter, type RuntimeConfig } from "./config.ts";
import { withRoleDefinitions } from "./role-policy.ts";
import { plannerHint, renderProfileBlock, startProjectProfile, within, type ProjectProfileHandle } from "./project-profile.ts";
import { createOrchestrateSlot, createOrchestrateTool, type OrchestrateSlot } from "./orchestrate-tool.ts";
import { loadScript } from "./scripted-script.ts";
import { recordTrustDecision } from "./trust.ts";

/**
 * The composition root (ADR-01): the only place that wires the real implementations of every
 * module together. Everything a command needs is built here from the home directory, the three
 * configuration layers and the session flags; tests inject a home, adapters, a fetch and a
 * sandbox report through `RuntimeOverrides` instead of touching the network or the user's home.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeOverrides {
  /** Replaces `SYNORCH_HOME` / `~/.synorch`. */
  readonly home?: string;
  /** Used by every HTTP adapter and auth provider; `doctor --runtime` proves it is never called. */
  readonly fetch?: FetchLike;
  /** Extra (or replacing, by adapter id) model adapters, e.g. scripted adapters with function steps. */
  readonly adapters?: readonly AnyModelAdapter[];
  readonly authOptions?: Omit<AuthProvidersOptions, "state" | "profiles" | "deviceCode">;
  readonly credentialStore?: (home: string, env: Env) => SynorchCredentialStore;
  readonly sandbox?: SandboxReport;
  readonly limits?: Partial<Omit<CoordinatorLimits, "budgets">> & { readonly budgets?: Partial<CoordinatorLimits["budgets"]> };
  readonly platform?: NodeJS.Platform;
  /** Highest directory the workspace-config walk may inspect (tests anchor it at their sandbox root). */
  readonly configCeiling?: string;
}

export interface RuntimeOptions {
  readonly workspaceRoot: string;
  readonly env: Env;
  readonly policyMode: PolicyMode;
  readonly routes?: readonly RouteOverride[];
  /** K6 `--effort` flags: this invocation only, never persisted. */
  readonly efforts?: readonly EffortOverride[];
  readonly overrides?: RuntimeOverrides;
  /** `--trust-workspace`: trust the workspace for this runtime only; never persisted (SEC-N1). */
  readonly trustWorkspace?: boolean;
  /**
   * The starting permission mode (ADR-08 revision 2026-09-24): a flag, `ui.permission_mode` or the
   * interactive default. Undefined keeps the headless default-deny policy. `full` implies trust for
   * this runtime only (never persisted).
   */
  readonly permissionMode?: PermissionMode;
}

export type RuntimeListener = (event: RenderEvent) => void;

/** The session workspace's trust (SEC-N1): read from the user-scope store at start, or the one-run flag. */
export interface RuntimeTrust {
  readonly file: string;
  state(): WorkspaceTrustState;
  /** Persists trust for this workspace in the user scope, records `trust/granted`, and applies it to policies computed from now on. */
  grant(source: TrustGrantSource): Promise<WorkspaceTrustState>;
  /** Trusts the workspace for this runtime only ("Trust for this session only"); nothing is persisted. */
  grantSession(): WorkspaceTrustState;
  /** The trust recorded for the workspace, ignoring what full access implies. */
  recorded(): WorkspaceTrustState;
}

/** Asks the human attached to the session a question (the `ask_user` tool); resolves with the answer. */
export type UserPrompt = (question: string, options: readonly string[] | undefined, signal: AbortSignal) => Promise<string>;
/** K5: one structured question for the attached human (the choice modal); undefined when dismissed (Esc). */
export type UserChoicePrompt = (question: ChoiceQuestion, signal: AbortSignal) => Promise<ChoiceAnswer | undefined>;
/** Every question answered, or `dismissed` when the user pressed Esc on one; `unavailable` without a human. */
export type UserQuestionsOutcome = { readonly kind: "answered"; readonly answers: AskUserAnswers } | { readonly kind: "dismissed" } | { readonly kind: "unavailable" };

export interface Runtime {
  readonly home: string;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly platform: NodeJS.Platform;
  readonly policyMode: PolicyMode;
  readonly config: RuntimeConfig;
  /** The target repository's canonical `.ai/` structure (or the built-in defaults) fed to context and policy. */
  readonly canonical: CanonicalStructure;
  /** Zero-config project profile (stack, package manager, commands), loaded in the background from the user-scope cache. */
  readonly profile: ProjectProfileHandle;
  readonly sessions: SessionStore;
  readonly blobs: BlobStore;
  readonly router: ModelRouter;
  readonly adapters: readonly AnyModelAdapter[];
  readonly policy: PolicyEngine;
  readonly registry: ToolRegistry;
  /** K4.2: background processes started by `exec {background: true}`; killed when the session ends. */
  readonly processes: BackgroundProcessManager;
  readonly sandbox: SandboxReport;
  readonly trust: RuntimeTrust;
  readonly memory: MemoryStore;
  readonly memoryRoot: string;
  readonly gitBranch: string | undefined;
  readonly context: ContextBuilder;
  readonly budgetGate: BudgetGateSlot;
  readonly credentials: CredentialResolver;
  /** The `orchestrate` tool's handler slot (ADR-21 D4): set by the open conversation, empty otherwise. */
  readonly orchestrate: OrchestrateSlot;
  /** K4.1 web state: allowed domains (user grants), the prompt-injection shield, the page cache. */
  readonly web: WebSession;
  /** K3 MCP client: configured external servers; their tools join the registry as `mcp__<server>__<tool>`. */
  readonly mcp: McpManager;
  /** Lazily opened: probing the OS keychain can spawn a helper process. */
  credentialStore(): SynorchCredentialStore;
  authProvider(providerId: string, method: AuthProvider["method"], profile: string): AuthProvider | undefined;
  /** Every session event appended through this runtime (run and attempt sessions) and every model stream event. */
  subscribe(listener: RuntimeListener): () => void;
  /**
   * Binds `ask_user` to a human for the lifetime of a session; returns the unbind function. With no
   * binding (headless, JSONL, piped input) `ask_user` answers `approval_unavailable`. `choose`
   * shows structured questions (the K5 modal); without it they are asked as numbered text.
   */
  bindUserPrompt(prompt: UserPrompt, choose?: UserChoicePrompt): () => void;
  /** Asks `ask_user`-shaped questions (also Claude Code's AskUserQuestion in native mode) through the bound human. */
  askUserQuestions(questions: readonly AskUserQuestion[], signal: AbortSignal): Promise<UserQuestionsOutcome>;
  /** The approval broker for a session: the renderer's interactive broker in `ask` mode or under an interactive permission mode (workers' prompts reach the user, ADR-08 revision 3), the headless one otherwise. */
  brokerFor(interactive: ApprovalBroker | undefined): ApprovalBroker;
  createDriver(broker: ApprovalBroker): (events: EventStore) => AgentDriver;
  /**
   * The conversation agent's driver over its session log (ADR-21 D1): the same fixed loop and tool
   * gateway as every role; `wrap` decorates the gateway (per-edit checkpoints, trust at first exec).
   */
  createSessionDriver(broker: ApprovalBroker, events: EventStore, wrap: (gateway: ToolGateway) => ToolGateway): AgentDriver;
  /** The conversation agent's effective policy (ADR-21 D3); recomputed after a trust decision, an /allow grant or a mode change. */
  sessionPolicy(commandGrants: readonly string[]): EffectivePolicy;
  /** The current permission mode; undefined in a headless default-deny session. */
  permissionMode(): PermissionMode | undefined;
  /** Switches the permission mode (Shift+Tab, /permissions); workers started later inherit `full` only. */
  setPermissionMode(mode: PermissionMode | undefined): void;
  /** ADR-08 owner revision 3: the user approved a plain `git push`; auto pushes without asking for the rest of the session. */
  approveGitPushForSession(): void;
  /** The coordinator plus its worker directory (K1.7: list, assignments, per-worker control). */
  createCoordinator(broker: ApprovalBroker): OrchestrationCoordinator;
  /** The route rules as the router sees them now: `/model` session routes first, then the configured ones (K1.5). */
  routeRules(): readonly RouteRule[];
  /**
   * Points a tier (and optionally a role) at another provider/model for this session (K1.5 `/model`).
   * The adapter is built on first use; only a logged-in identity is accepted (never a silent fallback).
   */
  setSessionRoute(tier: ModelTier, role: AgentRole | undefined, route: RouteBinding): Promise<ModelRoute>;
  clearSessionRoute(tier: ModelTier, role: AgentRole | undefined): boolean;
  /**
   * Models of every provider and auth method, grouped by provider, with whether each identity is
   * logged in. No paid request is sent; `listing: true` also asks the ChatGPT subscription's free
   * Codex models listing (never used by doctor).
   */
  modelCatalog(signal: AbortSignal, options?: { readonly listing?: boolean }): Promise<CatalogModel[]>;
  /**
   * K6: the reasoning effort a tier (and role) runs with on a route: `/effort` and `--effort` for
   * this session first, then `effort.<role>` and `effort.<tier>` of the user configuration, clamped
   * to the levels the route's model takes (the resolution says so in `notice`).
   */
  effortFor(tier: ModelTier, role: AgentRole | undefined, route: Pick<RouteBinding, "provider_id" | "model_id" | "adapter_id">): EffortResolution;
  /** K6 `/effort`: sets (or with undefined clears) a tier's level for this session; the next model request uses it. */
  setSessionEffort(tier: ModelTier, level: ReasoningEffort | undefined): void;
  /** Crash recovery of a session and of every attempt session it started; nothing is re-executed. */
  recover(sessionId: SessionId): Promise<readonly RecoveryReport[]>;
}

const SCRIPTED_PROVIDER = "scripted";
const HOSTED_ALLOW = "Allow for this session";

interface WebSearchSourceDeps {
  readonly env: Env;
  readonly home: string;
  readonly workspaceRoot: string;
  readonly platform: NodeJS.Platform;
  readonly fetch: FetchLike | undefined;
  readonly authProvider: (providerId: string, method: AuthProvider["method"], profile: string) => AuthProvider | undefined;
  readonly credentialStore: () => SynorchCredentialStore;
  readonly redactionValues: Set<string>;
}

/**
 * K4.1: what each `web_search` backend needs, from the logged-in identities (never a model request
 * to decide): subscription / API-key headers, the Claude Code bridge, and user search keys from the
 * credential store or the environment. Every resolved secret joins the gateway's redaction set.
 */
function webSearchSources(deps: WebSearchSourceDeps): WebSearchSources {
  const headersFor = async (provider: string, method: AuthProvider["method"], signal: AbortSignal): Promise<Headers | undefined> => {
    const auth = deps.authProvider(provider, method, "default");
    if (auth === undefined) return undefined;
    const status = await auth.status(signal).catch(() => undefined);
    if (status?.state !== "connected" && status?.state !== "expired") return undefined;
    const credential = await auth.resolve(signal);
    for (const value of credential.redactionValues()) deps.redactionValues.add(value);
    const headers = new Headers();
    credential.applyTo(headers);
    return headers;
  };
  return {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    chatgpt: (signal) => headersFor("openai", "oauth-subscription", signal),
    openaiApi: (signal) => headersFor("openai", "api-key", signal),
    anthropicApi: (signal) => headersFor("anthropic", "api-key", signal),
    async claudeCode() {
      if (!(await bridgeEnabled(deps.home))) return undefined;
      const found = await findOnPath("claude", bridgeEnvironment(deps.env, {}, deps.platform), deps.platform);
      return found === undefined ? undefined : { executable: { command: found }, env: deps.env, cwd: deps.workspaceRoot, platform: deps.platform };
    },
    async searchKey(backend: KeyedSearchBackend) {
      const fromEnv = deps.env[SEARCH_KEY_ENV[backend]]?.trim();
      let key = fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
      if (key === undefined) {
        const secret = await deps
          .credentialStore()
          .get({ provider_id: providerIdSchema.parse(backend), method: "api-key", profile: "default" })
          .catch(() => undefined);
        key = secret?.method === "api-key" ? secret.api_key : undefined;
      }
      if (key !== undefined) deps.redactionValues.add(key);
      return key;
    },
  };
}

function platformName(platform: NodeJS.Platform): "win32" | "darwin" | "linux" | "other" {
  return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other";
}

function configError(message: string): HarnessError {
  return new HarnessError({ code: "config_invalid", message, workspace_effect: "none", retry_safe: false });
}

async function bridgeEnabled(home: string): Promise<boolean> {
  const ref = credentialRefSchema.parse({ provider_id: "anthropic", method: "cli-bridge", profile: "default" });
  return new ProfileStateStore(home).isAcknowledged(CLAUDE_BRIDGE_NOTICE.id, ref).catch(() => false);
}

/** K4.1 native provider search hooks handed to the OpenAI adapters (the runtime fills them in once its state exists). */
interface WebAdapterHooks {
  readonly hostedWebSearch: NonNullable<ResponsesAdapterOptions["hostedWebSearch"]>;
  readonly onHostedSearch: NonNullable<ResponsesAdapterOptions["onHostedSearch"]>;
}

/** Claude Code native-mode wiring (owner revision 2026-09-24): the configured mode and the session hooks. */
interface ClaudeWiring {
  readonly mode: ClaudeCodeMode;
  /** K3: MCP servers Claude runs itself in native mode (`--mcp-config`), instead of proxying them. */
  readonly mcpServers: () => Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly permissionMode: () => PermissionMode | undefined;
  readonly onWebContentRead: () => void;
}

async function buildAdapter(entry: ConfiguredAdapter, fetch: FetchLike | undefined, env: Env, home: string, claude: ClaudeWiring, web?: WebAdapterHooks): Promise<AnyModelAdapter> {
  if (entry.source !== "user") throw configError(`adapter ${entry.id} comes from the ${entry.source} layer; only the user configuration declares adapters`);
  if (entry.baseUrl !== undefined && entry.kind === "openai-chatgpt") {
    const refused = checkEndpoint(entry.kind, entry.baseUrl, false);
    if (refused !== undefined) throw configError(`adapter ${entry.id}: ${refused}`);
  }
  const common = { ...(fetch === undefined ? {} : { fetch }), ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }) };
  const hosted = web === undefined ? {} : { hostedWebSearch: web.hostedWebSearch, onHostedSearch: web.onHostedSearch };
  switch (entry.kind) {
    case "openai-chatgpt":
      return withId(createOpenAIChatGPTAdapter({ ...common, ...hosted }), entry.id);
    case "openai-responses":
      return withId(createOpenAIResponsesAdapter({ ...common, ...hosted }), entry.id);
    case "anthropic-messages":
      return withId(createAnthropicMessagesAdapter(common), entry.id);
    case "claude-code":
      return createClaudeCodeAdapter({
        experimental: await bridgeEnabled(home),
        env,
        allowNonSubscriptionAuth: entry.allowNonSubscriptionAuth === true,
        mode: claude.mode,
        mcpServers: claude.mcpServers,
        permissionMode: claude.permissionMode,
        onWebContentRead: claude.onWebContentRead,
      });
    case "scripted":
      return createScriptedAdapter(await loadScript(entry.script ?? ""), {
        adapterId: entry.id,
        providerId: entry.provider ?? SCRIPTED_PROVIDER,
      });
  }
}

/** A configured id for a built-in adapter kind keeps the adapter's behaviour under the chosen id. */
function withId(adapter: AnyModelAdapter, id: string): AnyModelAdapter {
  if (adapter.adapterId === id || adapter.kind !== "model") return adapter;
  return {
    kind: "model",
    adapterId: id,
    providerId: adapter.providerId,
    authMethod: adapter.authMethod,
    discoverCapabilities: async (signal) => ({ ...(await adapter.discoverCapabilities(signal)), adapter_id: id }),
    prepare: (request, capabilities) => adapter.prepare(request, capabilities),
    stream: (request, credential, signal) => adapter.stream(request, credential, signal),
    health: (signal) => adapter.health(signal),
  };
}

const IMPLICIT_ADAPTERS: Readonly<Record<string, ConfiguredAdapter["kind"]>> = {
  "openai-chatgpt": "openai-chatgpt",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
  "claude-code": "claude-code",
};

async function buildAdapters(config: RuntimeConfig, overrides: RuntimeOverrides, env: Env, home: string, claude: ClaudeWiring, web?: WebAdapterHooks): Promise<AnyModelAdapter[]> {
  const injected = new Map((overrides.adapters ?? []).map((adapter) => [adapter.adapterId, adapter]));
  const built = new Map<string, AnyModelAdapter>();
  for (const entry of config.adapters) {
    if (!injected.has(entry.id)) built.set(entry.id, await buildAdapter(entry, overrides.fetch, env, home, claude, web));
  }
  for (const rule of config.router.rules) {
    const id = rule.route.adapter_id;
    if (built.has(id) || injected.has(id)) continue;
    const kind = IMPLICIT_ADAPTERS[id];
    if (kind === undefined) {
      const hint = DEFAULT_ADAPTER_FOR_PROVIDER[rule.route.provider_id] === id ? " (declare it under adapters)" : "";
      throw configError(`route for ${rule.tier} uses adapter ${id}, which is neither built in nor configured${hint}`);
    }
    built.set(id, await buildAdapter({ id, kind, script: undefined, provider: undefined, baseUrl: undefined, source: "user" }, overrides.fetch, env, home, claude, web));
  }
  return [...built.values(), ...injected.values()];
}

/** A non-secret credential for the scripted test provider, which sends nothing anywhere. */
function scriptedCredential(profile: string): ResolvedCredential {
  const credential: ResolvedCredential = {
    providerId: providerIdSchema.parse(SCRIPTED_PROVIDER),
    method: "api-key",
    profile,
    expiresAt: undefined,
    applyTo: () => undefined,
    redactionValues: () => [],
    toJSON: () => "[redacted]",
  };
  return Object.freeze(credential);
}

function observedStore(store: EventStore, emit: (event: SessionEvent) => void, onClose: () => void): EventStore {
  return {
    get sessionId() {
      return store.sessionId;
    },
    get lastSeq() {
      return store.lastSeq;
    },
    get quarantinedTail() {
      return store.quarantinedTail;
    },
    async append(draft: SessionEventDraft) {
      const event = await store.append(draft);
      emit(event);
      return event;
    },
    read: (fromSeq, toSeq) => store.read(fromSeq, toSeq),
    async close() {
      onClose();
      await store.close();
    },
  };
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const overrides = options.overrides ?? {};
  const env = options.env;
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? resolveHome(env);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const config = await loadRuntimeConfig(home, workspaceRoot, options.routes ?? [], {
    platform,
    ...(overrides.configCeiling === undefined ? {} : { ceiling: overrides.configCeiling }),
  });
  // K4.1: the OpenAI adapters ask these (filled in below, once the permission mode and logs exist).
  const webHooksState: { gate: WebAdapterHooks["hostedWebSearch"]; observe: WebAdapterHooks["onHostedSearch"]; contentRead: () => void } = {
    gate: async () => false,
    observe: () => undefined,
    contentRead: () => undefined,
  };
  const webHooks: WebAdapterHooks = { hostedWebSearch: (request, signal) => webHooksState.gate(request, signal), onHostedSearch: (observed) => webHooksState.observe(observed) };
  // K3: the MCP manager exists once the registry does; Claude Code native mode reads its servers at each process start.
  const mcpHolder: { current: McpManager | undefined } = { current: undefined };
  // Read at every Claude process start, so a mode change (Shift+Tab, /permissions) applies to the next step.
  const claude: ClaudeWiring = {
    mode: config.claudeCodeMode ?? "native",
    mcpServers: () => mcpHolder.current?.claudeServers() ?? {},
    permissionMode: () => permission,
    // K4.1: a native WebSearch/WebFetch result arrived; the prompt-injection shield applies to this turn.
    onWebContentRead: () => webHooksState.contentRead(),
  };
  const adapters = await buildAdapters(config, overrides, env, home, claude, webHooks);
  const baseRouter = createModelRouter(
    { rules: config.router.rules, ...(config.preferDifferentProvider === undefined ? {} : { preferDifferentProvider: config.preferDifferentProvider }) },
    adapters,
  );
  /** An adapter for a built-in kind the configuration did not need yet (a provider first picked in `/model`). */
  const implicitAdapter = async (id: string): Promise<AnyModelAdapter | undefined> => {
    const existing = adapters.find((adapter) => adapter.adapterId === id);
    if (existing !== undefined) return existing;
    const kind = IMPLICIT_ADAPTERS[id];
    if (kind === undefined) return undefined;
    return buildAdapter({ id, kind, script: undefined, provider: undefined, baseUrl: undefined, source: "user" }, overrides.fetch, env, home, claude, webHooks);
  };

  const listeners = new Set<RuntimeListener>();
  const emit = (event: RenderEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const projectId = deriveProjectId(workspaceRoot, platform);
  const gitBranch = await readGitBranch(workspaceRoot);
  const rawSessions = createSessionStore(home);
  const blobs = createBlobStore(home);
  const writers = new Map<SessionId, EventStore>();
  const wrap = (store: EventStore): EventStore => {
    const observed = observedStore(store, (event) => emit({ kind: "session-event", event }), () => writers.delete(store.sessionId));
    writers.set(store.sessionId, observed);
    return observed;
  };
  const configIgnored = config.warnings.slice(0, 32).map((warning) => ({ layer: warning.layer, path: warning.path, key: warning.key }));
  const opened = async (store: EventStore, parent: { session_id: SessionId; up_to_seq: number } | undefined, root: string): Promise<EventStore> => {
    const observed = wrap(store);
    await observed.append({
      type: "session/opened",
      event_version: EVENT_VERSIONS["session/opened"],
      actor: { kind: "system" },
      data: {
        writer: { name: "synorch", version: SYNORCH_VERSION },
        project_id: projectId,
        workspace_root: root,
        cwd: workspaceRoot,
        platform: platformName(platform),
        git: gitBranch === undefined ? null : { branch: gitBranch },
        policy_mode: options.policyMode,
        ...(parent === undefined ? {} : { parent }),
        ...(configIgnored.length === 0 ? {} : { config_ignored: configIgnored }),
      },
    } as SessionEventDraft);
    return observed;
  };
  const sessions: SessionStore = {
    create: async (manifest) => opened(await rawSessions.create(manifest), manifest.parent, manifest.workspace_root),
    openForWrite: async (sessionId) => wrap(await rawSessions.openForWrite(sessionId)),
    openForRead: (sessionId) => rawSessions.openForRead(sessionId),
    fork: async (sessionId, upToSeq) => opened(await rawSessions.fork(sessionId, upToSeq), { session_id: sessionId, up_to_seq: upToSeq }, workspaceRoot),
    list: (id) => rawSessions.list(id),
  };

  const wrappedAdapters = new Map<string, AnyModelAdapter>();
  const router: ModelRouter = {
    resolve: (request, signal) => baseRouter.resolve(request, signal),
    reportFailure: (route, error) => baseRouter.reportFailure(route, error),
    proposeProviderChange: (failure, context) => baseRouter.proposeProviderChange(failure, context),
    applyProviderChange: (decision) => baseRouter.applyProviderChange(decision),
    adapterFor(route) {
      const adapter = baseRouter.adapterFor(route);
      if (adapter.kind !== "model") return adapter;
      const cached = wrappedAdapters.get(adapter.adapterId);
      if (cached !== undefined) return cached;
      const observed: AnyModelAdapter = {
        kind: "model",
        adapterId: adapter.adapterId,
        providerId: adapter.providerId,
        authMethod: adapter.authMethod,
        discoverCapabilities: (signal) => adapter.discoverCapabilities(signal),
        prepare: (request, capabilities) => adapter.prepare(request, capabilities),
        health: (signal) => adapter.health(signal),
        stream: (request, credential, signal) =>
          (async function* () {
            for await (const event of adapter.stream(request, credential, signal)) {
              if (event.type === "error" && event.error.code === "quota_exhausted") baseRouter.reportFailure(request.route, event.error);
              emit({ kind: "stream", requestId: request.request_id, event });
              yield event;
            }
          })(),
      };
      wrappedAdapters.set(adapter.adapterId, observed);
      return observed;
    },
  };

  let store: SynorchCredentialStore | undefined;
  const credentialStore = (): SynorchCredentialStore => {
    store ??= (overrides.credentialStore ?? ((root, variables) => createCredentialStore(root, { env: variables })))(home, env);
    return store;
  };
  const authOptions: AuthProvidersOptions = {
    ...(overrides.authOptions ?? {}),
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    env,
  };
  const authProviders = new Map<string, AuthProvider | undefined>();
  const authProvider = (providerId: string, method: AuthProvider["method"], profile: string): AuthProvider | undefined => {
    const key = `${providerId}|${method}|${profile}`;
    if (!authProviders.has(key)) {
      const ref = credentialRefSchema.parse({ provider_id: providerId, method, profile });
      authProviders.set(key, authProviderFor(credentialStore(), ref, authOptions));
    }
    return authProviders.get(key);
  };

  /** Whether an identity is usable, from its auth status only (store / env / opt-in; never a model request). */
  const identityOf = async (provider: string, method: AuthMethodKind, profile: string, signal: AbortSignal): Promise<CatalogIdentity> => {
    if (provider === SCRIPTED_PROVIDER) return { connected: true, hint: "" };
    const scripted = adapters.find((adapter) => adapter.providerId === provider && adapter.authMethod === method && (adapter as { readonly scripted?: boolean }).scripted === true);
    if (scripted !== undefined) return { connected: true, hint: "" };
    const auth = authProvider(provider, method, profile);
    if (auth === undefined) return { connected: false, hint: `${provider} does not support ${method}` };
    const status = await auth.status(signal).catch(() => undefined);
    const state = status?.state;
    const connected = method === "cli-bridge" ? state === "unknown" || state === "connected" : state === "connected" || state === "expired";
    const login = method === "cli-bridge" ? `syn login ${provider} --method cli-bridge` : method === "api-key" ? `syn login ${provider} --method api-key` : `syn login ${provider}`;
    return { connected, hint: connected ? "" : `${status?.detail ?? state ?? "not logged in"}; run ${login}` };
  };

  const redactionValues = new Set<string>();
  const credentials: CredentialResolver = async (route, signal, resolveOptions) => {
    if (
      route.provider_id === SCRIPTED_PROVIDER ||
      adapters.some((adapter) => adapter.adapterId === route.adapter_id && (adapter.providerId === SCRIPTED_PROVIDER || (adapter as { readonly scripted?: boolean }).scripted === true))
    ) {
      return scriptedCredential(route.profile);
    }
    const auth = authProvider(route.provider_id, route.auth_method, route.profile);
    if (auth === undefined) {
      throw new ProviderFailure({
        code: "unauthenticated",
        message: `no auth provider supports ${route.provider_id} ${route.auth_method} (profile ${route.profile}); run syn login ${route.provider_id}`,
        retryable: false,
      });
    }
    const credential = await auth.resolve(signal, resolveOptions);
    for (const value of credential.redactionValues()) redactionValues.add(value);
    return credential;
  };

  const canonical = await loadCanonicalStructure(workspaceRoot);
  // Never awaited here: the first token must not wait for a cold detection (cached profiles load in ms).
  const profile = startProjectProfile(home, projectId, workspaceRoot);
  const profileText = async (): Promise<string | undefined> => {
    const known = profile.current() ?? (await within(profile.ready, 1_500));
    return known === undefined ? undefined : renderProfileBlock(known);
  };
  const trustStore = createWorkspaceTrustStore(home, { platform });
  const stored = trustStore.status(workspaceRoot);
  let trustState: WorkspaceTrustState = !stored.trusted && options.trustWorkspace === true ? { ...stored, trusted: true, source: "flag", reason: undefined } : stored;
  let permission: PermissionMode | undefined = options.permissionMode;
  let gitPushApproved = false;
  // Full access and auto (owner revision 3) imply trust for this runtime only, never saved; leaving them returns to the recorded trust.
  const effectiveTrust = (): WorkspaceTrustState =>
    trustState.trusted || (permission !== "full" && permission !== "auto") ? trustState : { ...trustState, trusted: true, source: "session", reason: undefined };
  const trust: RuntimeTrust = {
    file: trustStore.file,
    state: effectiveTrust,
    recorded: () => trustState,
    async grant(source) {
      const granted = await trustStore.grant(workspaceRoot, source);
      if (granted.trusted) {
        trustState = granted;
        await recordTrustDecision(home, workspaceRoot, platform, "trust/granted", granted, source);
      }
      return granted;
    },
    grantSession() {
      if (!trustState.trusted) trustState = { ...trustState, trusted: true, source: "session", reason: undefined };
      return trustState;
    },
  };
  const webSession = createWebSession({ home });
  webHooksState.contentRead = () => webSession.markContentRead();
  const policy = withRoleDefinitions(
    createPolicyEngine({
      synorchHome: home,
      workspaceTrusted: () => effectiveTrust().trusted,
      permissionMode: () => permission,
      webDomains: () => webSession.domains(),
      webContentRead: () => webSession.contentRead(),
      gitPushApproved: () => gitPushApproved,
    }),
    canonical.roles,
  );
  const webSearch = createWebSearchRunner({
    provider: () => config.web.searchProvider,
    model: () => config.web.searchModel,
    sources: webSearchSources({ env, home, workspaceRoot, platform, fetch: overrides.fetch, authProvider, credentialStore, redactionValues }),
  });
  const sandbox = overrides.sandbox ?? (await probeSandbox({ platform }));
  const runner = createSandboxRunner(sandbox, { untrustedRoots: [workspaceRoot, home] });
  const userConfig = config.userPolicy === undefined ? undefined : { policy: config.userPolicy };
  const workspaceConfig = config.workspacePolicy === undefined ? undefined : { policy: config.workspacePolicy };

  const memoryRoot = config.memory?.root !== undefined ? resolveMemoryRoot(config.memory, projectId, os.homedir()) : path.join(home, "memory", projectId);
  const memory = createMemoryStore(memoryRoot, { workspaceRoot });

  const delegation = createDelegationSlot();
  const reports = createReportSlot();
  const skillContext = createSkillContextRegistry();
  let userPrompt: UserPrompt | undefined;
  let userChoice: UserChoicePrompt | undefined;
  const askUserQuestions = async (questions: readonly AskUserQuestion[], signal: AbortSignal): Promise<UserQuestionsOutcome> => {
    const prompt = userPrompt;
    if (prompt === undefined) return { kind: "unavailable" };
    const choose = userChoice;
    const answers: Record<string, readonly string[] | string> = {};
    for (const question of questions) {
      const choice = askUserChoiceQuestion(question);
      let answer: ChoiceAnswer | undefined;
      if (choose !== undefined) answer = await choose(choice, signal);
      else answer = parseTypedChoice(choice, await prompt(question.question, question.options.map((option) => option.label), signal));
      if (answer === undefined) return { kind: "dismissed" };
      answers[question.question] = askUserAnswerValue(answer);
    }
    return { kind: "answered", answers: { answers } };
  };
  const processes = new BackgroundProcessManager();
  const registry = createToolRegistry({
    processes,
    classifyCommand: (argv, scope) => classifyCommand(argv, scope),
    web: { session: webSession, search: webSearch, transport: { allowPrivate: config.web.allowPrivate } },
    control: {
      ...delegationCallbacks(delegation),
      ...reportCallbacks(reports),
      // Only catalog skills the caller's role may use (never widening a read scope to .ai/**); a skill
      // already in the caller's context is not served again (ADR-20). One registry is shared with the
      // ContextBuilder, which records what each build injected.
      loadSkill: createSkillLoadCallback({ skills: canonical.skills, registry: skillContext }),
      async askUser(input, context) {
        if ((context.role !== "orchestrator" && context.role !== "session") || userPrompt === undefined) {
          return { status: "error", text: "", truncated: false, redactions: 0, error: { code: "approval_unavailable", message: ASK_USER_HEADLESS_MESSAGE } };
        }
        const outcome = await askUserQuestions(input.questions, context.signal);
        if (outcome.kind === "unavailable") {
          return { status: "error", text: "", truncated: false, redactions: 0, error: { code: "approval_unavailable", message: ASK_USER_HEADLESS_MESSAGE } };
        }
        if (outcome.kind === "dismissed") {
          return {
            status: "error",
            text: "",
            truncated: false,
            redactions: 0,
            error: { code: "approval_rejected", message: "the user dismissed the question without answering; do not assume an answer: continue with what you can decide safely, or ask again in plain text" },
          };
        }
        return { status: "ok", text: `The user answered: ${JSON.stringify(outcome.answers)}`.slice(0, 16 * 1024), truncated: false, redactions: 0 };
      },
      async memoryPropose(input, context) {
        // K2 decision desk: `{ kind, title, body }` is enough; a conversation turn (no run) proposes as `session`.
        const parsed = buildProposal(input, { projectId, branch: gitBranch, runId: context.runId, taskId: context.taskId, role: context.role, toolCallId: context.toolCallId, now: new Date() });
        if (!parsed.ok) {
          return { status: "error", text: "", truncated: false, redactions: 0, error: { code: "invalid_arguments", message: parsed.message } };
        }
        await memory.propose(parsed.proposal);
        return { status: "ok", text: `proposal ${parsed.proposal.proposal_id} queued for the user's review (/memory review); it is not memory until accepted`, truncated: false, redactions: 0 };
      },
    },
  });

  const orchestrate = createOrchestrateSlot();
  registry.register(createOrchestrateTool(orchestrate) as never);

  // K3 MCP client: servers are resolved now (no process starts); sessions call startSession().
  const mcp = new McpManager({
    home,
    workspaceRoot,
    workspaceKey: trustState.root,
    environment: env,
    registry,
    clientVersion: SYNORCH_VERSION,
    user: { config: config.mcp.user, file: config.mcp.userFile },
    project: { config: config.mcp.project, file: config.mcp.projectFile },
    platform,
    // MCP results are untrusted like web content: the outward-action shield applies for the rest of the turn.
    onUntrustedContent: () => webSession.markContentRead(),
    addRedaction: (value) => redactionValues.add(value),
  });
  await mcp.load();
  mcpHolder.current = mcp;

  // K4.1 native OpenAI search: on in auto/full/plan, one question per session in ask, headless only with web.openai_hosted: true.
  let hostedConsent: boolean | undefined;
  webHooksState.gate = async (_request, signal) => {
    const setting = config.web.openaiHosted;
    if (setting === false) return false;
    if (permission === undefined) return setting === true;
    if (permission !== "ask") return true;
    if (hostedConsent !== undefined) return hostedConsent;
    const prompt = userPrompt;
    if (prompt === undefined) return false;
    const answer = await prompt("Let the OpenAI model search the web natively during this session? (Otherwise Synorch's web_search asks you at every search.)", [HOSTED_ALLOW, "Not now"], signal).catch(() => "");
    hostedConsent = answer.trim() === HOSTED_ALLOW;
    return hostedConsent;
  };
  const requestSessions = new Map<string, SessionId>();
  webHooksState.observe = (observed) => {
    webSession.markContentRead();
    const sessionId = requestSessions.get(observed.requestId);
    const writer = sessionId === undefined ? undefined : writers.get(sessionId);
    if (writer === undefined) return;
    for (const query of observed.queries.slice(0, 16)) {
      void writer
        .append({
          type: "web/searched",
          event_version: EVENT_VERSIONS["web/searched"],
          actor: { kind: "system" },
          data: { provider: "openai-hosted", query: query.slice(0, 500), sources: Math.min(1000, observed.sources.length), request_id: observed.requestId },
        } as SessionEventDraft)
        .catch(() => undefined);
    }
  };
  // K4.1 bookkeeping from the session events: turn boundaries (shield), URLs the user typed (robots.txt), request → log, domain grants.
  const approvalHosts = new Map<string, readonly string[]>();
  listeners.add((event) => {
    if (event.kind !== "session-event") return;
    const recorded = event.event;
    const conversation = recorded.run_id === undefined && recorded.attempt_id === undefined;
    if (recorded.type === "turn/started" && conversation) webSession.startTurn();
    else if (recorded.type === "message/recorded" && conversation && recorded.data.message?.role === "user") {
      for (const part of recorded.data.message.content) if (part.type === "text") webSession.noteUserText(part.text);
    } else if (recorded.type === "model/request_prepared") {
      requestSessions.set(recorded.data.request_id, recorded.session_id);
      if (requestSessions.size > 256) requestSessions.delete(requestSessions.keys().next().value ?? "");
    } else if (recorded.type === "approval/requested" && recorded.data.request.hosts !== undefined) {
      approvalHosts.set(recorded.data.request.approval_id, recorded.data.request.hosts);
    } else if (recorded.type === "approval/decided") {
      const hosts = approvalHosts.get(recorded.data.decision.approval_id);
      approvalHosts.delete(recorded.data.decision.approval_id);
      if (hosts === undefined || recorded.data.decision.decided_by !== "user" || recorded.data.decision.outcome !== "allowed-for-scope") return;
      const writer = writers.get(recorded.session_id);
      for (const host of hosts) {
        void webSession
          .allowDomain(host)
          .then((added) =>
            added && writer !== undefined
              ? writer.append({ type: "network/host_allowed", event_version: EVENT_VERSIONS["network/host_allowed"], actor: { kind: "user" }, data: { host, scope: "global" } } as SessionEventDraft)
              : undefined,
          )
          .catch(() => undefined);
      }
    }
  });

  const budgetGate = createBudgetGateSlot();
  const context = createContextBuilder({
    readSession: async (sessionId) => writers.get(sessionId) ?? (await rawSessions.openForRead(sessionId)),
    blobs,
    tools: registry,
    sources: createSourceReader(workspaceRoot),
    instructions: canonical.instructions,
    skills: canonical.skills,
    skillContext,
    memory: { store: memory, projectId, branch: gitBranch },
    budget: budgetGate,
    compactor: createCompactor({ blobs, writerFor: (sessionId) => writers.get(sessionId) }),
    platform,
    projectProfile: profileText,
  });

  /**
   * ADR-18 D1 / review R4: the harness runs a packet's verification commands itself after the
   * worker's turn, as a system call through the tool gateway into the attempt's session log: the
   * same pipeline as any `exec` (normalization, the credential-in-arguments check, the policy
   * engine with the packet's exact verification commands, workspace trust and dependency-link
   * rules, the sandbox runner, redaction) and the same `tool/*` audit events, with `actor.kind:
   * system` and no short ref. A command the policy does not allow outright is not run (a system
   * call never asks): `not-run` + reason. The class (`classifyVerificationCommand`) says whether a
   * passed run can prove behaviour (review R1/R2).
   */
  const verificationGateways = new WeakMap<EventStore, ToolGateway>();
  const verificationBroker = createHeadlessApprovalBroker({ mode: options.policyMode });
  const verification: VerificationRunner = async (request) => {
    const started = Date.now();
    const commandClass = classifyVerificationCommand(request.argv);
    const notRun = (reason: string) => ({ status: "not-run" as const, commandClass, exitCode: null, output: "", durationMs: Date.now() - started, reason: reason.slice(0, 500) });
    const events = request.events;
    if (events === undefined) return notRun("no attempt log is open to record the run");
    let gateway = verificationGateways.get(events);
    if (gateway === undefined) {
      gateway = createToolGateway({ events, blobs, registry, policy, approvals: verificationBroker, sandbox: runner, redactionValues: () => [...redactionValues], platform });
      verificationGateways.set(events, gateway);
    }
    try {
      const toolCallId = createId("toolCall");
      const outcome = await gateway.invoke(
        { tool_call_id: toolCallId, provider_call_id: `harness-verification-${toolCallId}`, tool_name: "exec", arguments: { argv: [...request.argv] } },
        { runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, role: request.role, policy: request.policy, actor: "system" },
        request.signal,
      );
      const result = outcome.result;
      if (result.exit_code === undefined && (outcome.state === "denied" || (outcome.state === "cancelled" && outcome.decision?.decision !== "allow"))) {
        return notRun(`${outcome.state === "denied" ? "refused" : "cancelled"}: ${result.error?.message ?? "the gateway did not run it"}`);
      }
      let full = result.text;
      if (result.blob !== undefined && result.blob.media_type.startsWith("text/")) {
        full = await blobs.get(result.blob.digest).then((bytes) => Buffer.from(bytes).toString("utf8"), () => result.text);
      }
      const output = `${full}${result.error === undefined ? "" : `\n${result.error.message}`}`;
      const termination = result.exit_code !== undefined ? "exited" : result.error?.code === "timeout" ? "timeout" : result.error?.code === "cancelled" ? "cancelled" : "spawn-failed";
      const exitCode = result.exit_code ?? null;
      const passed = termination === "exited" && exitCode === 0;
      return { status: passed ? ("passed" as const) : ("failed" as const), commandClass, termination, exitCode, output, durationMs: Date.now() - started };
    } catch (error) {
      return notRun(`the harness could not run it: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Claude Code native mode: its permission prompts go to the same broker as the gateway's (ADR-08 revision 2026-09-24).
  const redactText = createRedactor(() => [...redactionValues]);
  const backendRedact = (text: string): string => redactText(text).text;
  const backendApprovals = (broker: ApprovalBroker) =>
    createClaudeNativeApprovals({
      broker,
      permissionMode: () => permission,
      commandGrants: () => createCommandGrantStore(home, effectiveTrust().root).list(),
      redact: backendRedact,
      web: { domains: () => webSession.domains(), environment: env },
      askUser: (questions, signal) => askUserQuestions(questions, signal),
    });

  // K6 reasoning effort: session levels (`/effort`, `--effort <tier>=`) > `--effort <level>` > config role > config tier.
  const sessionEfforts = new Map<ModelTier, ReasoningEffort>();
  for (const entry of options.efforts ?? []) if (entry.tier !== undefined) sessionEfforts.set(entry.tier, entry.level);
  const flagEffort = options.efforts?.find((entry) => entry.tier === undefined)?.level;
  const effortNotices = new Set<string>();
  const effortFor = (tier: ModelTier, role: AgentRole | undefined, route: Pick<RouteBinding, "provider_id" | "model_id" | "adapter_id">): EffortResolution => {
    // The conversation (role session) may run on the orchestrator route: its own `session` level comes first.
    const conversation = role === "session";
    const roleLevel = role === undefined || role === "orchestrator" ? undefined : config.effort[role];
    const sessionLevel = (conversation ? sessionEfforts.get("session") : undefined) ?? sessionEfforts.get(tier);
    const requested = sessionLevel ?? flagEffort ?? roleLevel ?? config.effort[tier];
    return resolveEffort(requested, { provider: route.provider_id, model: route.model_id, adapterId: route.adapter_id });
  };
  const stepEffort = (input: { readonly role: AgentRole; readonly route: ModelRoute }): ReasoningEffort | undefined => {
    const tier: ModelTier = input.route.tier ?? (input.role === "session" ? "session" : input.role === "orchestrator" ? "orchestrator" : "complex_worker");
    const resolution = effortFor(tier, input.role, input.route);
    // A clamp is said once per level and model, never silently.
    if (resolution.notice !== undefined && !effortNotices.has(resolution.notice)) {
      effortNotices.add(resolution.notice);
      emit({ kind: "notice", level: "info", message: resolution.notice });
    }
    return resolution.effective;
  };

  const createDriver = (broker: ApprovalBroker) => (events: EventStore): AgentDriver =>
    createAgentDriver({
      events,
      blobs,
      router,
      context,
      tools: registry,
      gateway: createToolGateway({ events, blobs, registry, policy, approvals: broker, sandbox: runner, redactionValues: () => [...redactionValues] }),
      credentials,
      backendApprovals: backendApprovals(broker),
      backendRedact,
      reasoningEffort: stepEffort,
    });

  const runtime: Runtime = {
    home,
    workspaceRoot,
    projectId,
    platform,
    policyMode: options.policyMode,
    config,
    canonical,
    profile,
    sessions,
    blobs,
    router,
    adapters,
    policy,
    registry,
    processes,
    sandbox,
    trust,
    memory,
    memoryRoot,
    gitBranch,
    context,
    budgetGate,
    credentials,
    orchestrate,
    web: webSession,
    mcp,
    credentialStore,
    authProvider,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindUserPrompt(prompt, choose) {
      userPrompt = prompt;
      userChoice = choose;
      return () => {
        if (userPrompt === prompt) {
          userPrompt = undefined;
          userChoice = undefined;
        }
      };
    },
    askUserQuestions,
    brokerFor(interactive) {
      // Workers follow the session's permission mode (ADR-08 revision 3): what asks in auto/full (outward writes, destructive commands) reaches the user.
      if ((options.policyMode === "ask" || permission !== undefined) && interactive !== undefined && interactive.availability !== "headless") return interactive;
      return createHeadlessApprovalBroker({ mode: options.policyMode });
    },
    createDriver,
    createSessionDriver(broker, events, wrap) {
      return createAgentDriver({
        events,
        blobs,
        router,
        context,
        tools: registry,
        gateway: wrap(createToolGateway({ events, blobs, registry, policy, approvals: broker, sandbox: runner, redactionValues: () => [...redactionValues], platform })),
        credentials,
        backendApprovals: backendApprovals(broker),
        backendRedact,
        reasoningEffort: stepEffort,
      });
    },
    sessionPolicy(commandGrants) {
      return policy.compute({
        mode: options.policyMode,
        role: "session",
        runId: undefined,
        taskId: undefined,
        workspaceRoot,
        taskScope: undefined,
        userConfig,
        workspaceConfig,
        sandbox,
        grants: [],
        commandGrants,
        ...(permission === undefined ? {} : { permissionMode: permission }),
      });
    },
    permissionMode: () => permission,
    setPermissionMode(mode) {
      permission = mode;
    },
    approveGitPushForSession() {
      gitPushApproved = true;
    },
    createCoordinator(broker) {
      const driverFor = createDriver(broker);
      return createCoordinator({
        sessions,
        blobs,
        router,
        policy,
        approvals: broker,
        planner: createModelPlanner({
          createDriver: driverFor,
          blobs,
          projectHint: () => {
            const known = profile.current();
            return known === undefined ? undefined : plannerHint(known);
          },
        }),
        sandbox,
        createWorkers: createWorkerFactory({
          sessions,
          blobs,
          router,
          policy,
          createDriver: driverFor,
          sandbox,
          worktreesRoot: path.join(home, "worktrees"),
          userConfig,
          workspaceConfig,
          platform,
          verification,
          reports,
        }),
        budgetGate,
        delegation,
        userConfig,
        workspaceConfig,
        platform,
        workspaceTrust: effectiveTrust,
        ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
      });
    },
    routeRules: () => baseRouter.rules(),
    async setSessionRoute(tier, role, binding) {
      const adapter = await implicitAdapter(binding.adapter_id);
      if (adapter === undefined) throw configError(`adapter ${binding.adapter_id} is neither built in nor configured`);
      if (adapter.providerId !== binding.provider_id) throw configError(`adapter ${adapter.adapterId} belongs to ${adapter.providerId}, not ${binding.provider_id}`);
      const identity = await identityOf(adapter.providerId, adapter.authMethod, binding.profile ?? "default", new AbortController().signal);
      if (!identity.connected) throw configError(`${adapter.providerId} (${adapter.authMethod}) is not logged in: ${identity.hint}`);
      if (!baseRouter.hasAdapter(adapter.adapterId)) {
        baseRouter.addAdapter(adapter);
        if (!adapters.includes(adapter)) adapters.push(adapter);
      }
      return baseRouter.setSessionRule(tier, role, binding);
    },
    clearSessionRoute: (tier, role) => baseRouter.clearSessionRule(tier, role),
    effortFor,
    setSessionEffort(tier, level) {
      if (level === undefined) sessionEfforts.delete(tier);
      else sessionEfforts.set(tier, level);
    },
    async modelCatalog(signal, catalogOptions = {}) {
      const pool: AnyModelAdapter[] = [...adapters];
      for (const id of Object.keys(IMPLICIT_ADAPTERS)) {
        if (pool.some((adapter) => adapter.adapterId === id)) continue;
        const built = await implicitAdapter(id).catch(() => undefined);
        if (built !== undefined) pool.push(built);
      }
      return buildModelCatalog({
        adapters: pool,
        rules: baseRouter.rules(),
        identity: (provider, method) => identityOf(provider, method, "default", signal),
        ...(catalogOptions.listing === true
          ? {
              listed: async (adapter: AnyModelAdapter) => {
                if (adapter.kind !== "model" || adapter.authMethod !== "oauth-subscription" || adapter.providerId !== "openai") return undefined;
                const auth = authProvider("openai", "oauth-subscription", "default");
                if (auth === undefined) return undefined;
                const credential = await auth.resolve(signal);
                const headers = new Headers({ accept: "application/json", originator: SYNORCH_ORIGINATOR });
                credential.applyTo(headers);
                return fetchCodexModels(overrides.fetch ?? fetch, headers, signal, CHATGPT_CODEX_BASE_URL);
              },
            }
          : {}),
      });
    },
    async recover(sessionId) {
      const isIdempotent = (name: string): boolean => registry.get(name)?.metadata.idempotent ?? false;
      const reports: RecoveryReport[] = [];
      const log = await sessions.openForWrite(sessionId);
      const attemptSessions: SessionId[] = [];
      try {
        reports.push(await recoverSession(log, { isIdempotent }));
        for await (const item of log.read()) {
          if (item.status === "ok" && item.event.type === "attempt/started" && item.event.data.session_id !== undefined) {
            attemptSessions.push(item.event.data.session_id);
          }
        }
      } finally {
        await log.close();
      }
      for (const attempt of attemptSessions) {
        const events = await sessions.openForWrite(attempt).catch(() => undefined);
        if (events === undefined) continue;
        try {
          let last: SessionEvent | undefined;
          for await (const item of events.read()) if (item.status === "ok") last = item.event;
          if (last?.type === "turn/ended" && events.quarantinedTail === undefined) continue;
          if (last?.type === "session/resumed") continue;
          reports.push(await recoverSession(events, { isIdempotent }));
        } finally {
          await events.close();
        }
      }
      // SEC-M3: crashed attempts leave worktrees and scoped-dir writes behind; only orphans whose owner process is gone are touched.
      await pruneOrphanedAttempts({ worktreesRoot: path.join(home, "worktrees"), projectId, workspaceRoot, platform }).catch(() => undefined);
      return reports;
    },
  };
  return runtime;
}
