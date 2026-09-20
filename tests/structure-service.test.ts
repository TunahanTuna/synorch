import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DoctorService } from "../src/application/doctor-service.ts";
import { ProjectDiscoveryService } from "../src/application/project-discovery.ts";
import { StructureService } from "../src/application/structure-service.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "test cleanup must stay inside OS temp");
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

test("empty directory defaults to workspace scope and includes both model profiles", async () => {
  const directory = await createTempDirectory();
  const service = new StructureService(new NodeFileSystem());

  const plan = await service.createPlan(directory);

  assert.equal(plan.scope, "workspace");
  assert.ok(plan.files.every((file) => file.status === "create"));
  assert.ok(plan.files.some((file) => file.relativePath === ".ai/model-profiles/openai.yaml"));
  assert.ok(plan.files.some((file) => file.relativePath === ".ai/model-profiles/claude.yaml"));
  const agents = plan.files.find((file) => file.relativePath === "AGENTS.md");
  assert.match(agents?.content ?? "", /Mandatory session bootstrap/);
});

test("a directory with package.json defaults to repository scope", async () => {
  const directory = await createTempDirectory();
  await writeFile(path.join(directory, "package.json"), "{}", "utf8");

  const plan = await new StructureService(new NodeFileSystem()).createPlan(directory);

  assert.equal(plan.scope, "repository");
});

test("init is idempotent and doctor accepts the generated structure", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const service = new StructureService(fileSystem);

  await service.initialize(await service.createPlan(directory, "workspace"));
  const secondPlan = await service.createPlan(directory, "workspace");
  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(secondPlan.files.every((file) => file.status === "unchanged"));
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["healthy"],
  );
});

test("sync discovers verified Node project facts", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.19.0",
      scripts: { test: "node --test", build: "tsc" },
      dependencies: { fastify: "5.0.0" },
      devDependencies: { typescript: "5.9.3" },
    }),
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);

  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.ok(project);
  assert.deepEqual(project.stack.languages, ["javascript", "typescript"]);
  assert.deepEqual(project.stack.frameworks, ["fastify"]);
  assert.equal(project.stack.package_manager, "pnpm");
  assert.equal(project.commands["test"]?.value, "pnpm test");

  const record = await readFile(path.join(directory, `.ai/projects/${project.id}.yaml`), "utf8");
  assert.match(record, /confidence: verified/);
});

test("existing different entrypoint is reported as a conflict", async () => {
  const directory = await createTempDirectory();
  await writeFile(path.join(directory, "AGENTS.md"), "user-owned instructions\n", "utf8");

  const plan = await new StructureService(new NodeFileSystem()).createPlan(directory, "workspace");

  const agents = plan.files.find((file) => file.relativePath === "AGENTS.md");
  assert.equal(agents?.status, "conflict");
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-structure-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
