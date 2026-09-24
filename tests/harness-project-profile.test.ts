import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectProjectProfile, plannerHint, profileHeaderLine, profileMemoryFacts, renderProfileBlock, startProjectProfile } from "../src/harness/cli/project-profile.ts";
import { bootstrapProjectMemory, createMemoryStore } from "../src/harness/memory/index.ts";

/** Zero-config onboarding: the project profile detected from fixture repositories, its cache and `/memory init`. */

async function fixture(files: Readonly<Record<string, string>>): Promise<{ readonly root: string; readonly dispose: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "syn-profile-"));
  const root = path.join(base, "repo");
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(root, { recursive: true });
  return { root, dispose: () => rm(base, { recursive: true, force: true }) };
}

const pkg = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, version: "1.0.0", ...extra });

test("pnpm workspace: package manager, packages, scripts and test framework", async () => {
  const repo = await fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, packageManager: "pnpm@9.0.0", scripts: { test: "vitest run", build: "turbo build", lint: "eslint .", typecheck: "tsc -b" }, devDependencies: { typescript: "5", vitest: "2" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
    "turbo.json": "{}",
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }',
    "eslint.config.js": "export default [];\n",
    "packages/core/package.json": pkg("@mono/core"),
    "packages/ui/package.json": pkg("@mono/ui", { dependencies: { react: "19" } }),
    "apps/web/package.json": pkg("@mono/web", { dependencies: { next: "16" } }),
    "apps/api/package.json": pkg("@mono/api", { dependencies: { fastify: "5" } }),
  });
  try {
    const profile = await detectProjectProfile(repo.root);
    assert.equal(profile.packageManager, "pnpm");
    assert.equal(profile.workspace?.kind, "pnpm workspaces + turbo");
    assert.deepEqual(profile.workspace?.packages.map((item) => item.name).sort(), ["@mono/api", "@mono/core", "@mono/ui", "@mono/web"]);
    assert.equal(profile.commands.test?.command, "pnpm test");
    assert.equal(profile.commands.typecheck?.command, "pnpm typecheck");
    assert.ok(profile.languages.includes("typescript"));
    assert.ok(profile.frameworks.includes("nextjs") && profile.frameworks.includes("react"));
    assert.deepEqual(profile.testFrameworks, ["vitest"]);
    assert.ok(profile.conventions.includes("ESLint") && profile.conventions.includes("TypeScript strict mode"));
    assert.equal(profileHeaderLine(profile), "Synorch ready · Node/TS · pnpm workspaces + turbo (4 packages) · tests: pnpm test");
    assert.match(renderProfileBlock(profile), /Use pnpm for installing and running scripts/);
    assert.match(plannerHint(profile) ?? "", /pnpm test · pnpm typecheck · pnpm lint · pnpm build/);
  } finally {
    await repo.dispose();
  }
});

test("maven multi-module: modules, wrapper commands and junit", async () => {
  const module = (artifact: string): string => `<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId></parent><artifactId>${artifact}</artifactId><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`;
  const repo = await fixture({
    "pom.xml": "<project><groupId>com.acme</groupId><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>api</module><module>service</module></modules></project>",
    mvnw: "#!/bin/sh\n",
    "api/pom.xml": module("acme-api"),
    "service/pom.xml": module("acme-service"),
  });
  try {
    const profile = await detectProjectProfile(repo.root);
    assert.equal(profile.packageManager, "maven");
    assert.equal(profile.workspace?.kind, "maven modules");
    assert.deepEqual(profile.workspace?.packages.map((item) => item.name), ["acme-api", "acme-service"]);
    assert.equal(profile.commands.test?.command, "./mvnw test");
    assert.equal(profile.commands.build?.command, "./mvnw verify");
    assert.ok(profile.languages.includes("java"));
    assert.deepEqual(profile.testFrameworks, ["junit5"]);
  } finally {
    await repo.dispose();
  }
});

test("python uv: uv runner for pytest, ruff and mypy", async () => {
  const repo = await fixture({
    "pyproject.toml": '[project]\nname = "svc"\ndependencies = ["fastapi"]\n\n[dependency-groups]\ndev = ["pytest", "ruff", "mypy"]\n\n[tool.ruff]\nline-length = 100\n',
    "uv.lock": "version = 1\n",
    "src/svc/__init__.py": "",
    ".venv/lib/site.py": "",
  });
  try {
    const profile = await detectProjectProfile(repo.root);
    assert.equal(profile.packageManager, "uv");
    assert.deepEqual(profile.languages, ["python"]);
    assert.ok(profile.frameworks.includes("fastapi"));
    assert.equal(profile.commands.test?.command, "uv run pytest");
    assert.equal(profile.commands.lint?.command, "uv run ruff check .");
    assert.equal(profile.commands.typecheck?.command, "uv run mypy .");
    assert.equal(profile.workspace, null);
    assert.equal(profileHeaderLine(profile), "Synorch ready · Python · uv · tests: uv run pytest");
  } finally {
    await repo.dispose();
  }
});

test("the cached profile is reused until a key file changes", async () => {
  const repo = await fixture({ "package.json": pkg("app", { scripts: { test: "node --test" } }), "package-lock.json": "{}" });
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-profile-home-"));
  try {
    const first = await startProjectProfile(home, "app-1", repo.root).ready;
    assert.equal(first?.commands.test?.command, "npm test");
    const second = await startProjectProfile(home, "app-1", repo.root).ready;
    assert.equal(second?.computed_at, first?.computed_at, "unchanged key files reuse the cache");
    await writeFile(path.join(repo.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await rm(path.join(repo.root, "package-lock.json"));
    const third = await startProjectProfile(home, "app-1", repo.root).ready;
    assert.equal(third?.packageManager, "pnpm", "a lockfile change triggers a new detection");
  } finally {
    await repo.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test("/memory init writes concept and evidence notes, proposes decisions once and keeps user edits", async () => {
  const repo = await fixture({ "package.json": JSON.stringify({ name: "app", scripts: { test: "jest" }, devDependencies: { jest: "29" } }), "yarn.lock": "" });
  const home = await mkdtemp(path.join(os.tmpdir(), "syn-profile-home-"));
  try {
    const profile = await detectProjectProfile(repo.root);
    const store = createMemoryStore(path.join(home, "memory"), { workspaceRoot: repo.root });
    const options = { projectId: "app-12345678", workspaceRoot: repo.root, markerFile: path.join(home, "projects", "app", "memory-bootstrap.json") };
    const first = await bootstrapProjectMemory(store, profileMemoryFacts(profile), options);
    assert.ok(first.written.includes("cpt-project-stack") && first.written.includes("cpt-project-commands"));
    assert.ok(first.written.includes("evd-manifest-package-json"));
    assert.deepEqual([...first.proposed].sort(), ["dec-package-manager-yarn", "dec-test-framework-jest", "prf-verify-with-yarn-test"]);
    assert.equal((await store.pending()).length, 3);

    const stack = await store.get("cpt-project-stack" as never);
    assert.ok(stack !== undefined);
    await store.correct(stack.frontmatter.id, { body: "My own words." }, stack.digest);
    const second = await bootstrapProjectMemory(store, profileMemoryFacts(profile), options);
    assert.deepEqual(second.proposed, [], "a fact is proposed once");
    assert.deepEqual(second.kept, ["cpt-project-stack"], "a note the user edited is never overwritten");
    assert.equal((await store.pending()).length, 3);
  } finally {
    await repo.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
