import { randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import {
  createId,
  deriveProjectId,
  execConfinementFor,
  EXIT_CODES,
  selectRendererKind,
  type AuthStatus,
  type ModelRequest,
  type SandboxReport,
  type WorkspaceTrustState,
} from "../contracts/index.ts";
import { createWorkspaceTrustStore } from "../policy/index.ts";
import { createAuthProviders, createCredentialStore, ProfileStateStore, type SynorchCredentialStore } from "../auth/index.ts";
import { pruneOrphanedAttempts } from "../orchestration/index.ts";
import { createSessionStore } from "../store/index.ts";
import { probeSandbox } from "../tools/index.ts";
import { describeCanonical, describeProfiles } from "./canonical.ts";
import { profileHeaderLine, profileSummaryLines } from "./project-profile.ts";
import { resolveHome } from "./config.ts";
import { failureInfo } from "./outcome.ts";
import { createRuntime, type Runtime, type RuntimeOverrides } from "./runtime.ts";

/**
 * `syn doctor --runtime`: Node and terminal, configuration, sandbox enforcement, store health, auth
 * state and adapter capabilities as separate results. Nothing here sends a network request: auth
 * status reads local state, capability discovery and health are static (I2), the sandbox probe
 * runs local binaries. Only `--probe-model` sends one tiny, possibly billed, request per route.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: "node" | "terminal" | "config" | "canonical" | "profile" | "sandbox" | "trust" | "store" | "auth" | "capabilities" | "models" | "probe-model";
  readonly status: CheckStatus;
  readonly summary: string;
  readonly details: readonly unknown[];
}

export interface DoctorReport {
  readonly schema: "synorch.doctor.runtime";
  readonly version: 1;
  readonly ok: boolean;
  readonly home: string;
  readonly network_requests: "none" | "probe-model";
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorIO {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly platform: NodeJS.Platform;
  stdout(text: string): void;
}

function worst(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "ok";
}

function nodeCheck(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "node",
    status: major >= 24 ? "ok" : "fail",
    summary: `Node ${process.version} on ${process.platform} ${process.arch}${major >= 24 ? "" : " (Node 24 or newer is required)"}`,
    details: [{ version: process.version, platform: process.platform, arch: process.arch }],
  };
}

function terminalCheck(io: DoctorIO): DoctorCheck {
  const kind = selectRendererKind({ jsonl: false, plain: false, env: io.env, stdinIsTTY: io.stdinIsTTY, stdoutIsTTY: io.stdoutIsTTY });
  return {
    id: "terminal",
    status: "ok",
    summary: `interactive sessions render as ${kind} (stdin ${io.stdinIsTTY ? "tty" : "not a tty"}, stdout ${io.stdoutIsTTY ? "tty" : "not a tty"}, TERM=${io.env.TERM ?? "unset"})`,
    details: [{ renderer: kind, stdin_tty: io.stdinIsTTY, stdout_tty: io.stdoutIsTTY, term: io.env.TERM ?? null }],
  };
}

/** The canonical `.ai/` structure the runtime feeds to context and policy, or the built-in fallback. */
function canonicalCheck(runtime: Runtime): DoctorCheck {
  const canonical = runtime.canonical;
  const profiles = describeProfiles(canonical);
  return {
    id: "canonical",
    // The built-in structure is a first-class mode (K1.5-4): only diagnostics make this a warning.
    status: canonical.diagnostics.length === 0 ? "ok" : "warn",
    summary: `${describeCanonical(canonical, runtime.workspaceRoot)}${profiles === undefined ? "" : `; ${profiles}`}`,
    details: [
      {
        origin: canonical.origin,
        constitution: canonical.instructions.constitution !== undefined,
        protocols: canonical.protocolIds,
        roles: [...canonical.roles.values()].map((role) => ({
          role: role.role,
          source: role.source,
          model_tier: role.modelTier,
          writes_product_files: role.writesProductFiles,
          control_plane_write_scope: role.controlPlaneWriteScope ?? null,
        })),
        skills: canonical.skillEntries.map((skill) => ({ name: skill.name, kind: skill.kind, path: skill.path })),
        model_profile_hints: canonical.profiles,
        diagnostics: canonical.diagnostics,
      },
    ],
  };
}

/** The zero-config project profile the session and every worker receive (detected, cached in the user scope). */
async function profileCheck(runtime: Runtime): Promise<DoctorCheck> {
  const profile = await runtime.profile.ready;
  if (profile === undefined) return { id: "profile", status: "warn", summary: "the project profile could not be detected", details: [] };
  return {
    id: "profile",
    status: "ok",
    summary: `${profileHeaderLine(profile).replace(/^Synorch ready · /, "")} (cache ${runtime.profile.file})`,
    details: [{ lines: profileSummaryLines(profile), profile }],
  };
}

function sandboxCheck(report: SandboxReport): DoctorCheck {
  return {
    id: "sandbox",
    status: report.enforcement === "full" ? "ok" : report.enforcement === "partial" ? "warn" : "fail",
    summary: `${report.backend}: enforcement ${report.enforcement} (filesystem ${report.filesystem}, network ${report.network}, process ${report.process}); ${execConfinementLine(report)}`,
    details: [report],
  };
}

/** How `exec` is confined on this machine, per mode (ADR-06): a full sandbox, or a default-deny allowlist. */
function execConfinementLine(report: SandboxReport): string {
  const autonomous = execConfinementFor(report.enforcement, "autonomous");
  if (autonomous === "full-sandbox") return "exec confinement: full-sandbox";
  return `exec confinement: ${autonomous} in autonomous mode (verification commands and vetted build/test commands only), ${execConfinementFor(report.enforcement, "ask")} for anything else in ask mode`;
}

/** Workspace trust (SEC-N1): whether verification and build/test commands may run without a full sandbox. */
function trustCheck(state: WorkspaceTrustState, file: string, report: SandboxReport): DoctorCheck {
  const details = [{ workspace_root: state.root, repo_identity: state.identity, trusted: state.trusted, source: state.source ?? null, reason: state.reason ?? null, trust_file: file }];
  if (report.enforcement === "full") {
    return { id: "trust", status: "ok", summary: `not needed: the full sandbox confines build/test commands (workspace ${state.trusted ? "trusted" : "not trusted"})`, details };
  }
  if (state.trusted) {
    return { id: "trust", status: "ok", summary: `workspace trusted (${state.source ?? "store"}): verification and build/test commands, and code the AI writes, run unconfined with your user permissions and can reach files outside the workspace`, details };
  }
  return {
    id: "trust",
    status: "warn",
    summary: `workspace not trusted (${state.reason ?? "no record"}): verification and build/test commands are refused in autonomous mode and asked for in ask mode; run syn trust`,
    details,
  };
}

async function storeCheck(home: string, projectId: string, workspaceRoot: string): Promise<DoctorCheck> {
  const probe = path.join(home, "tmp", `doctor-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(path.dirname(probe), { recursive: true, mode: 0o700 });
    const handle = await open(probe, "wx", 0o600);
    await handle.writeFile("synorch doctor\n");
    await handle.datasync();
    await handle.close();
    await rm(probe, { force: true });
    const sessions = await createSessionStore(home).list(projectId as never);
    const locked = sessions.filter((session) => session.locked).length;
    // SEC-M3: attempt workspaces a crashed process left behind (never one whose owner is alive).
    const pruned = await pruneOrphanedAttempts({ worktreesRoot: path.join(home, "worktrees"), projectId: projectId as never, workspaceRoot }).catch(() => undefined);
    const orphans = (pruned?.removedWorktrees.length ?? 0) + (pruned?.revertedScoped.length ?? 0);
    const leftInPlace = pruned?.revertedScoped.flatMap((entry) => [...entry.leftInPlace, ...entry.unrestorable]) ?? [];
    return {
      id: "store",
      status: leftInPlace.length > 0 ? "warn" : "ok",
      summary: `${home} is writable with durable flushes; ${sessions.length} session(s) for this project${locked > 0 ? `, ${locked} live` : ""}${orphans > 0 ? `; pruned ${orphans} orphaned attempt workspace(s)` : ""}${leftInPlace.length > 0 ? `; a crashed attempt changed ${leftInPlace.slice(0, 5).join(", ")} outside what could be reverted` : ""}`,
      details: [{ home, sessions: sessions.length, live: locked, ...(pruned === undefined ? {} : { orphans: pruned }) }],
    };
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    return { id: "store", status: "fail", summary: `${home} is not usable: ${error instanceof Error ? error.message : String(error)}`, details: [{ home }] };
  }
}

async function authCheck(home: string, io: DoctorIO, overrides: RuntimeOverrides, signal: AbortSignal): Promise<DoctorCheck> {
  let store: SynorchCredentialStore;
  try {
    store = (overrides.credentialStore ?? ((root, env) => createCredentialStore(root, { env })))(home, io.env);
  } catch (error) {
    return { id: "auth", status: "fail", summary: failureInfo(error).message, details: [] };
  }
  const stored = await store.list();
  const providers = createAuthProviders(store, {
    ...(overrides.authOptions ?? {}),
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    env: io.env,
    state: new ProfileStateStore(home),
    profiles: [...new Set(stored.map((ref) => ref.profile))],
  });
  const statuses: AuthStatus[] = [];
  for (const provider of providers) {
    const isDefault = provider.profile === "default";
    const hasStored = stored.some((ref) => ref.provider_id === provider.providerId && ref.method === provider.method && ref.profile === provider.profile);
    if (isDefault || hasStored) statuses.push(await provider.status(signal));
  }
  const connected = statuses.filter((status) => status.state === "connected");
  return {
    id: "auth",
    status: statuses.some((status) => status.state === "expired" || status.state === "login_required") ? "warn" : connected.length > 0 ? "ok" : "warn",
    summary: `${connected.length} of ${statuses.length} identities connected (credential store ${store.backend})`,
    details: statuses,
  };
}

async function capabilitiesCheck(runtime: Runtime, signal: AbortSignal): Promise<DoctorCheck> {
  const details: unknown[] = [];
  const statuses: CheckStatus[] = [];
  for (const adapter of runtime.adapters) {
    try {
      const capabilities = await adapter.discoverCapabilities(signal);
      const health = adapter.kind === "model" ? await adapter.health(signal) : undefined;
      details.push({ adapter_id: adapter.adapterId, provider_id: adapter.providerId, kind: adapter.kind, capabilities, health });
      statuses.push(capabilities.policy_status === "permitted" ? "ok" : "warn");
    } catch (error) {
      details.push({ adapter_id: adapter.adapterId, error: failureInfo(error).message });
      statuses.push("fail");
    }
  }
  const tiers = ["orchestrator", "complex_worker", "fast_worker"] as const;
  const missing = tiers.filter((tier) => !runtime.config.router.rules.some((rule) => rule.tier === tier));
  if (missing.length > 0) statuses.push("warn");
  // The conversation (ADR-21 decision 4) uses the session tier, else the orchestrator route; a fast model keeps chat responsive.
  const rules = runtime.config.router.rules;
  const fast = rules.find((rule) => rule.tier === "fast_worker");
  const sessionHint = rules.some((rule) => rule.tier === "session")
    ? ""
    : fast === undefined
      ? "; the conversation uses the orchestrator route"
      : `; the conversation uses the orchestrator route (for faster chat: --profile session=${fast.route.provider_id}/${fast.route.model_id} or /model fast_worker --save)`;
  return {
    id: "capabilities",
    status: worst(statuses),
    summary: `${runtime.adapters.length} adapter(s) configured${missing.length > 0 ? `; no route for ${missing.join(", ")}` : "; every tier has a route"}${sessionHint}`,
    details: [...details, ...runtime.config.router.rules.map((rule) => ({ route: rule }))],
  };
}

/**
 * K1.5: which models each provider identity offers right now (ChatGPT subscription, Claude via the
 * bridge, API keys), from auth status and the known lists only: no model request, no listing call.
 */
async function modelsCheck(runtime: Runtime, signal: AbortSignal): Promise<DoctorCheck> {
  try {
    const catalog = await runtime.modelCatalog(signal);
    const groups = new Map<string, { connected: boolean; models: string[]; hint: string | undefined }>();
    for (const row of catalog) {
      const key = `${row.provider} ${row.badge}`;
      const group = groups.get(key) ?? { connected: row.connected, models: [], hint: row.unavailable };
      group.models.push(row.model);
      groups.set(key, group);
    }
    const usable = [...groups.entries()].filter(([, group]) => group.connected);
    const missing = [...groups.entries()].filter(([, group]) => !group.connected).map(([key]) => key);
    const summary =
      usable.length === 0
        ? "no provider is logged in (syn login openai · syn login anthropic --method cli-bridge|api-key)"
        : `${usable.map(([key, group]) => `${key}: ${group.models.slice(0, 4).join(", ")}${group.models.length > 4 ? ` +${group.models.length - 4}` : ""}`).join(" · ")}${missing.length === 0 ? "" : ` · not logged in: ${missing.join(", ")}`}`;
    return {
      id: "models",
      status: usable.length === 0 ? "warn" : "ok",
      summary,
      details: catalog.map((row) => ({ provider: row.provider, model: row.model, adapter_id: row.adapterId, auth: row.badge, connected: row.connected, capability: row.capability, image_input: row.imageInput, source: row.source, ...(row.unavailable === undefined ? {} : { unavailable: row.unavailable }) })),
    };
  } catch (error) {
    return { id: "models", status: "warn", summary: `model catalog unavailable: ${failureInfo(error).message}`, details: [] };
  }
}

async function probeModels(runtime: Runtime, signal: AbortSignal): Promise<DoctorCheck> {
  const details: unknown[] = [];
  const statuses: CheckStatus[] = [];
  const seen = new Set<string>();
  for (const rule of runtime.config.router.rules) {
    const key = `${rule.route.adapter_id}|${rule.route.provider_id}|${rule.route.model_id}|${rule.route.profile ?? "default"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const decision = await runtime.router.resolve({ tier: rule.tier, role: rule.role }, signal);
      const adapter = runtime.router.adapterFor(decision.route);
      if (adapter.kind !== "model") {
        details.push({ route: key, skipped: "agent-backend routes are probed by their first turn" });
        continue;
      }
      const request: ModelRequest = {
        request_id: createId("request"),
        route: decision.route,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] }],
        tools: [],
        max_output_tokens: 16,
      };
      const credential = await runtime.credentials(decision.route, signal);
      let result = "no terminal event";
      for await (const event of adapter.stream(request, credential, signal)) {
        if (event.type === "done") result = `ok (${event.stop_reason})`;
        if (event.type === "error") result = `${event.error.code}: ${event.error.message}`;
      }
      statuses.push(result.startsWith("ok") ? "ok" : "fail");
      details.push({ route: key, result });
    } catch (error) {
      statuses.push("fail");
      details.push({ route: key, error: failureInfo(error).message });
    }
  }
  return { id: "probe-model", status: worst(statuses), summary: `${details.length} route(s) probed with one request each`, details };
}

function renderHuman(report: DoctorReport): string {
  const lines = ["Synorch runtime doctor", `home ${report.home}`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(5)} ${check.id.padEnd(13)} ${check.summary}`);
    if (check.id === "profile") for (const detail of check.details as { lines?: string[] }[]) for (const line of detail.lines ?? []) lines.push(`${" ".repeat(20)}${line}`);
  }
  if (report.network_requests === "none") lines.push("No network request was made (use --probe-model to send one request per route).");
  return `${lines.join("\n")}\n`;
}

export async function doctorRuntime(io: DoctorIO, target: string | undefined, probeModel: boolean, json: boolean, overrides: RuntimeOverrides): Promise<number> {
  const controller = new AbortController();
  const home = overrides.home ?? resolveHome(io.env);
  const workspaceRoot = path.resolve(io.cwd, target ?? ".");
  const checks: DoctorCheck[] = [nodeCheck(), terminalCheck(io)];
  let runtime: Runtime | undefined;
  try {
    runtime = await createRuntime({ workspaceRoot, env: io.env, policyMode: "autonomous", overrides: { ...overrides, home } });
    const files = runtime.config.files.length === 0 ? "no configuration files; defaults apply" : runtime.config.files.map((file) => `${file.layer}: ${file.path}`).join("; ");
    const warnings = runtime.config.warnings;
    checks.push({
      id: "config",
      status: warnings.length === 0 ? "ok" : "warn",
      summary: warnings.length === 0 ? files : `${files}; ${warnings.map((warning) => warning.message).join("; ")}`,
      details: [...runtime.config.files, ...warnings],
    });
    checks.push(canonicalCheck(runtime));
    checks.push(await profileCheck(runtime));
  } catch (error) {
    checks.push({ id: "config", status: "fail", summary: failureInfo(error).message, details: [] });
  }
  const sandbox = runtime?.sandbox ?? overrides.sandbox ?? (await probeSandbox({ platform: io.platform }));
  checks.push(sandboxCheck(sandbox));
  const trustStore = createWorkspaceTrustStore(home, { platform: io.platform });
  checks.push(trustCheck(runtime?.trust.state() ?? trustStore.status(workspaceRoot), trustStore.file, sandbox));
  checks.push(await storeCheck(home, runtime?.projectId ?? deriveProjectId(workspaceRoot, io.platform), workspaceRoot));
  checks.push(await authCheck(home, io, overrides, controller.signal));
  if (runtime !== undefined) checks.push(await capabilitiesCheck(runtime, controller.signal));
  if (runtime !== undefined) checks.push(await modelsCheck(runtime, controller.signal));
  if (probeModel && runtime !== undefined) checks.push(await probeModels(runtime, controller.signal));
  const report: DoctorReport = {
    schema: "synorch.doctor.runtime",
    version: 1,
    ok: !checks.some((check) => check.status === "fail"),
    home,
    network_requests: probeModel ? "probe-model" : "none",
    checks,
  };
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report));
  return report.ok ? EXIT_CODES.success : EXIT_CODES.internal;
}
