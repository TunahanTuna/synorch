import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DoctorService, type Diagnostic } from "../src/application/doctor-service.ts";
import { StructureService } from "../src/application/structure-service.ts";
import {
  REQUIRED_AGENT_SECTIONS,
  REQUIRED_SKILL_SECTIONS,
} from "../src/domain/canonical-contracts.ts";
import { BASE_SKILLS } from "../src/domain/skill-packs.ts";
import { NodeFileSystem } from "../src/infrastructure/file-system.ts";
import {
  normalizeSectionName,
  parseFrontmatter,
  splitMarkdownSections,
} from "../src/infrastructure/frontmatter.ts";
import { AGENT_DOCUMENTS } from "../src/templates/agent-manifests.ts";

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

test("a freshly generated structure raises no contract or size diagnostic", async () => {
  const { directory, fileSystem } = await createStructure();

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);

  assert.deepEqual(codesOf(diagnostics), ["healthy"]);
});

test("every generated agent and base skill carries its required sections", async () => {
  const { directory, fileSystem } = await createStructure();

  for (const agent of AGENT_DOCUMENTS) {
    const sections = await readSections(
      fileSystem,
      path.join(directory, ".ai", "agents", agent.id, "AGENT.md"),
    );
    for (const section of REQUIRED_AGENT_SECTIONS) {
      assert.ok(sections.has(normalizeSectionName(section)), `${agent.id}: ${section}`);
    }
    assert.match(sections.get("procedure") ?? "", /^1\. \S/m, agent.id);
  }

  for (const skill of BASE_SKILLS) {
    const sections = await readSections(fileSystem, path.join(directory, skill.relativePath));
    for (const section of REQUIRED_SKILL_SECTIONS) {
      assert.ok(sections.has(normalizeSectionName(section)), `${skill.id}: ${section}`);
    }
    assert.match(sections.get("procedure") ?? "", /^1\. \S/m, skill.id);
  }
});

test("doctor reports a skill with no frontmatter block", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(directory, "# Debugging\n\nNo frontmatter here.\n");

  await assertDiagnostic(fileSystem, directory, "contract.missing-frontmatter");
});

test("doctor reports an unparseable frontmatter block", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(directory, "---\nname: [unclosed\n---\n\n# Debugging\n");

  await assertDiagnostic(fileSystem, directory, "contract.malformed-frontmatter");
});

test("doctor reports invalid frontmatter fields in a skill and in an agent", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(directory, skillDocument("name: debugging\ndescription: Use it.\nversion: one"));
  await assertDiagnostic(fileSystem, directory, "contract.invalid-frontmatter");

  const { directory: second, fileSystem: secondFileSystem } = await createStructure();
  await writeAgent(
    second,
    agentDocument(
      [
        "name: implementer",
        "role: product-change",
        "writes_product_files: true",
        "model_tier: genius",
        "allowed_skills: [implementation]",
        "reports: completion-packet",
      ].join("\n"),
    ),
  );
  await assertDiagnostic(secondFileSystem, second, "contract.invalid-frontmatter");
});

test("doctor reports a missing required section", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(directory, skillDocument(validSkillFrontmatter, { omit: "Output contract" }));

  const diagnostics = await assertDiagnostic(fileSystem, directory, "contract.missing-section");
  assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Output contract")));
});

test("doctor reports a procedure that is not a numbered list", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(
    directory,
    skillDocument(validSkillFrontmatter, { procedure: "- Reproduce it.\n- Fix it." }),
  );

  await assertDiagnostic(fileSystem, directory, "contract.unnumbered-procedure");
});

test("doctor reports an unknown skill id in an agent's allowed skills", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeAgent(
    directory,
    agentDocument(
      [
        "name: implementer",
        "role: product-change",
        "writes_product_files: true",
        "model_tier: any",
        "allowed_skills: [implementation, imaginary-skill]",
        'forbidden_skills: ["also-imaginary"]',
        "reports: completion-packet",
      ].join("\n"),
    ),
  );

  const diagnostics = await assertDiagnostic(
    fileSystem,
    directory,
    "contract.unknown-skill-reference",
  );
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "contract.unknown-skill-reference")
      .length,
    2,
  );
});

test("doctor reports a manifest whose declared name is not its directory", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeAgent(
    directory,
    agentDocument(
      [
        "name: impostor",
        "role: product-change",
        "writes_product_files: true",
        "model_tier: any",
        "allowed_skills: [implementation]",
        "reports: completion-packet",
      ].join("\n"),
    ),
  );

  await assertDiagnostic(fileSystem, directory, "contract.identity-mismatch");
});

test("doctor reports a removed agent manifest and a removed base skill", async () => {
  const { directory, fileSystem } = await createStructure();
  await rm(path.join(directory, ".ai", "agents", "reviewer", "AGENT.md"));
  const skill = BASE_SKILLS[0];
  assert.ok(skill);
  await rm(path.join(directory, skill.relativePath));

  const diagnostics = await assertDiagnostic(fileSystem, directory, "contract.missing-file");
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "contract.missing-file").length,
    2,
  );
});

test("doctor reports a declared reference file that is not on disk", async () => {
  const { directory, fileSystem } = await createStructure();
  await rm(path.join(directory, ".ai", "skills", "debugging", "references", "hypothesis-patterns.md"));

  await assertDiagnostic(fileSystem, directory, "contract.missing-reference-file");
});

test("doctor rejects a reference path that lexically escapes the skill directory", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(
    directory,
    skillDocument(`${validSkillFrontmatter}\nreferences:\n  - ../../../outside.md\n  - /etc/passwd`),
  );

  const diagnostics = await assertDiagnostic(
    fileSystem,
    directory,
    "contract.unsafe-reference-path",
  );
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "contract.unsafe-reference-path").length,
    2,
  );
});

test("doctor rejects a reference that escapes through a symbolic link", async () => {
  const { directory, fileSystem: realFileSystem } = await createStructure();
  const outside = await createTempDirectory();
  await writeFile(path.join(outside, "leak.md"), "# Leaked\n", "utf8");
  await writeSkill(
    directory,
    skillDocument(`${validSkillFrontmatter}\nreferences:\n  - references/leak.md`),
  );
  const linkPath = path.join(directory, ".ai", "skills", "debugging", "references", "leak.md");

  let fileSystem: NodeFileSystem = realFileSystem;
  try {
    await symlink(path.join(outside, "leak.md"), linkPath, "file");
  } catch (error: unknown) {
    if (!isLinkCapabilityError(error)) throw error;
    await writeFile(linkPath, "# Leaked\n", "utf8");
    fileSystem = new RejectReferencePathFileSystem();
  }

  await assertDiagnostic(fileSystem, directory, "contract.unsafe-reference-path");
});

test("doctor warns when a layer exceeds its byte ceiling", async () => {
  const { directory, fileSystem } = await createStructure();
  await writeSkill(
    directory,
    skillDocument(validSkillFrontmatter, { padding: "\nfiller. ".repeat(900) }),
  );

  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);
  const warning = diagnostics.find((diagnostic) => diagnostic.code === "size.base-skill");

  assert.ok(warning);
  assert.equal(warning.severity, "warning");
  assert.match(warning.message, /ceiling/);
  assert.ok(!codesOf(diagnostics).includes("healthy"));
});

const validSkillFrontmatter = [
  "name: debugging",
  "description: Use for defects and unexplained failures.",
  "version: 1.0.0",
].join("\n");

interface SkillBodyOptions {
  readonly omit?: string;
  readonly procedure?: string;
  readonly padding?: string;
}

function skillDocument(frontmatter: string, options: SkillBodyOptions = {}): string {
  const sections = REQUIRED_SKILL_SECTIONS.filter((section) => section !== options.omit).map(
    (section) =>
      `## ${section}\n\n${
        section === "Procedure" ? (options.procedure ?? "1. Reproduce the failure.") : "Content."
      }`,
  );
  return `---\n${frontmatter}\n---\n\n# Debugging\n\n${sections.join("\n\n")}\n${options.padding ?? ""}`;
}

function agentDocument(frontmatter: string): string {
  const sections = REQUIRED_AGENT_SECTIONS.map(
    (section) =>
      `## ${section}\n\n${section === "Procedure" ? "1. Read the packet." : "Content."}`,
  );
  return `---\n${frontmatter}\n---\n\n# Implementer\n\n${sections.join("\n\n")}\n`;
}

async function writeSkill(directory: string, content: string): Promise<void> {
  await writeFile(path.join(directory, ".ai", "skills", "debugging", "SKILL.md"), content, "utf8");
}

async function writeAgent(directory: string, content: string): Promise<void> {
  await writeFile(
    path.join(directory, ".ai", "agents", "implementer", "AGENT.md"),
    content,
    "utf8",
  );
}

async function assertDiagnostic(
  fileSystem: NodeFileSystem,
  directory: string,
  code: string,
): Promise<readonly Diagnostic[]> {
  const diagnostics = await new DoctorService(fileSystem).diagnose(directory);
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === code),
    `expected ${code}, received ${codesOf(diagnostics).join(", ")}`,
  );
  assert.ok(!codesOf(diagnostics).includes("healthy"));
  return diagnostics;
}

async function readSections(
  fileSystem: NodeFileSystem,
  absolutePath: string,
): Promise<ReadonlyMap<string, string>> {
  const parsed = parseFrontmatter(await fileSystem.readText(absolutePath));
  assert.equal(parsed.kind, "parsed", absolutePath);
  return parsed.kind === "parsed" ? splitMarkdownSections(parsed.body) : new Map();
}

function codesOf(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

class RejectReferencePathFileSystem extends NodeFileSystem {
  public override async assertPathWithinRoot(
    rootPath: string,
    targetPath: string,
  ): Promise<void> {
    if (path.normalize(targetPath).includes(`${path.sep}references${path.sep}leak.md`)) {
      throw new Error("simulated reference symbolic-link escape");
    }
    await super.assertPathWithinRoot(rootPath, targetPath);
  }
}

function isLinkCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code));
}

async function createStructure(): Promise<{
  readonly directory: string;
  readonly fileSystem: NodeFileSystem;
}> {
  const directory = await createTempDirectory();
  const fileSystem = new NodeFileSystem();
  const structure = new StructureService(fileSystem);
  await structure.initialize(await structure.createPlan(directory, "repository"));
  return { directory, fileSystem };
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synorch-canonical-"));
  temporaryDirectories.push(directory);
  return directory;
}
