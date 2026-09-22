import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHarnessCommand } from "../src/harness/cli/index.ts";
import type { FetchLike } from "../src/harness/providers/index.ts";
import { capture, createSandbox, overridesFor } from "./fixtures/cli/runtime/support.ts";

/**
 * I5 AC-6: `syn doctor --runtime --json` reports sandbox enforcement, store health, auth state and
 * capabilities as separate results and sends no network request, proven with a recording fetch that
 * every HTTP adapter and auth provider of the runtime receives. `--probe-model` is the only path
 * that sends a request.
 */

interface Recorded {
  readonly fetch: FetchLike;
  readonly urls: string[];
}

function recordingFetch(): Recorded {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "offline test server" } }), { status: 500, headers: { "content-type": "application/json" } });
    },
  };
}

const CONFIG = [
  "routes:",
  "  - { tier: orchestrator, provider: openai, model: gpt-test, adapter: openai-chatgpt }",
  "  - { tier: complex_worker, provider: anthropic, model: claude-test }",
  "  - { tier: fast_worker, provider: openai, model: gpt-test-mini, adapter: openai-responses }",
  "",
].join("\n");

interface Report {
  readonly ok: boolean;
  readonly network_requests: string;
  readonly checks: readonly { readonly id: string; readonly status: string; readonly summary: string; readonly details: readonly unknown[] }[];
}

test("doctor --runtime --json reports each area separately and makes no network request (AC-6)", async () => {
  const sandbox = await createSandbox({ "README.md": "# doctor\n" });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), CONFIG);
    const network = recordingFetch();
    const probes: string[] = [];
    const overrides = overridesFor(sandbox, {
      fetch: network.fetch,
      authOptions: {
        claudeProbe: async () => {
          probes.push("claude --version");
          return { installed: false, version: undefined };
        },
      },
    });
    const doctor = capture({ cwd: sandbox.workspace, env: { OPENAI_API_KEY: "sk-test-doctor-0123456789abcdef" } });
    const code = await runHarnessCommand(["doctor", "--runtime", "--json"], doctor.io, overrides);
    assert.equal(code, 0, doctor.stderr());
    const report = JSON.parse(doctor.stdout()) as Report;
    assert.deepEqual(network.urls, [], "doctor --runtime must not send any request");
    assert.equal(report.network_requests, "none");
    assert.deepEqual(report.checks.map((check) => check.id), ["node", "terminal", "config", "canonical", "sandbox", "trust", "store", "auth", "capabilities"]);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    assert.equal(byId.get("trust")?.status, "warn", "an untrusted workspace on a partial sandbox is reported (SEC-N1)");
    assert.match(byId.get("trust")?.summary ?? "", /not trusted.*syn trust/);
    const canonical = byId.get("canonical");
    assert.equal(canonical?.status, "warn", "a repository without .ai/ runs on the built-in defaults, and doctor says so");
    assert.match(canonical?.summary ?? "", /canonical \.ai: none in .*; using the built-in Synorch defaults \(constitution loaded, 8 core protocol\(s\), 5 role manifest\(s\), 9 skill\(s\)/);
    assert.equal(byId.get("sandbox")?.status, "warn", "a partial sandbox is reported, not hidden");
    assert.equal(byId.get("store")?.status, "ok");
    const auth = byId.get("auth")?.details as { provider_id: string; method: string; state: string }[];
    assert.deepEqual(
      auth.map((status) => `${status.provider_id}/${status.method}:${status.state}`),
      ["openai/oauth-subscription:disconnected", "openai/api-key:connected", "anthropic/api-key:disconnected", "anthropic/cli-bridge:disconnected"],
    );
    assert.doesNotMatch(doctor.stdout(), /sk-test-doctor/, "no secret in the report");
    const capabilities = byId.get("capabilities")?.details as { adapter_id?: string; health?: { state: string } }[];
    assert.deepEqual(
      capabilities.flatMap((entry) => (entry.adapter_id === undefined ? [] : [entry.adapter_id])).sort(),
      ["anthropic-messages", "openai-chatgpt", "openai-responses"],
    );
    assert.ok(capabilities.every((entry) => entry.adapter_id === undefined || entry.health?.state === "unknown"), "health is static, never a paid probe");

    const human = capture({ cwd: sandbox.workspace });
    assert.equal(await runHarnessCommand(["doctor", "--runtime"], human.io, overrides), 0);
    assert.match(human.stdout(), /^WARN  sandbox/m);
    assert.match(human.stdout(), /^WARN  canonical\s+canonical \.ai: none in/m);
    assert.match(human.stdout(), /No network request was made/);
    assert.deepEqual(network.urls, []);

    const probe = capture({ cwd: sandbox.workspace, env: { OPENAI_API_KEY: "sk-test-doctor-0123456789abcdef" } });
    const probed = await runHarnessCommand(["doctor", "--runtime", "--probe-model", "--json"], probe.io, overrides);
    const probeReport = JSON.parse(probe.stdout()) as Report;
    assert.equal(probeReport.network_requests, "probe-model");
    assert.deepEqual(network.urls, ["https://api.openai.com/v1/responses"], "only the route with a usable credential is probed, once");
    assert.equal(probeReport.checks.at(-1)?.id, "probe-model");
    assert.equal(probeReport.checks.at(-1)?.status, "fail");
    assert.equal(probed, 1);
  } finally {
    await sandbox.cleanup();
  }
});

test("doctor --runtime reports an invalid configuration as a failed check instead of crashing", async () => {
  const sandbox = await createSandbox({ "README.md": "# doctor\n" });
  try {
    await writeFile(path.join(sandbox.home, "config.yaml"), "routes:\n  - { tier: boss, provider: openai, model: x }\n");
    const doctor = capture({ cwd: sandbox.workspace });
    const code = await runHarnessCommand(["doctor", "--runtime", "--json"], doctor.io, overridesFor(sandbox, { authOptions: { claudeProbe: async () => ({ installed: false, version: undefined }) } }));
    assert.equal(code, 1);
    const report = JSON.parse(doctor.stdout()) as Report;
    const config = report.checks.find((check) => check.id === "config");
    assert.equal(config?.status, "fail");
    assert.ok(report.checks.some((check) => check.id === "sandbox") && report.checks.some((check) => check.id === "store"));
  } finally {
    await sandbox.cleanup();
  }
});
