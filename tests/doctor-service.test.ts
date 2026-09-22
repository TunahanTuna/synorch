import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DoctorService } from "../src/application/doctor-service.ts";
import { ProjectDiscoveryService } from "../src/application/project-discovery.ts";
import { StructureService } from "../src/application/structure-service.ts";
import {
  projectRecordSchema,
  skillRegistrySchema,
  workspaceSchema,
} from "../src/domain/config.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";
import { parseYaml, stringifyYaml } from "../src/infrastructure/serialization.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "cleanup must stay in OS temp");
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

test("doctor accepts a generated and synced structure", async () => {
  const { directory, fileSystem } = await createSyncedStructure();

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ["healthy"]);
});

test("doctor reports a missing referenced project record and never reports healthy", async () => {
  const { directory, fileSystem, recordPath } = await createSyncedStructure();
  await rm(path.join(directory, recordPath));

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-project-record"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports a malformed referenced skill registry", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  await writeFile(path.join(directory, skillRegistryPath), "not: [valid", "utf8");

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "malformed-skill-registry"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor rejects POSIX and Windows traversal in workspace references", async () => {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, ".ai", "workspace.yaml"),
    stringifyYaml({
      schema_version: 1,
      scope: "repository",
      projects: [
        { id: "posix", path: ".", record: "../outside.yaml" },
        { id: "windows", path: ".", record: "..\\outside.yaml" },
      ],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "unsafe-project-record-path").length,
    2,
  );
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor rejects a project directory symlink or junction escaping the target root", async () => {
  const directory = await createTempDirectory();
  const outside = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  const linkedProject = path.join(directory, "linked-project");
  await symlink(outside, linkedProject, process.platform === "win32" ? "junction" : "dir");
  await writeFile(
    path.join(directory, ".ai", "workspace.yaml"),
    stringifyYaml({
      schema_version: 1,
      scope: "repository",
      projects: [
        {
          id: "linked-project",
          path: "linked-project",
          record: ".ai/projects/linked-project.yaml",
        },
      ],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "unsafe-project-path"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports a missing selected technology skill", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(path.join(directory, skillRegistryPath), "utf8")),
  );
  const selectedSkill = registry.technology_skills[0];
  assert.ok(selectedSkill);
  await rm(path.join(directory, selectedSkill.relative_path));

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-technology-skill"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor rejects traversal in a base skill path", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const absoluteRegistryPath = path.join(directory, skillRegistryPath);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(absoluteRegistryPath, "utf8")),
  );
  const baseSkill = registry.base_skills[0];
  assert.ok(baseSkill);
  await writeFile(
    absoluteRegistryPath,
    stringifyYaml({
      ...registry,
      base_skills: [
        {
          ...baseSkill,
          relative_path: ".ai/skills/../../outside/SKILL.md",
        },
        ...registry.base_skills.slice(1),
      ],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "unsafe-base-skill-path"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports a missing canonical base skill file", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(path.join(directory, skillRegistryPath), "utf8")),
  );
  const baseSkill = registry.base_skills[0];
  assert.ok(baseSkill);
  await rm(path.join(directory, baseSkill.relative_path));

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-base-skill"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports a canonical base skill entry removed from the registry", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const absoluteRegistryPath = path.join(directory, skillRegistryPath);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(absoluteRegistryPath, "utf8")),
  );
  const removedSkill = registry.base_skills[0];
  assert.ok(removedSkill);
  await writeFile(
    absoluteRegistryPath,
    stringifyYaml({
      ...registry,
      base_skills: registry.base_skills.slice(1),
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "missing-base-skill-entry" &&
        diagnostic.message.includes(removedSkill.id),
    ),
  );
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports duplicate and unexpected base skill ids", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const absoluteRegistryPath = path.join(directory, skillRegistryPath);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(absoluteRegistryPath, "utf8")),
  );
  const baseSkill = registry.base_skills[0];
  assert.ok(baseSkill);
  await writeFile(
    absoluteRegistryPath,
    stringifyYaml({
      ...registry,
      base_skills: [
        ...registry.base_skills,
        { ...baseSkill },
        {
          id: "unexpected-base",
          relative_path: ".ai/skills/unexpected-base/SKILL.md",
        },
      ],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));

  assert.ok(codes.has("duplicate-base-skill-id"));
  assert.ok(codes.has("unexpected-base-skill-entry"));
  assert.ok(!codes.has("healthy"));
});

test("doctor requires existing project directories and canonical record paths", async () => {
  const { directory, fileSystem } = await createSyncedStructure();
  const workspacePath = path.join(directory, ".ai", "workspace.yaml");
  const workspace = workspaceSchema.parse(parseYaml(await readFile(workspacePath, "utf8")));
  const project = workspace.projects[0];
  assert.ok(project);

  await writeFile(
    workspacePath,
    stringifyYaml({
      ...workspace,
      projects: [{ ...project, path: "missing-project" }],
    }),
    "utf8",
  );
  const missingDirectoryDiagnostics = await new DoctorService(fileSystem).diagnose(directory);
  assert.ok(
    missingDirectoryDiagnostics.some(
      (diagnostic) => diagnostic.code === "missing-project-directory",
    ),
  );

  await writeFile(
    workspacePath,
    stringifyYaml({
      ...workspace,
      projects: [{ ...project, record: ".ai/projects/alias.yaml" }],
    }),
    "utf8",
  );
  const recordDiagnostics = await new DoctorService(fileSystem).diagnose(directory);
  assert.ok(
    recordDiagnostics.some(
      (diagnostic) => diagnostic.code === "noncanonical-project-record-path",
    ),
  );
  assert.ok(!recordDiagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor rejects tampered command cwd values across path syntaxes", async () => {
  const { directory, fileSystem, recordPath } = await createSyncedStructure();
  const absoluteRecordPath = path.join(directory, recordPath);
  const record = projectRecordSchema.parse(
    parseYaml(await readFile(absoluteRecordPath, "utf8")),
  );
  const module = record.modules[0];
  const moduleCommand = module?.commands["test"];
  const projectCommand = record.commands["test"];
  assert.ok(module);
  assert.ok(moduleCommand);
  assert.ok(projectCommand);
  await writeFile(
    absoluteRecordPath,
    stringifyYaml({
      ...record,
      modules: [
        {
          ...module,
          commands: {
            ...module.commands,
            test: { ...moduleCommand, cwd: "/outside" },
          },
        },
      ],
      commands: {
        ...record.commands,
        test: { ...projectCommand, cwd: "C:\\outside" },
        traversal: { ...projectCommand, cwd: "../../outside" },
      },
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "unsafe-command-cwd").length,
    3,
  );
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports missing module directories and unsafe manifest or source paths", async () => {
  const { directory, fileSystem, recordPath } = await createSyncedStructure();
  const absoluteRecordPath = path.join(directory, recordPath);
  const record = projectRecordSchema.parse(
    parseYaml(await readFile(absoluteRecordPath, "utf8")),
  );
  const module = record.modules[0];
  const evidence = module?.evidence[0];
  const command = module?.commands["test"];
  assert.ok(module);
  assert.ok(evidence);
  assert.ok(command);
  await writeFile(
    absoluteRecordPath,
    stringifyYaml({
      ...record,
      modules: [
        {
          ...module,
          path: "missing-module",
          manifests: ["../../outside.xml"],
          evidence: [{ ...evidence, source: "C:\\outside.xml" }],
          commands: {
            ...module.commands,
            test: { ...command, cwd: "missing-module", source: "../outside.json" },
          },
        },
      ],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "missing-module-directory"));
  assert.ok(
    diagnostics.filter(
      (diagnostic) => diagnostic.code === "unsafe-project-artifact-path",
    ).length >= 3,
  );
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor rejects registry and technology skill paths outside their generated roots", async () => {
  const { directory, fileSystem, recordPath, skillRegistryPath } =
    await createSyncedStructure();
  const absoluteRecordPath = path.join(directory, recordPath);
  const record = projectRecordSchema.parse(
    parseYaml(await readFile(absoluteRecordPath, "utf8")),
  );
  await writeFile(
    absoluteRecordPath,
    stringifyYaml({ ...record, skill_registry: ".ai/projects2/forged.skills.yaml" }),
    "utf8",
  );

  const registryDiagnostics = await new DoctorService(fileSystem).diagnose(directory);
  assert.ok(
    registryDiagnostics.some(
      (diagnostic) => diagnostic.code === "unsafe-skill-registry-path",
    ),
  );

  await writeFile(absoluteRecordPath, stringifyYaml(record), "utf8");
  const absoluteRegistryPath = path.join(directory, skillRegistryPath);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(absoluteRegistryPath, "utf8")),
  );
  const selectedSkill = registry.technology_skills[0];
  assert.ok(selectedSkill);
  await writeFile(
    absoluteRegistryPath,
    stringifyYaml({
      ...registry,
      technology_skills: [
        {
          ...selectedSkill,
          relative_path: ".ai/skills/technology/../../outside/SKILL.md",
        },
      ],
    }),
    "utf8",
  );

  const skillDiagnostics = await new DoctorService(fileSystem).diagnose(directory);
  assert.ok(
    skillDiagnostics.some(
      (diagnostic) => diagnostic.code === "unsafe-technology-skill-path",
    ),
  );
  assert.ok(!skillDiagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports duplicate skill paths in a project registry", async () => {
  const { directory, fileSystem, skillRegistryPath } = await createSyncedStructure();
  const absoluteRegistryPath = path.join(directory, skillRegistryPath);
  const registry = skillRegistrySchema.parse(
    parseYaml(await readFile(absoluteRegistryPath, "utf8")),
  );
  const selectedSkill = registry.technology_skills[0];
  assert.ok(selectedSkill);
  await writeFile(
    absoluteRegistryPath,
    stringifyYaml({
      ...registry,
      technology_skills: [selectedSkill, { ...selectedSkill }],
    }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "duplicate-registry-skill-path"),
  );
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "healthy"));
});

test("doctor reports duplicate workspace identity and record references", async () => {
  const { directory, fileSystem } = await createSyncedStructure();
  const workspacePath = path.join(directory, ".ai", "workspace.yaml");
  const workspace = workspaceSchema.parse(parseYaml(await readFile(workspacePath, "utf8")));
  const project = workspace.projects[0];
  assert.ok(project);
  await writeFile(
    workspacePath,
    stringifyYaml({ ...workspace, projects: [project, { ...project }] }),
    "utf8",
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));

  assert.ok(codes.has("duplicate-project-id"));
  assert.ok(codes.has("duplicate-project-path"));
  assert.ok(codes.has("duplicate-project-record"));
  assert.ok(!codes.has("healthy"));
});

async function createSyncedStructure(): Promise<{
  readonly directory: string;
  readonly fileSystem: NodeFileSystem;
  readonly recordPath: string;
  readonly skillRegistryPath: string;
}> {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.19.0",
      dependencies: { react: "19.0.0" },
      devDependencies: { typescript: "5.9.3" },
      scripts: { test: "node --test" },
    }),
    "utf8",
  );
  const result = await new ProjectDiscoveryService(fileSystem).sync(directory);
  const project = result.projects[0];
  assert.ok(project);
  const workspace = workspaceSchema.parse(
    parseYaml(await readFile(path.join(directory, ".ai", "workspace.yaml"), "utf8")),
  );
  const workspaceProject = workspace.projects[0];
  assert.ok(workspaceProject);
  return {
    directory,
    fileSystem,
    recordPath: workspaceProject.record,
    skillRegistryPath: project.skill_registry,
  };
}


async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}
