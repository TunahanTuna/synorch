import path from "node:path";
import {
  createId,
  deriveProjectId,
  digestOf,
  EVENT_VERSIONS,
  EXIT_CODES,
  WORKSPACE_TRUST_NOTICE,
  type SessionEventDraft,
  type TrustGrantSource,
  type WorkspaceTrustState,
} from "../contracts/index.ts";
import { createWorkspaceTrustStore } from "../policy/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Runtime } from "./runtime.ts";
import type { SessionRenderer } from "./renderers.ts";

/**
 * Workspace trust at the CLI (SEC-N1): `syn trust [--revoke]`, the one-time interactive prompt and
 * the audit trail. Grants and revocations are appended to the project's `syn trust decisions`
 * session; a run that relies on trust records `trust/used` in its own log (coordinator).
 */

/** Title of the per-project session that records trust grants and revocations. */
export const TRUST_AUDIT_TITLE = "syn trust decisions";

type TrustEvent = "trust/granted" | "trust/revoked";

/** Appends a trust decision to the project's audit session (created on first use). */
export async function recordTrustDecision(
  home: string,
  workspaceRoot: string,
  platform: NodeJS.Platform,
  type: TrustEvent,
  state: WorkspaceTrustState,
  source: TrustGrantSource | undefined,
): Promise<void> {
  const sessions = createSessionStore(home);
  const projectId = deriveProjectId(workspaceRoot, platform);
  const existing = (await sessions.list(projectId)).find((summary) => summary.manifest.title === TRUST_AUDIT_TITLE);
  const log = existing
    ? await sessions.openForWrite(existing.manifest.session_id)
    : await sessions.create({ session_id: createId("session"), project_id: projectId, workspace_root: path.resolve(workspaceRoot), created_at: new Date().toISOString(), title: TRUST_AUDIT_TITLE });
  const base = { workspace_root: state.root, repo_identity: state.identity };
  try {
    await log.append({
      type,
      event_version: EVENT_VERSIONS[type],
      actor: { kind: "user" },
      data: type === "trust/granted" ? { ...base, source: source ?? "command" } : base,
    } as SessionEventDraft);
  } finally {
    await log.close();
  }
}

export interface TrustCommandIO {
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** `syn trust [--target <path>] [--revoke]`. */
export async function trustCommand(io: TrustCommandIO, target: string | undefined, revoke: boolean): Promise<number> {
  const workspaceRoot = path.resolve(io.cwd, target ?? ".");
  const store = createWorkspaceTrustStore(io.home, { platform: io.platform });
  const record = async (type: TrustEvent, state: WorkspaceTrustState, source: TrustGrantSource | undefined): Promise<void> => {
    try {
      await recordTrustDecision(io.home, workspaceRoot, io.platform, type, state, source);
    } catch (error) {
      io.stderr(`warning: the trust decision was applied but its audit event could not be recorded: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  if (revoke) {
    const { removed, state } = await store.revoke(workspaceRoot);
    if (removed) await record("trust/revoked", state, undefined);
    io.stdout(removed ? `Revoked trust for ${workspaceRoot}.\n` : `${workspaceRoot} was not trusted; nothing to revoke.\n`);
    return EXIT_CODES.success;
  }
  const state = await store.grant(workspaceRoot, "command");
  await record("trust/granted", state, "command");
  io.stdout(`Trusted ${workspaceRoot} (${state.identity.slice(0, 16)}…) in ${store.file}.\n${WORKSPACE_TRUST_NOTICE}\nRevoke with: syn trust --revoke${target === undefined ? "" : ` --target ${target}`}\n`);
  return EXIT_CODES.success;
}

/**
 * The one-time interactive prompt: when exec is not fully sandboxed, the workspace is untrusted and
 * a human is attached, ask once through the renderer's approval UI. The renderers show the
 * dedicated `WORKSPACE_TRUST_CHOICES` for this subject, "Not now" pre-selected:
 *
 *   rejected           "Not now"                      the workspace stays untrusted
 *   allowed-once       "Trust for this session only"  trusted for this runtime; nothing persisted
 *   allowed-for-scope  "Trust this workspace"         persisted in trust.json and audited
 */
export async function promptWorkspaceTrust(runtime: Runtime, renderer: SessionRenderer, signal: AbortSignal): Promise<void> {
  const state = runtime.trust.state();
  if (state.trusted || runtime.sandbox.enforcement === "full") return;
  if (renderer.kind === "jsonl" || renderer.approvals.availability !== "interactive") return;
  const now = new Date();
  const decision = await renderer.approvals.request(
    {
      approval_id: createId("approval"),
      run_id: createId("run"),
      subject_kind: "workspace-trust",
      subject_digest: digestOf({ root: state.root, identity: state.identity }),
      summary: `Trust ${runtime.workspaceRoot}? ${WORKSPACE_TRUST_NOTICE} Without trust, verification and build/test commands are refused (autonomous) or asked for one by one (ask). "Trust this workspace" is remembered until syn trust --revoke.`,
      scope: "once",
      requested_at: now.toISOString(),
    },
    signal,
  );
  if (decision.decided_by !== "user" || (decision.outcome !== "allowed-once" && decision.outcome !== "allowed-for-scope")) {
    renderer.render({ kind: "notice", level: "warning", message: `workspace not trusted: verification and build/test commands will be ${runtime.policyMode === "ask" ? "asked for" : "refused"} (syn trust grants it later)` });
    return;
  }
  if (decision.outcome === "allowed-once") {
    runtime.trust.grantSession();
    renderer.render({ kind: "notice", level: "warning", message: `trusted ${runtime.workspaceRoot} for this session only (not saved). ${WORKSPACE_TRUST_NOTICE}` });
    return;
  }
  const granted = await runtime.trust.grant("prompt");
  renderer.render({ kind: "notice", level: granted.trusted ? "info" : "warning", message: granted.trusted ? `trusted ${runtime.workspaceRoot} (saved in ${runtime.trust.file}; revoke with syn trust --revoke)` : `trust was not recorded: ${granted.reason ?? "unknown reason"}` });
}
