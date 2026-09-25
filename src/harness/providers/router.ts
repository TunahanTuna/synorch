import {
  approvalDecisionSchema,
  approvalRequestSchema,
  createId,
  digestOf,
  HarnessError,
  modelRouteSchema,
  ProviderFailure,
  ROUTE_SOURCES,
  RouteBlockedFailure,
  routeDecisionSchema,
  type AgentRole,
  type AnyModelAdapter,
  type ApprovalRequest,
  type ModelRoute,
  type ModelRouter,
  type ModelRouterConfig,
  type ModelTier,
  type ProviderCapabilities,
  type RouteBinding,
  type RouteDecision,
  type RouteRule,
} from "../contracts/index.ts";
import { providerError } from "./errors.ts";
import type { ReviewCrossProviderMode } from "./reviewer-route.ts";

/** Construction options on top of the contract configuration; tests inject the clock. */
export interface ModelRouterOptions extends ModelRouterConfig {
  readonly now?: () => Date;
  readonly capabilityTtlMs?: number;
  /**
   * Reviewer independence (ADR-09, K1.5): prefer a reviewer route on a provider other than the
   * implementer's when one is configured (default true); otherwise a different model; the decision's
   * reason always says which independence was achieved, never silently.
   */
  readonly preferDifferentProvider?: boolean;
  /**
   * K3 cross-provider review (`review.cross_provider`): `prefer` (default) takes a reviewer on
   * another provider when one is configured or logged in, `off` keeps the implementer's provider
   * (a different model when configured), `require` fails the review dispatch when no other provider
   * is available. An explicit reviewer route (`routes.<tier>.reviewer`) always wins. When set, it
   * replaces `preferDifferentProvider`.
   */
  readonly reviewCrossProvider?: ReviewCrossProviderMode;
  /**
   * Asked when no configured route is on a provider other than the implementer's: the best
   * logged-in catalog model on another provider for the tier (the runtime registers its adapter
   * first), or undefined when none is connected.
   */
  readonly crossProviderReviewer?: (request: { readonly tier: ModelTier; readonly excludeProvider: string }, signal: AbortSignal) => Promise<RouteBinding | undefined>;
}

/** The router the composition root holds: the contract plus the session route layer `/model` edits. */
export interface SessionModelRouter extends ModelRouter {
  /** Every rule in precedence order as the router sees it now (session rules first). */
  rules(): readonly RouteRule[];
  /** Sets (replaces) the session-layer route of a tier (and role); validated against the registered adapters. */
  setSessionRule(tier: ModelTier, role: AgentRole | undefined, route: RouteBinding): ModelRoute;
  /** Removes the session-layer route of a tier (and role); returns whether one existed. */
  clearSessionRule(tier: ModelTier, role: AgentRole | undefined): boolean;
  /** Registers an adapter built after construction (a provider first chosen in `/model`); an existing id is kept. */
  addAdapter(adapter: AnyModelAdapter): void;
  hasAdapter(adapterId: string): boolean;
}

interface Candidate {
  readonly rule: RouteRule;
  readonly route: ModelRoute;
}

interface Override {
  readonly from: ModelRoute;
  readonly to: ModelRoute;
  readonly approvalId: ApprovalRequest["approval_id"];
}

const DEFAULT_CAPABILITY_TTL_MS = 5 * 60_000;

/**
 * Resolves `{tier, role}` to a route by source precedence (`session > project > workspace > user >
 * provider-default`), prefers a model independent of the implementer for reviewers (ADR-09),
 * probes capabilities without paid calls and never falls back silently: a blocked route raises
 * `quota_exhausted` until a human approves a `provider-change`.
 */
export function createModelRouter(config: ModelRouterOptions, providers: readonly AnyModelAdapter[]): SessionModelRouter {
  const now = config.now ?? (() => new Date());
  const ttl = config.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const adapters = new Map<string, AnyModelAdapter>();
  for (const adapter of providers) {
    if (adapters.has(adapter.adapterId)) throw configError(`adapter ${adapter.adapterId} is registered twice`);
    adapters.set(adapter.adapterId, adapter);
  }
  let candidates = config.rules.map((rule): Candidate => ({ rule, route: routeOf(rule) }));
  const crossMode: ReviewCrossProviderMode = config.reviewCrossProvider ?? (config.preferDifferentProvider === false ? "off" : "prefer");
  const preferDifferentProvider = crossMode !== "off";
  const blocked = new Map<string, number>();
  const pending = new Map<string, Override & { readonly digest: string; readonly tier: ModelTier; readonly role: AgentRole | undefined }>();
  const overrides = new Map<string, Override>();
  const capabilityCache = new Map<string, { readonly at: number; readonly capabilities: ProviderCapabilities }>();

  function routeOf(rule: RouteRule): ModelRoute {
    const adapter = adapters.get(rule.route.adapter_id);
    if (adapter === undefined) throw configError(`route for ${rule.tier} uses unknown adapter ${rule.route.adapter_id}`);
    if (adapter.providerId !== rule.route.provider_id) {
      throw configError(`adapter ${adapter.adapterId} belongs to ${adapter.providerId}, not ${rule.route.provider_id}`);
    }
    const parsed = modelRouteSchema.safeParse({
      provider_id: rule.route.provider_id,
      model_id: rule.route.model_id,
      adapter_id: adapter.adapterId,
      adapter_kind: adapter.kind,
      auth_method: adapter.authMethod,
      profile: rule.route.profile ?? "default",
      tier: rule.tier,
    });
    if (!parsed.success) throw configError(`invalid route for ${rule.tier}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return parsed.data;
  }

  function ordered(tier: ModelTier, role: AgentRole | undefined): Candidate[] {
    return candidates
      .filter((candidate) => candidate.rule.tier === tier && (candidate.rule.role === undefined || candidate.rule.role === role))
      .map((candidate, position) => ({ candidate, position }))
      .sort((left, right) => {
        const bySource = ROUTE_SOURCES.indexOf(left.candidate.rule.source) - ROUTE_SOURCES.indexOf(right.candidate.rule.source);
        if (bySource !== 0) return bySource;
        const byRole = Number(left.candidate.rule.role === undefined) - Number(right.candidate.rule.role === undefined);
        return byRole !== 0 ? byRole : left.position - right.position;
      })
      .map(({ candidate }) => candidate);
  }

  function isBlocked(route: ModelRoute): boolean {
    const until = blocked.get(routeKey(route));
    if (until === undefined) return false;
    if (until <= now().getTime()) {
      blocked.delete(routeKey(route));
      return false;
    }
    return true;
  }

  async function probe(route: ModelRoute, signal: AbortSignal): Promise<ProviderCapabilities | undefined> {
    const adapter = adapters.get(route.adapter_id);
    if (adapter === undefined) return undefined;
    const cached = capabilityCache.get(adapter.adapterId);
    if (cached !== undefined && now().getTime() - cached.at < ttl) return cached.capabilities;
    try {
      const capabilities = await adapter.discoverCapabilities(signal);
      capabilityCache.set(adapter.adapterId, { at: now().getTime(), capabilities });
      return capabilities;
    } catch {
      return undefined;
    }
  }

  const router: SessionModelRouter = {
    async resolve(request, signal): Promise<RouteDecision> {
      const options = ordered(request.tier, request.role);
      const primary = options[0];
      if (primary === undefined) throw configError(`no route is configured for tier ${request.tier}`);
      let chosen = primary;
      let reason = `${primary.rule.source} maps ${request.tier} to ${primary.route.model_id}`;
      if (request.role === "reviewer") {
        const implementer = request.implementer ?? ordered(request.tier, "implementer")[0]?.route;
        // routes.<tier>.reviewer is the user's own choice: it always wins over the cross-provider preference
        // (among several explicit reviewer routes, one on another provider is still preferred).
        const explicitRoutes = options.filter((option) => option.rule.role === "reviewer");
        const explicit =
          (preferDifferentProvider && implementer !== undefined ? explicitRoutes.find((option) => option.route.provider_id !== implementer.provider_id) : undefined) ?? explicitRoutes[0];
        if (explicit !== undefined) {
          chosen = explicit;
          reason = `${explicit.rule.source} routes the ${request.tier} reviewer explicitly to ${explicit.route.provider_id}/${explicit.route.model_id}`;
          if (implementer !== undefined) {
            reason =
              explicit.route.provider_id === implementer.provider_id
                ? `${reason}; same provider as the implementer (${implementer.provider_id}), the explicit route wins`
                : `${reason}; independent of the implementer provider ${implementer.provider_id}`;
          }
        } else if (implementer !== undefined) {
          const otherProvider = (candidate: Candidate): boolean => candidate.route.provider_id !== implementer.provider_id;
          let crossProvider = options.find(otherProvider);
          let crossTier = false;
          let fromCatalog = false;
          if (preferDifferentProvider && crossProvider === undefined) {
            // No same-tier route on another provider: any configured route on another provider, reviewer rules first.
            crossProvider = [...candidates]
              .filter(otherProvider)
              .sort((left, right) => Number(left.rule.role !== "reviewer") - Number(right.rule.role !== "reviewer") || ROUTE_SOURCES.indexOf(left.rule.source) - ROUTE_SOURCES.indexOf(right.rule.source))
              .find((candidate) => candidate.rule.role === undefined || candidate.rule.role === "reviewer");
            crossTier = crossProvider !== undefined;
          }
          if (preferDifferentProvider && crossProvider === undefined && config.crossProviderReviewer !== undefined && implementer.provider_id !== "scripted") {
            // Nothing configured on another provider: that provider's best logged-in model (catalog).
            const binding = await config.crossProviderReviewer({ tier: request.tier, excludeProvider: implementer.provider_id }, signal).catch(() => undefined);
            if (binding !== undefined && binding.provider_id !== implementer.provider_id && adapters.has(binding.adapter_id)) {
              const rule: RouteRule = { source: "provider-default", tier: request.tier, role: "reviewer", route: binding };
              crossProvider = { rule, route: routeOf(rule) };
              fromCatalog = true;
            }
          }
          const otherModel = options.find((option) => !sameModel(option.route, implementer));
          if (preferDifferentProvider && crossProvider !== undefined) {
            chosen = crossTier ? { rule: crossProvider.rule, route: modelRouteSchema.parse({ ...crossProvider.route, tier: request.tier }) } : crossProvider;
            reason = fromCatalog
              ? `cross-provider review: ${crossProvider.route.provider_id}/${crossProvider.route.model_id} (${crossProvider.route.auth_method}) is the best logged-in ${crossProvider.route.provider_id} model for ${request.tier}; independent of the implementer provider ${implementer.provider_id}`
              : `${crossProvider.rule.source} maps ${crossTier ? `${crossProvider.rule.tier} (no ${request.tier} route on another provider)` : request.tier} to ${crossProvider.route.provider_id}/${crossProvider.route.model_id}; independent of the implementer provider ${implementer.provider_id}`;
          } else if (crossMode === "require") {
            throw new HarnessError({
              code: "config_invalid",
              message:
                `review.cross_provider is require, but no provider other than ${implementer.provider_id} is configured or logged in for the ${request.tier} reviewer; ` +
                `log in to another provider (syn login anthropic --method cli-bridge, syn login openai), set routes.${request.tier}.reviewer, or set review.cross_provider prefer`,
              workspace_effect: "none",
              retry_safe: false,
            });
          } else if (otherModel !== undefined) {
            chosen = otherModel;
            reason = `${otherModel.rule.source} maps ${request.tier} to ${otherModel.route.model_id}; independent of the implementer model ${implementer.model_id}`;
            if (preferDifferentProvider) reason = `${reason}; no route on a provider other than ${implementer.provider_id} is configured, so the reviewer uses the same provider`;
          } else {
            reason = `${reason}; no independent reviewer model is configured, the reviewer shares the implementer model`;
            if (preferDifferentProvider) reason = `${reason} (no provider other than ${implementer.provider_id} is configured or logged in)`;
          }
        }
      }

      let route = chosen.route;
      let fallback: RouteDecision["fallback"] = { used: false };
      if (isBlocked(route)) {
        const override = overrides.get(routeKey(route));
        if (override === undefined) {
          const alternatives = options.map((option) => option.route).filter((candidate) => !sameRoute(candidate, route) && !isBlocked(candidate));
          throw new RouteBlockedFailure(
            providerError("quota_exhausted", `quota for ${route.provider_id}/${route.model_id} (${route.auth_method}) is exhausted; switching requires a human provider-change approval`),
            route,
            request,
            alternatives,
          );
        }
        fallback = { used: true, from: override.from, approval_id: override.approvalId };
        reason = `${reason}; quota exhausted, provider-change ${override.approvalId} approved by the user`;
        route = override.to;
      }

      const capabilities = await probe(route, signal);
      if (capabilities !== undefined && capabilities.models.length > 0 && !capabilities.models.some((model) => model.id === route.model_id)) {
        throw new ProviderFailure(providerError("model_unavailable", `${route.adapter_id} does not list model ${route.model_id}`));
      }
      if (capabilities === undefined) reason = `${reason}; capability probe unavailable`;

      return routeDecisionSchema.parse({
        tier: request.tier,
        ...(request.role === undefined ? {} : { role: request.role }),
        route,
        source: chosen.rule.source,
        reason,
        ...(capabilities === undefined ? {} : { capabilities_probed_at: capabilities.probed_at }),
        fallback,
      });
    },

    rules() {
      return [...candidates]
        .map((candidate, position) => ({ candidate, position }))
        .sort((left, right) => ROUTE_SOURCES.indexOf(left.candidate.rule.source) - ROUTE_SOURCES.indexOf(right.candidate.rule.source) || left.position - right.position)
        .map(({ candidate }) => candidate.rule);
    },

    setSessionRule(tier, role, binding) {
      const rule: RouteRule = { source: "session", tier, ...(role === undefined ? {} : { role }), route: binding };
      const candidate: Candidate = { rule, route: routeOf(rule) };
      candidates = [candidate, ...candidates.filter((entry) => !(entry.rule.source === "session" && entry.rule.tier === tier && entry.rule.role === role))];
      return candidate.route;
    },

    addAdapter(adapter) {
      if (!adapters.has(adapter.adapterId)) adapters.set(adapter.adapterId, adapter);
    },

    hasAdapter(adapterId) {
      return adapters.has(adapterId);
    },

    clearSessionRule(tier, role) {
      const before = candidates.length;
      candidates = candidates.filter((entry) => !(entry.rule.source === "session" && entry.rule.tier === tier && entry.rule.role === role));
      return candidates.length !== before;
    },

    adapterFor(route) {
      const adapter = adapters.get(route.adapter_id);
      if (adapter === undefined) throw configError(`no adapter is registered for ${route.adapter_id}`);
      return adapter;
    },

    reportFailure(route, error) {
      if (error.code !== "quota_exhausted") return;
      const until = error.retry_after_ms === undefined ? Number.POSITIVE_INFINITY : now().getTime() + error.retry_after_ms;
      blocked.set(routeKey(route), until);
    },

    proposeProviderChange(failure, context) {
      const to = context.to ?? failure.alternatives[0];
      if (to === undefined) {
        throw new HarnessError({
          code: "provider_failed",
          message: `no alternative route is configured for ${failure.tier}; wait for the quota reset`,
          workspace_effect: "none",
          retry_safe: false,
        });
      }
      const subject = { kind: "provider-change", tier: failure.tier, role: failure.role ?? null, from: failure.blocked, to };
      const request = approvalRequestSchema.parse({
        approval_id: createId("approval"),
        run_id: context.runId,
        ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
        subject_kind: "provider-change",
        subject_digest: digestOf(subject),
        summary:
          `${failure.blocked.provider_id}/${failure.blocked.model_id} (${failure.blocked.auth_method}) quota is exhausted. ` +
          `Switch ${failure.tier} to ${to.provider_id}/${to.model_id} (${to.auth_method})? This may bill a different account.`,
        scope: "session",
        requested_at: now().toISOString(),
      });
      pending.set(request.approval_id, {
        from: failure.blocked,
        to,
        approvalId: request.approval_id,
        digest: request.subject_digest,
        tier: failure.tier,
        role: failure.role,
      });
      return { request, from: failure.blocked, to };
    },

    applyProviderChange(decision) {
      const parsed = approvalDecisionSchema.parse(decision);
      const proposal = pending.get(parsed.approval_id);
      if (proposal === undefined || parsed.subject_kind !== "provider-change" || parsed.subject_digest !== proposal.digest) {
        throw new HarnessError({
          code: "approval_rejected",
          message: "the decision does not match a pending provider-change proposal",
          workspace_effect: "none",
          retry_safe: false,
        });
      }
      const allowed = parsed.outcome === "allowed-once" || parsed.outcome === "allowed-for-scope";
      if (!allowed || parsed.decided_by !== "user") {
        pending.delete(parsed.approval_id);
        throw new HarnessError({
          code: "approval_rejected",
          message: allowed ? "a provider change can only be approved by the user" : `provider change ${parsed.outcome}`,
          workspace_effect: "none",
          retry_safe: false,
        });
      }
      pending.delete(parsed.approval_id);
      overrides.set(routeKey(proposal.from), { from: proposal.from, to: proposal.to, approvalId: proposal.approvalId });
    },
  };
  return router;
}

function routeKey(route: ModelRoute): string {
  return `${route.provider_id}|${route.adapter_id}|${route.auth_method}|${route.profile}|${route.model_id}`;
}

function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return routeKey(left) === routeKey(right);
}

function sameModel(left: ModelRoute, right: ModelRoute): boolean {
  return left.provider_id === right.provider_id && left.model_id === right.model_id;
}

function configError(message: string): HarnessError {
  return new HarnessError({ code: "config_invalid", message, workspace_effect: "none", retry_safe: false });
}
