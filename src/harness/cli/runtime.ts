import os from "node:os";
import path from "node:path";
import {
  createId,
  credentialRefSchema,
  deriveProjectId,
  EVENT_VERSIONS,
  HarnessError,
  memoryProposalSchema,
  providerIdSchema,
  ProviderFailure,
  type AgentDriver,
  type AnyModelAdapter,
  type ApprovalBroker,
  type AuthProvider,
  type BlobStore,
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
import { createMemoryStore, readGitBranch, resolveMemoryRoot } from "../memory/index.ts";
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
  CHATGPT_CODEX_BASE_URL,
  fetchCodexModels,
  SYNORCH_ORIGINATOR,
  type CatalogIdentity,
  type CatalogModel,
  type FetchLike,
} from "../providers/index.ts";
import { createBlobStore, createSessionStore } from "../store/index.ts";
import { BackgroundProcessManager, createSandboxRunner, createToolGateway, createToolRegistry, probeSandbox } from "../tools/index.ts";
import type { RouteOverride } from "./args.ts";
import { loadCanonicalStructure, type CanonicalStructure } from "./canonical.ts";
import { checkEndpoint, DEFAULT_ADAPTER_FOR_PROVIDER, loadRuntimeConfig, resolveHome, type ConfiguredAdapter, type RuntimeConfig } from "./config.ts";
import { withRoleDefinitions } from "./role-policy.ts";
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

export interface Runtime {
  readonly home: string;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly platform: NodeJS.Platform;
  readonly policyMode: PolicyMode;
  readonly config: RuntimeConfig;
  /** The target repository's canonical `.ai/` structure (or the built-in defaults) fed to context and policy. */
  readonly canonical: CanonicalStructure;
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
  /** Lazily opened: probing the OS keychain can spawn a helper process. */
  credentialStore(): SynorchCredentialStore;
  authProvider(providerId: string, method: AuthProvider["method"], profile: string): AuthProvider | undefined;
  /** Every session event appended through this runtime (run and attempt sessions) and every model stream event. */
  subscribe(listener: RuntimeListener): () => void;
  /**
   * Binds `ask_user` to a human for the lifetime of a session; returns the unbind function. With no
   * binding (headless, JSONL, piped input) `ask_user` answers `approval_unavailable`.
   */
  bindUserPrompt(prompt: UserPrompt): () => void;
  /** The approval broker for a session: the renderer's interactive broker in `ask` mode, the headless one otherwise. */
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
  /** Crash recovery of a session and of every attempt session it started; nothing is re-executed. */
  recover(sessionId: SessionId): Promise<readonly RecoveryReport[]>;
}

const SCRIPTED_PROVIDER = "scripted";

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

async function buildAdapter(entry: ConfiguredAdapter, fetch: FetchLike | undefined, env: Env, home: string): Promise<AnyModelAdapter> {
  if (entry.source !== "user") throw configError(`adapter ${entry.id} comes from the ${entry.source} layer; only the user configuration declares adapters`);
  if (entry.baseUrl !== undefined && entry.kind === "openai-chatgpt") {
    const refused = checkEndpoint(entry.kind, entry.baseUrl, false);
    if (refused !== undefined) throw configError(`adapter ${entry.id}: ${refused}`);
  }
  const common = { ...(fetch === undefined ? {} : { fetch }), ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }) };
  switch (entry.kind) {
    case "openai-chatgpt":
      return withId(createOpenAIChatGPTAdapter(common), entry.id);
    case "openai-responses":
      return withId(createOpenAIResponsesAdapter(common), entry.id);
    case "anthropic-messages":
      return withId(createAnthropicMessagesAdapter(common), entry.id);
    case "claude-code":
      return createClaudeCodeAdapter({ experimental: await bridgeEnabled(home), env, allowNonSubscriptionAuth: entry.allowNonSubscriptionAuth === true });
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

async function buildAdapters(config: RuntimeConfig, overrides: RuntimeOverrides, env: Env, home: string): Promise<AnyModelAdapter[]> {
  const injected = new Map((overrides.adapters ?? []).map((adapter) => [adapter.adapterId, adapter]));
  const built = new Map<string, AnyModelAdapter>();
  for (const entry of config.adapters) {
    if (!injected.has(entry.id)) built.set(entry.id, await buildAdapter(entry, overrides.fetch, env, home));
  }
  for (const rule of config.router.rules) {
    const id = rule.route.adapter_id;
    if (built.has(id) || injected.has(id)) continue;
    const kind = IMPLICIT_ADAPTERS[id];
    if (kind === undefined) {
      const hint = DEFAULT_ADAPTER_FOR_PROVIDER[rule.route.provider_id] === id ? " (declare it under adapters)" : "";
      throw configError(`route for ${rule.tier} uses adapter ${id}, which is neither built in nor configured${hint}`);
    }
    built.set(id, await buildAdapter({ id, kind, script: undefined, provider: undefined, baseUrl: undefined, source: "user" }, overrides.fetch, env, home));
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
  const adapters = await buildAdapters(config, overrides, env, home);
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
    return buildAdapter({ id, kind, script: undefined, provider: undefined, baseUrl: undefined, source: "user" }, overrides.fetch, env, home);
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
  const trustStore = createWorkspaceTrustStore(home, { platform });
  const stored = trustStore.status(workspaceRoot);
  let trustState: WorkspaceTrustState = !stored.trusted && options.trustWorkspace === true ? { ...stored, trusted: true, source: "flag", reason: undefined } : stored;
  let permission: PermissionMode | undefined = options.permissionMode;
  // Full access implies trust for this runtime only; leaving full access returns to the recorded trust.
  const effectiveTrust = (): WorkspaceTrustState => (trustState.trusted || permission !== "full" ? trustState : { ...trustState, trusted: true, source: "session", reason: undefined });
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
  const policy = withRoleDefinitions(createPolicyEngine({ synorchHome: home, workspaceTrusted: () => effectiveTrust().trusted, permissionMode: () => permission }), canonical.roles);
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
  const processes = new BackgroundProcessManager();
  const registry = createToolRegistry({
    processes,
    classifyCommand: (argv, scope) => classifyCommand(argv, scope),
    control: {
      ...delegationCallbacks(delegation),
      ...reportCallbacks(reports),
      // Only catalog skills the caller's role may use (never widening a read scope to .ai/**); a skill
      // already in the caller's context is not served again (ADR-20). One registry is shared with the
      // ContextBuilder, which records what each build injected.
      loadSkill: createSkillLoadCallback({ skills: canonical.skills, registry: skillContext }),
      async askUser(input, context) {
        const prompt = userPrompt;
        if ((context.role !== "orchestrator" && context.role !== "session") || prompt === undefined) {
          return {
            status: "error",
            text: "",
            truncated: false,
            redactions: 0,
            error: {
              code: "approval_unavailable",
              message: "no human can answer in this session (headless, JSONL or piped input); decide within the approved scope or stop and report what you need",
            },
          };
        }
        const answer = (await prompt(input.question, input.options, context.signal)).trim();
        return { status: "ok", text: `The user answered: ${answer === "" ? "(empty answer)" : answer}`.slice(0, 16 * 1024), truncated: false, redactions: 0 };
      },
      async memoryPropose(input, context) {
        const content = input.content;
        const parsed = memoryProposalSchema.safeParse({
          schema_version: 1,
          proposal_id: createId("proposal"),
          kind: input.kind,
          ...(content.note === undefined ? {} : { note: content.note }),
          ...(typeof content.body === "string" ? { body: content.body } : {}),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(content.relation === undefined ? {} : { relation: content.relation }),
          ...(typeof content.new_status === "string" ? { new_status: content.new_status } : {}),
          rationale: input.rationale,
          evidence: [{ kind: "tool-call", ref: context.toolCallId, produced_by: context.role === "reviewer" ? "reviewer" : context.role === "orchestrator" ? "orchestrator" : "worker" }],
          created_by: { run_id: context.runId, ...(context.taskId === undefined ? {} : { task_id: context.taskId }) },
          created_at: new Date().toISOString(),
          state: "pending",
        });
        if (!parsed.success) {
          return {
            status: "error",
            text: "",
            truncated: false,
            redactions: 0,
            error: { code: "invalid_arguments", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 2000) },
          };
        }
        await memory.propose(parsed.data);
        return { status: "ok", text: `proposal ${parsed.data.proposal_id} queued for review (syn memory review)`, truncated: false, redactions: 0 };
      },
    },
  });

  const orchestrate = createOrchestrateSlot();
  registry.register(createOrchestrateTool(orchestrate) as never);

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

  const createDriver = (broker: ApprovalBroker) => (events: EventStore): AgentDriver =>
    createAgentDriver({
      events,
      blobs,
      router,
      context,
      tools: registry,
      gateway: createToolGateway({ events, blobs, registry, policy, approvals: broker, sandbox: runner, redactionValues: () => [...redactionValues] }),
      credentials,
    });

  const runtime: Runtime = {
    home,
    workspaceRoot,
    projectId,
    platform,
    policyMode: options.policyMode,
    config,
    canonical,
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
    credentialStore,
    authProvider,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindUserPrompt(prompt) {
      userPrompt = prompt;
      return () => {
        if (userPrompt === prompt) userPrompt = undefined;
      };
    },
    brokerFor(interactive) {
      if (options.policyMode === "ask" && interactive !== undefined && interactive.availability !== "headless") return interactive;
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
    createCoordinator(broker) {
      const driverFor = createDriver(broker);
      return createCoordinator({
        sessions,
        blobs,
        router,
        policy,
        approvals: broker,
        planner: createModelPlanner({ createDriver: driverFor, blobs }),
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
