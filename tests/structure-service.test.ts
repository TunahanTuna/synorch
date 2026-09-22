import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { DoctorService } from "../src/application/doctor-service.ts";
import { ProjectDiscoveryService } from "../src/application/project-discovery.ts";
import { StructureService } from "../src/application/structure-service.ts";
import { manifestSchema, skillRegistrySchema } from "../src/domain/config.ts";
import { CliError } from "../src/domain/errors.ts";
import { OBSERVATION_LEDGER_PATH } from "../src/domain/observation-ledger.ts";
import { BASE_SKILLS } from "../src/domain/skill-packs.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";
import { createStructureFiles } from "../src/templates/structure-templates.ts";
import { parseYaml } from "../src/infrastructure/serialization.ts";

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

test("the generated structure declares every path exactly once", () => {
  for (const scope of ["workspace", "repository"] as const) {
    const files = createStructureFiles(scope);
    const seen = new Map<string, number>();
    for (const file of files) {
      seen.set(file.relativePath, (seen.get(file.relativePath) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([relativePath]) => relativePath);

    assert.deepEqual(duplicates, [], `${scope} scope emits a path twice`);
  }

  const repository = createStructureFiles("repository");
  for (const skill of BASE_SKILLS) {
    assert.equal(
      repository.filter((file) => file.relativePath === skill.relativePath).length,
      1,
      skill.id,
    );
  }
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
  assert.match(agents?.content ?? "", /skill_registry/);
  assert.match(agents?.content ?? "", /Do not scan or load the whole catalog/);
  assert.match(agents?.content ?? "", /Headed browser verification is opt-in/);
  const claude = plan.files.find((file) => file.relativePath === "CLAUDE.md");
  assert.match(claude?.content ?? "", /skill_registry/);
  assert.ok(
    plan.files.some((file) => file.relativePath === ".ai/skills/task-conductor/SKILL.md"),
  );
  const manifest = plan.files.find((file) => file.relativePath === ".ai/manifest.yaml");
  const parsedManifest = manifestSchema.parse(parseYaml(manifest?.content ?? ""));
  assert.equal(parsedManifest.generator.name, "synorch");
});

test("a directory with package.json defaults to repository scope", async () => {
  const directory = await createTempDirectory();
  await writeFile(path.join(directory, "package.json"), "{}", "utf8");

  const plan = await new StructureService(new NodeFileSystem()).createPlan(directory);

  assert.equal(plan.scope, "repository");
});

test("Gradle build files default to repository scope", async () => {
  for (const marker of ["build.gradle", "build.gradle.kts"]) {
    const directory = await createTempDirectory();
    await writeFile(path.join(directory, marker), "", "utf8");
    const plan = await new StructureService(new NodeFileSystem()).createPlan(directory);
    assert.equal(plan.scope, "repository", marker);
  }
});

test("init is idempotent and doctor accepts the generated structure", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const service = new StructureService(fileSystem);

  await service.initialize(await service.createPlan(directory, "workspace"));
  const secondPlan = await service.createPlan(directory, "workspace");
  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(
    secondPlan.files.every(
      (file) => file.status === "unchanged" || file.status === "preserved",
    ),
    secondPlan.files
      .filter((file) => file.status !== "unchanged" && file.status !== "preserved")
      .map((file) => `${file.status} ${file.relativePath}`)
      .join(", "),
  );
  assert.deepEqual(
    secondPlan.files.filter((file) => file.status === "preserved").map((file) => file.relativePath),
    [OBSERVATION_LEDGER_PATH],
  );
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
  assert.equal(project.stack.build_tool, null);
  assert.equal(project.commands["test"]?.value, "pnpm test");
  assert.equal(project.commands["test"]?.cwd, ".");
  assert.deepEqual(project.modules.map((module) => module.path), ["."]);
  assert.deepEqual(project.manifests, ["package.json"]);

  const record = await readFile(path.join(directory, `.ai/projects/${project.id}.yaml`), "utf8");
  assert.match(record, /confidence: verified/);
});

test("repository sync recursively discovers deterministic frontend and backend modules", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await mkdir(path.join(directory, "frontend"), { recursive: true });
  await mkdir(path.join(directory, "backend"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "ignored"), { recursive: true });
  await mkdir(path.join(directory, "backend", "target", "ignored"), { recursive: true });

  await writeFile(
    path.join(directory, "frontend", "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.19.0",
      scripts: { test: "vitest", build: "vite build" },
      dependencies: { react: "19.0.0" },
      devDependencies: { typescript: "5.9.3" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "backend", "pom.xml"),
    `<project>
      <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
      </parent>
      <dependencies>
        <dependency>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-data-jpa</artifactId>
        </dependency>
      </dependencies>
    </project>`,
    "utf8",
  );
  await writeFile(path.join(directory, "backend", "mvnw"), "", "utf8");
  await writeFile(path.join(directory, "node_modules", "ignored", "package.json"), "{}", "utf8");
  await writeFile(path.join(directory, "backend", "target", "ignored", "pom.xml"), "<project/>", "utf8");

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);

  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.ok(project);
  assert.deepEqual(project.modules.map((module) => module.path), ["backend", "frontend"]);
  assert.deepEqual(project.stack.languages, ["java", "javascript", "typescript"]);
  assert.deepEqual(project.stack.frameworks, ["jpa", "react", "spring-boot"]);
  assert.equal(project.stack.package_manager, "pnpm");
  assert.equal(project.stack.build_tool, "maven");
  assert.equal(project.commands["backend:test"]?.cwd, "backend");
  assert.equal(project.commands["frontend:test"]?.cwd, "frontend");
  assert.deepEqual(Object.keys(project.commands), [
    "backend:build",
    "backend:test",
    "frontend:build",
    "frontend:test",
  ]);

  const backend = project.modules[0];
  const frontend = project.modules[1];
  assert.ok(backend);
  assert.ok(frontend);
  assert.deepEqual(backend.manifests, ["backend/pom.xml"]);
  assert.equal(backend.stack.build_tool, "maven");
  assert.equal(backend.commands["test"]?.value, "./mvnw test");
  assert.equal(backend.commands["test"]?.cwd, "backend");
  assert.deepEqual(frontend.manifests, ["frontend/package.json"]);
  assert.equal(frontend.stack.package_manager, "pnpm");
  assert.equal(frontend.commands["test"]?.cwd, "frontend");
  assert.ok(
    project.modules.every((module) =>
      module.evidence.every((item) => item.confidence === "verified"),
    ),
  );
  assert.deepEqual(
    backend.evidence,
    [...backend.evidence].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.kind.localeCompare(right.kind) ||
      left.value.localeCompare(right.value),
    ),
  );

  const registryPath = path.join(directory, project.skill_registry);
  const firstRegistryContent = await readFile(registryPath, "utf8");
  const recordPath = path.join(directory, `.ai/projects/${project.id}.yaml`);
  const firstRecordContent = await readFile(recordPath, "utf8");
  const registry = skillRegistrySchema.parse(parseYaml(firstRegistryContent));
  assert.equal(registry.base_skills.length, BASE_SKILLS.length);
  assert.ok(registry.base_skills.some((skill) => skill.id === "task-conductor"));
  assert.deepEqual(
    registry.technology_skills.map((skill) => skill.id),
    [
      "typescript-patterns",
      "react-patterns",
      "react-modern",
      "frontend-craft",
      "java-patterns",
      "java-backend",
      "spring-boot-patterns",
      "jpa-patterns",
      "db-schema-craft",
      "query-tuning",
      "maven-build",
    ],
  );
  assert.deepEqual(
    registry.selected_packs.map((pack) => pack.id),
    ["typescript", "react", "java", "spring-boot", "jpa", "maven"],
  );
  assert.ok(
    registry.selected_packs.every((pack) =>
      pack.matched_evidence.every((evidence) => evidence.fact.confidence === "verified"),
    ),
  );
  for (const skill of registry.technology_skills) {
    assert.match(
      await readFile(path.join(directory, skill.relative_path), "utf8"),
      new RegExp("name: " + skill.id),
    );
  }
  for (const skill of registry.base_skills) {
    assert.equal(await fileSystem.exists(path.join(directory, skill.relative_path)), true);
  }
  const catalog = parseYaml(
    await readFile(path.join(directory, ".ai", "skills", "catalog.yaml"), "utf8"),
  ) as {
    readonly skills: ReadonlyArray<Record<string, unknown>>;
    readonly sources: readonly unknown[];
  };
  assert.equal(catalog.skills.length, 32);
  assert.ok(catalog.skills.every((skill) => skill["loaded_by_default"] === false));
  assert.ok(!catalog.skills.some((skill) => skill["id"] === "task-conductor"));
  assert.equal(catalog.sources.length, 4);
  assert.equal(
    await fileSystem.exists(
      path.join(directory, ".ai", "skills", "library", "ingenium", "node-backend", "reference.md"),
    ),
    true,
  );

  await delay(10);
  const secondResult = await new ProjectDiscoveryService(fileSystem).sync(directory);
  assert.equal(await readFile(registryPath, "utf8"), firstRegistryContent);
  assert.equal(await readFile(recordPath, "utf8"), firstRecordContent);
  assert.equal(secondResult.projects[0]?.detected_at, project.detected_at);
  assert.deepEqual(secondResult.writtenFiles, []);
});

test("existing different entrypoint is reported as a conflict", async () => {
  const directory = await createTempDirectory();
  await writeFile(path.join(directory, "AGENTS.md"), "user-owned instructions\n", "utf8");

  const plan = await new StructureService(new NodeFileSystem()).createPlan(directory, "workspace");

  const agents = plan.files.find((file) => file.relativePath === "AGENTS.md");
  assert.equal(agents?.status, "conflict");
});

test("repository sync recognizes the Gradle Kotlin Java plugin", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await mkdir(path.join(directory, "service"), { recursive: true });
  await writeFile(
    path.join(directory, "service", "build.gradle.kts"),
    "plugins {\n  java\n}\n",
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const service = result.projects[0]?.modules[0];

  assert.ok(service);
  assert.deepEqual(service.stack.languages, ["java"]);
  assert.equal(service.stack.build_tool, "gradle");
});

test("sync protects customized technology skills unless force is explicit", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11", dependencies: { react: "19" } }),
    "utf8",
  );
  const discovery = new ProjectDiscoveryService(fileSystem);
  const first = await discovery.sync(directory);
  const project = first.projects[0];
  assert.ok(project);
  const recordPath = path.join(directory, `.ai/projects/${project.id}.yaml`);
  const recordBeforeConflict = await readFile(recordPath, "utf8");
  const skillPath = path.join(
    directory,
    ".ai",
    "skills",
    "technology",
    "react-patterns",
    "SKILL.md",
  );
  await writeFile(skillPath, "user-owned customization\n", "utf8");

  await assert.rejects(
    discovery.sync(directory),
    (error: unknown) => error instanceof CliError && /generated skill file differs/i.test(error.message),
  );
  assert.equal(await readFile(skillPath, "utf8"), "user-owned customization\n");
  assert.equal(await readFile(recordPath, "utf8"), recordBeforeConflict);

  await discovery.sync(directory, { force: true });
  assert.match(await readFile(skillPath, "utf8"), /name: react-patterns/);
  const unchanged = await discovery.sync(directory);
  assert.deepEqual(unchanged.writtenFiles, []);
});

test("commented and near-match Java coordinates do not create framework evidence", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await mkdir(path.join(directory, "gradle-fake"), { recursive: true });
  await mkdir(path.join(directory, "maven-fake"), { recursive: true });
  await writeFile(
    path.join(directory, "gradle-fake", "build.gradle.kts"),
    `/* id("org.springframework.boot")
implementation("org.springframework.boot:spring-boot-starter-data-jpa:1") */
plugins { id("org.springframework.boot.fake") }
dependencies { implementation("example.org:spring-boot-starter-data-jpa:1") }
`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "maven-fake", "pom.xml"),
    `<project><!-- <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency> --><dependencies><dependency><groupId>example.org</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></dependencies></project>`,
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const gradle = result.projects[0]?.modules.find((module) => module.path === "gradle-fake");
  const maven = result.projects[0]?.modules.find((module) => module.path === "maven-fake");
  assert.ok(gradle);
  assert.ok(maven);
  assert.deepEqual(gradle.stack.languages, []);
  assert.deepEqual(gradle.stack.frameworks, []);
  assert.deepEqual(maven.stack.frameworks, []);
  assert.equal(
    result.projects[0]?.evidence.some(
      (item) => item.kind === "dependency" && item.value.startsWith("org.springframework.boot:"),
    ),
    false,
  );
});

test("package, lockfile and tsconfig merge into one module without guessing commands", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await mkdir(path.join(directory, "app"), { recursive: true });
  await mkdir(path.join(directory, "raw"), { recursive: true });
  await writeFile(
    path.join(directory, "app", "package.json"),
    JSON.stringify({ scripts: { test: "vitest" }, dependencies: { react: "19" } }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "app", "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
    "utf8",
  );
  await writeFile(path.join(directory, "app", "tsconfig.json"), "{}\n", "utf8");
  await writeFile(
    path.join(directory, "raw", "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const project = result.projects[0];
  assert.ok(project);
  assert.deepEqual(project.modules.map((module) => module.path), ["app", "raw"]);
  const app = project.modules[0];
  const raw = project.modules[1];
  assert.ok(app);
  assert.ok(raw);
  assert.deepEqual(app.manifests, [
    "app/package.json",
    "app/pnpm-lock.yaml",
    "app/tsconfig.json",
  ]);
  assert.equal(app.stack.package_manager, "pnpm");
  assert.deepEqual(app.stack.languages, ["javascript", "typescript"]);
  assert.equal(app.commands["test"]?.value, "pnpm test");
  assert.equal(app.commands["test"]?.cwd, "app");
  assert.deepEqual(raw.commands, {});
});

test("sync rejects lossy project id collisions before writing records", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "workspace"));
  for (const name of ["api-v1", "api.v1"]) {
    await mkdir(path.join(directory, name), { recursive: true });
    await writeFile(path.join(directory, name, "package.json"), "{}", "utf8");
  }

  await assert.rejects(
    new ProjectDiscoveryService(fileSystem).sync(directory),
    (error: unknown) => error instanceof CliError && /project id collision/i.test(error.message),
  );
  assert.equal(
    await fileSystem.exists(path.join(directory, ".ai", "projects", "api-v1.yaml")),
    false,
  );
});

test("sync fails explicitly instead of writing a depth-truncated snapshot", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11" }),
    "utf8",
  );
  let nested = directory;
  for (let depth = 0; depth < 7; depth += 1) {
    nested = path.join(nested, `level-${depth}`);
    await mkdir(nested);
  }
  await writeFile(path.join(nested, "package.json"), "{}", "utf8");

  await assert.rejects(
    new ProjectDiscoveryService(fileSystem).sync(directory),
    (error: unknown) => error instanceof CliError && /maximum depth/i.test(error.message),
  );
  const projectId = path.basename(directory).toLowerCase();
  assert.equal(
    await fileSystem.exists(path.join(directory, ".ai", "projects", `${projectId}.yaml`)),
    false,
  );
});

test("sync fails explicitly instead of writing a directory-limit-truncated snapshot", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11" }),
    "utf8",
  );
  await Promise.all(
    Array.from({ length: 2_000 }, async (_, index) =>
      mkdir(path.join(directory, `directory-${index}`)),
    ),
  );

  await assert.rejects(
    new ProjectDiscoveryService(fileSystem).sync(directory),
    (error: unknown) => error instanceof CliError && /directory safety limit/i.test(error.message),
  );
  const projectId = path.basename(directory).toLowerCase();
  assert.equal(
    await fileSystem.exists(path.join(directory, ".ai", "projects", `${projectId}.yaml`)),
    false,
  );
});

test("sync does not materialize technology skills for an unrelated stack", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(path.join(directory, "go.mod"), "module example.com/service\n\ngo 1.25\n", "utf8");

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const project = result.projects[0];
  assert.ok(project);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(path.join(directory, project.skill_registry), "utf8")),
  );

  assert.equal(registry.base_skills.length, BASE_SKILLS.length);
  assert.deepEqual(registry.technology_skills, []);
  assert.deepEqual(registry.selected_packs, []);
  assert.equal(
    result.writtenFiles.some((file) => file.startsWith(".ai/skills/technology/")),
    false,
  );
});

test("sync prunes a realistic Spring source tree without truncating module discovery", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(path.join(directory, "pom.xml"), "<project/>", "utf8");
  await mkdir(
    path.join(directory, "src", "main", "java", "com", "example", "demo", "domain", "model"),
    { recursive: true },
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  assert.deepEqual(result.projects[0]?.modules.map((module) => module.path), ["."]);
});

test("sync discovers a real nested module inside a source tree", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(path.join(directory, "pom.xml"), "<project/>", "utf8");
  const nestedModule = path.join(directory, "src", "apps", "frontend");
  await mkdir(nestedModule, { recursive: true });
  await writeFile(
    path.join(nestedModule, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11", dependencies: { react: "19" } }),
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  assert.deepEqual(
    result.projects[0]?.modules.map((module) => module.path),
    [".", "src/apps/frontend"],
  );
});

test("Maven management-only coordinates are not active framework evidence", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await mkdir(path.join(directory, "active"), { recursive: true });
  await mkdir(path.join(directory, "managed"), { recursive: true });
  const coordinate = `<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>`;
  await writeFile(
    path.join(directory, "managed", "pom.xml"),
    `<project><dependencyManagement><dependencies>${coordinate}</dependencies></dependencyManagement><build><pluginManagement><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></pluginManagement></build></project>`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "active", "pom.xml"),
    `<project><dependencies>${coordinate}</dependencies></project>`,
    "utf8",
  );

  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const managed = result.projects[0]?.modules.find((module) => module.path === "managed");
  const active = result.projects[0]?.modules.find((module) => module.path === "active");
  assert.ok(managed);
  assert.ok(active);
  assert.deepEqual(managed.stack.frameworks, []);
  assert.equal(managed.evidence.some((item) => item.kind === "dependency"), false);
  assert.deepEqual(active.stack.frameworks, ["jpa", "spring-boot"]);
});

test("sync rejects a technology skill path that escapes through a symlink or junction", async () => {
  const directory = await createTempDirectory();
  const outside = await createTempDirectory();
  const setupFileSystem = new NodeFileSystem();
  const structure = new StructureService(setupFileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11", dependencies: { react: "19" } }),
    "utf8",
  );
  const technologyPath = path.join(directory, ".ai", "skills", "technology");
  let fileSystem: NodeFileSystem = setupFileSystem;
  try {
    await symlink(outside, technologyPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    if (!isLinkCapabilityError(error)) throw error;
    fileSystem = new RejectTechnologyPathFileSystem();
  }

  await assert.rejects(
    new ProjectDiscoveryService(fileSystem).sync(directory),
    (error: unknown) => error instanceof CliError && /unsafe generated path/i.test(error.message),
  );
  assert.equal(
    await setupFileSystem.exists(path.join(outside, "react-patterns", "SKILL.md")),
    false,
  );
});

test("init rejects a Synorch structure path that escapes through a symlink before any mutation", async () => {
  const directory = await createTempDirectory();
  const outside = await createTempDirectory();
  const setupFileSystem = new NodeFileSystem();
  const plan = await new StructureService(setupFileSystem).createPlan(directory, "workspace");
  const aiPath = path.join(directory, ".ai");
  let fileSystem: NodeFileSystem = setupFileSystem;
  try {
    await symlink(outside, aiPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    if (!isLinkCapabilityError(error)) throw error;
    fileSystem = new RejectInitPathFileSystem();
  }

  await assert.rejects(
    new StructureService(fileSystem).initialize(plan),
    (error: unknown) => error instanceof CliError && /unsafe initialization path/i.test(error.message),
  );
  assert.equal(await setupFileSystem.exists(path.join(directory, "AGENTS.md")), false);
  assert.equal(await setupFileSystem.exists(path.join(outside, "manifest.yaml")), false);
});

test("skill registry is written last and remains unchanged after a prerequisite write failure", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  const packagePath = path.join(directory, "package.json");
  await writeFile(
    packagePath,
    JSON.stringify({ packageManager: "pnpm@11", dependencies: { react: "19" } }),
    "utf8",
  );
  const discovery = new ProjectDiscoveryService(fileSystem);
  const first = await discovery.sync(directory);
  const project = first.projects[0];
  assert.ok(project);
  const recordRelativePath = `.ai/projects/${project.id}.yaml`;
  assert.ok(
    first.writtenFiles.indexOf(recordRelativePath) <
      first.writtenFiles.indexOf(".ai/workspace.yaml"),
  );
  assert.ok(
    first.writtenFiles.indexOf(".ai/workspace.yaml") <
      first.writtenFiles.indexOf(project.skill_registry),
  );
  const registryPath = path.join(directory, project.skill_registry);
  const registryBeforeFailure = await readFile(registryPath, "utf8");

  await writeFile(
    packagePath,
    JSON.stringify({
      packageManager: "pnpm@11",
      dependencies: { react: "19" },
      devDependencies: { typescript: "5" },
    }),
    "utf8",
  );
  const failingFileSystem = new FailingWriteFileSystem(path.join(directory, recordRelativePath));
  await assert.rejects(
    new ProjectDiscoveryService(failingFileSystem).sync(directory),
    /injected prerequisite write failure/,
  );
  assert.equal(await readFile(registryPath, "utf8"), registryBeforeFailure);
});

class RejectInitPathFileSystem extends NodeFileSystem {
  public override async assertPathWithinRoot(
    rootPath: string,
    targetPath: string,
  ): Promise<void> {
    const relative = path.relative(rootPath, targetPath);
    if (relative === ".ai" || relative.startsWith(`.ai${path.sep}`)) {
      throw new Error("simulated AI directory symbolic-link escape");
    }
    await super.assertPathWithinRoot(rootPath, targetPath);
  }
}

class RejectTechnologyPathFileSystem extends NodeFileSystem {
  public override async assertPathWithinRoot(
    rootPath: string,
    targetPath: string,
  ): Promise<void> {
    if (
      path
        .normalize(targetPath)
        .includes(path.normalize(path.join(".ai", "skills", "technology")))
    ) {
      throw new Error("simulated symbolic-link escape");
    }
    await super.assertPathWithinRoot(rootPath, targetPath);
  }
}

class FailingWriteFileSystem extends NodeFileSystem {
  private readonly failingPath: string;

  public constructor(failingPath: string) {
    super();
    this.failingPath = failingPath;
  }

  public override writeText(filePath: string, content: string): Promise<void> {
    if (path.resolve(filePath) === path.resolve(this.failingPath)) {
      return Promise.reject(new Error("injected prerequisite write failure"));
    }
    return super.writeText(filePath, content);
  }
}

function isLinkCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code));
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
