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
  type RouteDecision,
  type RouteRule,
} from "../contracts/index.ts";
import { providerError } from "./errors.ts";

/** Construction options on top of the contract configuration; tests inject the clock. */
export interface ModelRouterOptions extends ModelRouterConfig {
  readonly now?: () => Date;
  readonly capabilityTtlMs?: number;
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
export function createModelRouter(config: ModelRouterOptions, providers: readonly AnyModelAdapter[]): ModelRouter {
  const now = config.now ?? (() => new Date());
  const ttl = config.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const adapters = new Map<string, AnyModelAdapter>();
  for (const adapter of providers) {
    if (adapters.has(adapter.adapterId)) throw configError(`adapter ${adapter.adapterId} is registered twice`);
    adapters.set(adapter.adapterId, adapter);
  }
  const candidates = config.rules.map((rule): Candidate => ({ rule, route: routeOf(rule) }));
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

  const router: ModelRouter = {
    async resolve(request, signal): Promise<RouteDecision> {
      const options = ordered(request.tier, request.role);
      const primary = options[0];
      if (primary === undefined) throw configError(`no route is configured for tier ${request.tier}`);
      let chosen = primary;
      let reason = `${primary.rule.source} maps ${request.tier} to ${primary.route.model_id}`;
      if (request.role === "reviewer") {
        const implementer = ordered(request.tier, "implementer")[0];
        const independent = implementer === undefined ? undefined : options.find((option) => !sameModel(option.route, implementer.route));
        if (independent !== undefined) {
          chosen = independent;
          reason = `${independent.rule.source} maps ${request.tier} to ${independent.route.model_id}; independent of the implementer model ${implementer?.route.model_id ?? "unknown"}`;
        } else if (implementer !== undefined) {
          reason = `${reason}; no independent reviewer model is configured, the reviewer shares the implementer model`;
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
