import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectDiscoveryService } from "../../application/project-discovery.ts";
import type { ProjectRecord } from "../../domain/config.ts";
import { NodeFileSystem } from "../../infrastructure/file-system.ts";
import { digestText } from "../contracts/index.ts";
import type { BootstrapEvidence, BootstrapNote, BootstrapProposal, ProjectFacts } from "../memory/index.ts";

/**
 * Zero-config project profile (onboarding): what the repository is built with, detected on session
 * start without asking the user anything and without writing into the repository. The legacy
 * `syn sync` discovery engine (`ProjectDiscoveryService.discoverRepository`) supplies languages,
 * frameworks, package managers and per-module commands; this module adds workspace layout, the
 * likely test/build/lint/typecheck/dev commands, test frameworks, conventions and repository size.
 *
 * The profile is cached in the user scope (`~/.synorch/projects/<project-id>/profile.json`) and
 * recomputed only when a key file (manifests, lockfiles, workspace files) changed: a warm start
 * costs a handful of `stat` calls, and the first model token never waits for a cold detection.
 */

export const PROFILE_SCHEMA_VERSION = 2;

export type CommandName = "test" | "build" | "lint" | "typecheck" | "dev" | "format" | "check";

export interface ProfileCommand {
  readonly command: string;
  readonly source: string;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly path: string;
}

export interface ProjectProfile {
  readonly schema_version: number;
  readonly root: string;
  readonly computed_at: string;
  readonly fingerprint: string;
  /** Files whose stats form the fingerprint (workspace-relative). */
  readonly watched: readonly string[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  /** pnpm, npm, yarn, bun, maven, gradle, uv, poetry, pip, cargo, go, dotnet; null when nothing was recognized. */
  readonly packageManager: string | null;
  readonly workspace: { readonly kind: string; readonly packages: readonly WorkspacePackage[] } | null;
  readonly commands: Readonly<Partial<Record<CommandName, ProfileCommand>>>;
  /** Root package.json script names. */
  readonly scripts: readonly string[];
  readonly testFrameworks: readonly string[];
  readonly conventions: readonly string[];
  readonly keyDirectories: readonly string[];
  readonly manifests: readonly string[];
  readonly repo: { readonly files: number; readonly capped: boolean; readonly size: "small" | "medium" | "large" };
  readonly git: boolean;
}

/** Root files whose change invalidates the cached profile. */
const KEY_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "tsconfig.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.py",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "global.json",
  "Directory.Build.props",
] as const;

const CONVENTION_FILES: readonly (readonly [RegExp, string])[] = [
  [/^(\.eslintrc(\..+)?|eslint\.config\.(js|mjs|cjs|ts))$/, "ESLint"],
  [/^(\.prettierrc(\..+)?|prettier\.config\.(js|mjs|cjs))$/, "Prettier"],
  [/^biome\.jsonc?$/, "Biome"],
  [/^\.editorconfig$/, "EditorConfig"],
  [/^\.husky$/, "Husky git hooks"],
  [/^(commitlint\.config\.(js|cjs|mjs|ts)|\.commitlintrc(\..+)?)$/, "Commitlint (conventional commits)"],
  [/^(ruff\.toml|\.ruff\.toml)$/, "Ruff"],
  [/^(mypy\.ini|\.mypy\.ini)$/, "mypy"],
  [/^\.python-version$/, "pinned Python version (.python-version)"],
  [/^(\.nvmrc|\.node-version)$/, "pinned Node version"],
  [/^checkstyle\.xml$/, "Checkstyle"],
  [/^\.golangci\.ya?ml$/, "golangci-lint"],
  [/^(rustfmt\.toml|\.rustfmt\.toml)$/, "rustfmt"],
  [/^\.pre-commit-config\.yaml$/, "pre-commit hooks"],
];

/** Directories never walked: generated output, dependencies, VCS and tool state, virtualenvs. */
function ignoredDirectory(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name === "__pycache__" ||
    name === "venv" ||
    name === "env" ||
    name === "vendor" ||
    name === "target" ||
    name === "dist" ||
    name === "build" ||
    name === "out" ||
    name === "coverage" ||
    name === "bin" ||
    name === "obj"
  );
}

const FILE_COUNT_CAP = 20_000;

async function readText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort((left, right) => left.localeCompare(right));
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Fingerprint of the watched files: path, size and mtime (a missing file counts too). */
export async function fingerprintOf(root: string, files: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of [...new Set(files)].sort()) {
    const info = await stat(path.join(root, file)).catch(() => undefined);
    parts.push(`${file}:${info === undefined ? "-" : `${info.size}:${Math.round(info.mtimeMs)}`}`);
  }
  return digestText(parts.join("\n"));
}

/** Expands simple workspace globs (`packages/*`, `apps/**`, `libs/core`) to directories holding `marker`. */
async function expandGlobs(root: string, patterns: readonly string[], marker: string): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (base: string, segments: readonly string[]): Promise<void> => {
    if (segments.length === 0) {
      if (await exists(path.join(root, base, marker))) found.add(toPosix(base));
      return;
    }
    const [head, ...rest] = segments;
    if (head === undefined) return;
    if (head === "**") {
      await walk(base, rest);
      if (base.split("/").length > 4) return;
      for (const child of await subdirectories(path.join(root, base))) await walk(base === "" ? child : `${base}/${child}`, segments);
      return;
    }
    if (head.includes("*")) {
      const pattern = new RegExp(`^${head.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
      for (const child of await subdirectories(path.join(root, base))) if (pattern.test(child)) await walk(base === "" ? child : `${base}/${child}`, rest);
      return;
    }
    await walk(base === "" ? head : `${base}/${head}`, rest);
  };
  for (const raw of patterns) {
    if (raw.startsWith("!")) continue;
    const pattern = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (pattern === "" || pattern.includes("..")) continue;
    await walk("", pattern.split("/"));
  }
  return [...found].sort();
}

async function subdirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !ignoredDirectory(entry.name)).map((entry) => entry.name).sort();
}

async function packageNames(root: string, directories: readonly string[], manifest: "package.json" | "pom.xml" | "Cargo.toml" | "pyproject.toml"): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const directory of directories) {
    const text = await readText(path.join(root, directory, manifest));
    let name: string | undefined;
    if (manifest === "package.json") name = typeof parseJson(text)?.name === "string" ? String(parseJson(text)?.name) : undefined;
    else if (manifest === "pom.xml") name = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec((text ?? "").replace(/<parent>[\s\S]*?<\/parent>/, ""))?.[1];
    else name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text ?? "")?.[1];
    packages.push({ name: name ?? path.posix.basename(directory), path: directory });
  }
  return packages;
}

interface WorkspaceDetection {
  readonly kind: string;
  readonly packages: WorkspacePackage[];
  readonly watched: string[];
}

async function detectWorkspace(root: string, packageJson: Record<string, unknown> | undefined, packageManager: string | null, record: ProjectRecord | undefined): Promise<WorkspaceDetection | null> {
  const tools = [(await exists(path.join(root, "nx.json"))) ? "nx" : "", (await exists(path.join(root, "turbo.json"))) ? "turbo" : "", (await exists(path.join(root, "lerna.json"))) ? "lerna" : ""].filter((tool) => tool !== "");
  const withTools = (kind: string): string => (tools.length === 0 ? kind : `${kind} + ${tools.join(" + ")}`);

  const pnpmWorkspace = await readText(path.join(root, "pnpm-workspace.yaml"));
  if (pnpmWorkspace !== undefined) {
    let patterns: string[] = [];
    try {
      const parsed = asRecord(parseYaml(pnpmWorkspace) as unknown);
      patterns = Array.isArray(parsed.packages) ? parsed.packages.filter((item): item is string => typeof item === "string") : [];
    } catch {
      patterns = [];
    }
    const directories = await expandGlobs(root, patterns, "package.json");
    return { kind: withTools("pnpm workspaces"), packages: await packageNames(root, directories, "package.json"), watched: directories.map((directory) => `${directory}/package.json`) };
  }
  const declared = packageJson?.workspaces;
  const npmPatterns = Array.isArray(declared) ? declared : Array.isArray(asRecord(declared).packages) ? (asRecord(declared).packages as unknown[]) : undefined;
  if (npmPatterns !== undefined) {
    const directories = await expandGlobs(root, npmPatterns.filter((item): item is string => typeof item === "string"), "package.json");
    const label = packageManager === "yarn" ? "yarn workspaces" : packageManager === "bun" ? "bun workspaces" : "npm workspaces";
    return { kind: withTools(label), packages: await packageNames(root, directories, "package.json"), watched: directories.map((directory) => `${directory}/package.json`) };
  }
  if (tools.length > 0 && record !== undefined) {
    const directories = record.modules.filter((module) => module.path !== "." && module.manifests.some((file) => file.endsWith("package.json"))).map((module) => module.path);
    return { kind: tools.join(" + "), packages: await packageNames(root, directories, "package.json"), watched: directories.map((directory) => `${directory}/package.json`) };
  }

  const pom = await readText(path.join(root, "pom.xml"));
  if (pom !== undefined) {
    const block = /<modules>([\s\S]*?)<\/modules>/.exec(pom.replace(/<!--[\s\S]*?-->/g, ""))?.[1];
    if (block !== undefined) {
      const directories = [...block.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((match) => toPosix(match[1] ?? "")).filter((directory) => directory !== "" && !directory.includes(".."));
      return { kind: "maven modules", packages: await packageNames(root, directories, "pom.xml"), watched: directories.map((directory) => `${directory}/pom.xml`) };
    }
  }
  const settings = (await readText(path.join(root, "settings.gradle.kts"))) ?? (await readText(path.join(root, "settings.gradle")));
  if (settings !== undefined) {
    const includes = [...settings.matchAll(/include\s*\(?([^)\n]+)\)?/g)].flatMap((match) => [...(match[1] ?? "").matchAll(/["']:?([^"']+)["']/g)].map((item) => (item[1] ?? "").replaceAll(":", "/")));
    if (includes.length > 0) return { kind: "gradle multi-project", packages: includes.map((include) => ({ name: path.posix.basename(include), path: include })), watched: [] };
  }
  const cargo = await readText(path.join(root, "Cargo.toml"));
  if (cargo !== undefined && /^\s*\[workspace\]/m.test(cargo)) {
    const members = /members\s*=\s*\[([\s\S]*?)\]/.exec(cargo)?.[1] ?? "";
    const directories = await expandGlobs(root, [...members.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? ""), "Cargo.toml");
    return { kind: "cargo workspace", packages: await packageNames(root, directories, "Cargo.toml"), watched: directories.map((directory) => `${directory}/Cargo.toml`) };
  }
  const pyproject = await readText(path.join(root, "pyproject.toml"));
  if (pyproject !== undefined && /^\s*\[tool\.uv\.workspace\]/m.test(pyproject)) {
    const members = /\[tool\.uv\.workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/.exec(pyproject)?.[1] ?? "";
    const directories = await expandGlobs(root, [...members.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? ""), "pyproject.toml");
    return { kind: "uv workspace", packages: await packageNames(root, directories, "pyproject.toml"), watched: directories.map((directory) => `${directory}/pyproject.toml`) };
  }
  return null;
}

function scriptCommand(packageManager: string, script: string): string {
  if (packageManager === "npm") return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} ${script}`;
}

const SCRIPT_ALIASES: Readonly<Record<CommandName, readonly string[]>> = {
  test: ["test", "test:unit", "tests"],
  build: ["build", "compile"],
  lint: ["lint", "lint:check", "eslint"],
  typecheck: ["typecheck", "type-check", "check-types", "types", "tsc"],
  dev: ["dev", "start", "serve", "develop"],
  format: ["format", "fmt", "prettier"],
  check: ["check", "verify", "validate", "ci"],
};

function pythonRunner(packageManager: string | null): string {
  return packageManager === "uv" ? "uv run " : packageManager === "poetry" ? "poetry run " : packageManager === "pip" ? "python -m " : "";
}

/** Detects the profile of `root` from scratch (no cache). Never throws for a readable directory. */
export async function detectProjectProfile(workspaceRoot: string): Promise<ProjectProfile> {
  const root = path.resolve(workspaceRoot);
  const discovery = new ProjectDiscoveryService(new NodeFileSystem(), { ignoreDirectory: ignoredDirectory });
  let record: ProjectRecord | undefined;
  try {
    record = (await discovery.discoverRepository(root)) as ProjectRecord;
  } catch {
    record = (await discovery.discoverRepository(root, { shallow: true }).catch(() => undefined)) as ProjectRecord | undefined;
  }
  const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  const packageJsonText = await readText(path.join(root, "package.json"));
  const packageJson = parseJson(packageJsonText);
  const scripts = Object.fromEntries(Object.entries(asRecord(packageJson?.scripts)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const pythonText = [await readText(path.join(root, "pyproject.toml")), await readText(path.join(root, "requirements.txt")), await readText(path.join(root, "requirements-dev.txt")), await readText(path.join(root, "Pipfile"))]
    .filter((text): text is string => text !== undefined)
    .join("\n")
    .toLowerCase();
  const hasPython = pythonText !== "" || rootNames.has("setup.py");
  const dotnet = rootEntries.some((entry) => /\.(sln|csproj|fsproj)$/i.test(entry.name));

  const rootModule = record?.modules.find((module) => module.path === ".");
  let packageManager: string | null = rootModule?.stack.package_manager ?? null;
  if (packageManager === null && packageJson !== undefined) packageManager = "npm";
  if (packageManager === null) {
    if (rootNames.has("pom.xml")) packageManager = "maven";
    else if (rootNames.has("build.gradle") || rootNames.has("build.gradle.kts") || rootNames.has("settings.gradle") || rootNames.has("settings.gradle.kts")) packageManager = "gradle";
    else if (rootNames.has("uv.lock") || /\[tool\.uv/.test(pythonText)) packageManager = "uv";
    else if (rootNames.has("poetry.lock") || /\[tool\.poetry/.test(pythonText)) packageManager = "poetry";
    else if (hasPython) packageManager = "pip";
    else if (rootNames.has("Cargo.toml")) packageManager = "cargo";
    else if (rootNames.has("go.mod")) packageManager = "go";
    else if (dotnet) packageManager = "dotnet";
    else packageManager = record?.stack.package_manager ?? null;
  }

  const languages = new Set(record?.stack.languages ?? []);
  const frameworks = new Set(record?.stack.frameworks ?? []);
  if (hasPython) languages.add("python");
  if (dotnet) languages.add("csharp");
  const dependencies = new Set((record?.evidence ?? []).filter((item) => item.kind === "dependency").map((item) => item.value.toLowerCase()));
  for (const [needle, name] of [
    ["django", "django"],
    ["fastapi", "fastapi"],
    ["flask", "flask"],
  ] as const) {
    if (new RegExp(`["'\\s^]${needle}\\b`, "m").test(pythonText)) frameworks.add(name);
  }
  for (const [dependency, name] of [
    ["svelte", "svelte"],
    ["@sveltejs/kit", "sveltekit"],
    ["vite", "vite"],
    ["astro", "astro"],
    ["@remix-run/react", "remix"],
    ["electron", "electron"],
    ["hono", "hono"],
    ["koa", "koa"],
  ] as const) {
    if (dependencies.has(dependency)) frameworks.add(name);
  }

  const testFrameworks = new Set<string>();
  for (const [dependency, name] of [
    ["vitest", "vitest"],
    ["jest", "jest"],
    ["mocha", "mocha"],
    ["ava", "ava"],
    ["@playwright/test", "playwright"],
    ["cypress", "cypress"],
    ["org.junit.jupiter:junit-jupiter", "junit5"],
    ["org.junit.jupiter:junit-jupiter-api", "junit5"],
    ["junit:junit", "junit4"],
    ["org.testng:testng", "testng"],
    ["org.springframework.boot:spring-boot-starter-test", "junit5"],
  ] as const) {
    if (dependencies.has(dependency)) testFrameworks.add(name);
  }
  if (Object.values(scripts).some((script) => /\bnode\b[^&|;]*--test\b/.test(script))) testFrameworks.add("node:test");
  if (/\bpytest\b/.test(pythonText)) testFrameworks.add("pytest");
  if (languages.has("rust")) testFrameworks.add("cargo test");
  if (languages.has("go")) testFrameworks.add("go test");

  const workspace = await detectWorkspace(root, packageJson, packageManager, record);

  const commands: Partial<Record<CommandName, ProfileCommand>> = {};
  const set = (name: CommandName, command: string, source: string): void => {
    if (commands[name] === undefined) commands[name] = { command, source };
  };
  if (packageJson !== undefined && packageManager !== null && ["pnpm", "npm", "yarn", "bun"].includes(packageManager)) {
    for (const [name, aliases] of Object.entries(SCRIPT_ALIASES) as [CommandName, readonly string[]][]) {
      const script = aliases.find((alias) => scripts[alias] !== undefined);
      if (script !== undefined) set(name, scriptCommand(packageManager, script), `package.json scripts.${script}`);
    }
    if (commands.test === undefined && workspace !== null && workspace.packages.length > 0) {
      if (packageManager === "pnpm") set("test", "pnpm -r test", "pnpm workspaces (no root test script)");
      else if (packageManager === "npm") set("test", "npm test --workspaces --if-present", "npm workspaces (no root test script)");
    }
  }
  for (const [name, value] of Object.entries(rootModule?.commands ?? {})) {
    if (name === "test" || name === "build") set(name, value.value, value.source);
  }
  if (languages.has("java") && (packageManager === "maven" || packageManager === "gradle")) {
    const maven = packageManager === "maven";
    const wrapper = maven ? (rootNames.has("mvnw") ? "./mvnw" : "mvn") : rootNames.has("gradlew") ? "./gradlew" : "gradle";
    set("test", `${wrapper} test`, maven ? "pom.xml" : "build.gradle");
    set("build", maven ? `${wrapper} verify` : `${wrapper} build`, maven ? "pom.xml" : "build.gradle");
    if (frameworks.has("spring-boot")) set("dev", maven ? `${wrapper} spring-boot:run` : `${wrapper} bootRun`, "spring-boot");
  }
  if (packageManager === "cargo" || languages.has("rust")) {
    set("test", "cargo test", "Cargo.toml");
    set("build", "cargo build", "Cargo.toml");
    set("lint", "cargo clippy", "Cargo.toml");
    set("format", "cargo fmt", "Cargo.toml");
  }
  if (packageManager === "go" || languages.has("go")) {
    set("test", "go test ./...", "go.mod");
    set("build", "go build ./...", "go.mod");
    set("lint", rootNames.has(".golangci.yml") || rootNames.has(".golangci.yaml") ? "golangci-lint run" : "go vet ./...", "go.mod");
  }
  if (hasPython) {
    const run = pythonRunner(packageManager);
    const source = rootNames.has("pyproject.toml") ? "pyproject.toml" : "requirements.txt";
    if (testFrameworks.has("pytest")) set("test", `${run}pytest`, source);
    if (/\bruff\b/.test(pythonText) || rootNames.has("ruff.toml")) {
      set("lint", `${run}ruff check .`, source);
      set("format", `${run}ruff format .`, source);
    }
    if (/\bmypy\b/.test(pythonText)) set("typecheck", `${run}mypy .`, source);
    else if (/\bpyright\b/.test(pythonText)) set("typecheck", `${run}pyright`, source);
    if (/\bblack\b/.test(pythonText)) set("format", `${run}black .`, source);
    if (frameworks.has("django") && rootNames.has("manage.py")) set("dev", `${run === "python -m " || run === "" ? "" : run}python manage.py runserver`, "manage.py");
  }
  if (dotnet) {
    set("test", "dotnet test", "*.sln / *.csproj");
    set("build", "dotnet build", "*.sln / *.csproj");
  }
  if (commands.typecheck === undefined && languages.has("typescript") && packageManager !== null && ["pnpm", "npm", "yarn", "bun"].includes(packageManager) && rootNames.has("tsconfig.json")) {
    set("typecheck", packageManager === "npm" ? "npx tsc --noEmit" : `${packageManager === "bun" ? "bunx" : `${packageManager} exec`} tsc --noEmit`, "tsconfig.json");
  }

  const conventions: string[] = [];
  for (const name of [...rootNames].sort()) {
    for (const [pattern, label] of CONVENTION_FILES) if (label !== "" && pattern.test(name)) conventions.push(label);
  }
  if (packageJson !== undefined) {
    if (packageJson.type === "module") conventions.push("ES modules (package.json type: module)");
    const engines = asRecord(packageJson.engines);
    if (typeof engines.node === "string") conventions.push(`Node ${engines.node}`);
    if (packageJson.prettier !== undefined) conventions.push("Prettier");
    if (packageJson["lint-staged"] !== undefined) conventions.push("lint-staged");
    if (typeof packageJson.packageManager === "string") conventions.push(`packageManager ${packageJson.packageManager}`);
  }
  const tsconfig = await readText(path.join(root, "tsconfig.json"));
  if (tsconfig !== undefined) conventions.push(/"strict"\s*:\s*true/.test(tsconfig) ? "TypeScript strict mode" : "TypeScript (tsconfig.json)");
  if (/\[tool\.ruff/.test(pythonText)) conventions.push("Ruff");
  if (/\[tool\.black/.test(pythonText)) conventions.push("Black");
  if (/\[tool\.mypy/.test(pythonText)) conventions.push("mypy");

  const keyDirectories = rootEntries.filter((entry) => entry.isDirectory() && !ignoredDirectory(entry.name)).map((entry) => entry.name).sort();
  const repo = await countFiles(root);
  const watched = sortedUnique([...KEY_FILES, ...(workspace?.watched ?? [])]);

  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    root,
    computed_at: new Date().toISOString(),
    fingerprint: await fingerprintOf(root, watched),
    watched,
    languages: sortedUnique([...languages]),
    frameworks: sortedUnique([...frameworks]),
    packageManager,
    workspace: workspace === null ? null : { kind: workspace.kind, packages: workspace.packages },
    commands,
    scripts: Object.keys(scripts).sort(),
    testFrameworks: sortedUnique([...testFrameworks]),
    conventions: sortedUnique(conventions),
    keyDirectories,
    manifests: sortedUnique(record?.manifests ?? []).slice(0, 60),
    repo,
    git: record?.repository.git ?? rootNames.has(".git"),
  };
}

async function countFiles(root: string): Promise<ProjectProfile["repo"]> {
  let files = 0;
  const queue = [root];
  while (queue.length > 0 && files < FILE_COUNT_CAP) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectory(entry.name)) queue.push(path.join(directory, entry.name));
      } else files += 1;
    }
  }
  const capped = files >= FILE_COUNT_CAP;
  return { files, capped, size: files < 500 ? "small" : files < 5_000 && !capped ? "medium" : "large" };
}

// ---- rendering -----------------------------------------------------------------------------------

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  javascript: "JS",
  typescript: "TS",
  java: "Java",
  python: "Python",
  rust: "Rust",
  go: "Go",
  csharp: "C#",
};

/** `Node/TS`, `Java`, `Python`: the stack in two or three words. */
export function stackLabel(profile: ProjectProfile): string {
  const labels: string[] = [];
  if (profile.languages.includes("typescript")) labels.push("Node/TS");
  else if (profile.languages.includes("javascript")) labels.push("Node/JS");
  for (const language of profile.languages) {
    if (language === "typescript" || language === "javascript") continue;
    labels.push(LANGUAGE_LABELS[language] ?? language);
  }
  return labels.length === 0 ? "no recognized stack" : labels.join(" + ");
}

function workspaceLabel(profile: ProjectProfile): string | undefined {
  if (profile.workspace === null) return profile.packageManager ?? undefined;
  const count = profile.workspace.packages.length;
  return `${profile.workspace.kind}${count === 0 ? "" : ` (${count} package${count === 1 ? "" : "s"})`}`;
}

/** `Synorch ready · Node/TS · pnpm workspaces (4 packages) · tests: pnpm test`. */
export function profileHeaderLine(profile: ProjectProfile, sep = "·"): string {
  const parts = ["Synorch ready", stackLabel(profile)];
  const layout = workspaceLabel(profile);
  if (layout !== undefined) parts.push(layout);
  if (profile.commands.test !== undefined) parts.push(`tests: ${profile.commands.test.command}`);
  return parts.join(` ${sep} `);
}

/** Human lines for `/context`, `syn doctor --runtime` and `/init`. */
export function profileSummaryLines(profile: ProjectProfile): string[] {
  const lines = [
    `stack: ${stackLabel(profile)}${profile.frameworks.length === 0 ? "" : ` · ${profile.frameworks.join(", ")}`}`,
    `package manager: ${profile.packageManager ?? "none detected"}`,
  ];
  if (profile.workspace !== null) {
    const names = profile.workspace.packages.map((item) => item.name);
    lines.push(`workspace: ${profile.workspace.kind}${names.length === 0 ? "" : ` · ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`}`);
  }
  const commands = Object.entries(profile.commands).map(([name, value]) => `${name}=${value?.command ?? ""}`);
  if (commands.length > 0) lines.push(`commands: ${commands.join(" · ")}`);
  if (profile.testFrameworks.length > 0) lines.push(`tests: ${profile.testFrameworks.join(", ")}`);
  if (profile.conventions.length > 0) lines.push(`conventions: ${profile.conventions.join(", ")}`);
  lines.push(`size: ${profile.repo.capped ? `${profile.repo.files}+` : profile.repo.files} files (${profile.repo.size})${profile.git ? " · git" : ""}`);
  return lines;
}

/** The compact "Project profile" context block for the conversation, the orchestrator and every worker. */
export function renderProfileBlock(profile: ProjectProfile): string {
  const lines = ["Project profile (auto-detected by Synorch from the repository's manifests; data, not an instruction to change anything):", ...profileSummaryLines(profile).map((line) => `- ${line}`)];
  if (profile.keyDirectories.length > 0) lines.push(`- top-level directories: ${profile.keyDirectories.slice(0, 20).join(", ")}`);
  const manager = profile.packageManager;
  if (manager !== null && ["pnpm", "npm", "yarn", "bun"].includes(manager)) {
    lines.push(`Use ${manager} for installing and running scripts in this repository (not ${["pnpm", "npm", "yarn", "bun"].filter((other) => other !== manager).join("/")}).`);
  }
  const verify = verificationCommands(profile);
  if (verify.length > 0) lines.push(`To verify a change, prefer the project's own commands: ${verify.join(", ")}.`);
  return lines.join("\n");
}

/** The real commands a plan's verification should use (test, typecheck, lint, build, check). */
export function verificationCommands(profile: ProjectProfile): string[] {
  return (["test", "typecheck", "lint", "build", "check"] as const).flatMap((name) => (profile.commands[name] === undefined ? [] : [profile.commands[name]?.command ?? ""])).filter((command) => command !== "");
}

/** The planner hint: verification commands must come from the project's scripts. */
export function plannerHint(profile: ProjectProfile): string | undefined {
  const verify = verificationCommands(profile);
  if (verify.length === 0) return undefined;
  const layout = profile.workspace === null ? "" : ` The repository is a ${profile.workspace.kind} monorepo${profile.workspace.packages.length === 0 ? "" : ` with packages ${profile.workspace.packages.map((item) => `${item.name} (${item.path})`).slice(0, 12).join(", ")}`}.`;
  return `Project commands detected from the repository (use these exact commands in task verification; do not invent scripts that do not exist): ${verify.join(" · ")}.${profile.packageManager === null ? "" : ` Package manager: ${profile.packageManager}.`}${layout}`;
}

// ---- cache ---------------------------------------------------------------------------------------

export interface ProjectProfileHandle {
  /** The latest known profile (cached or fresh); undefined until the first load finished. */
  current(): ProjectProfile | undefined;
  /** Resolves with the up-to-date profile (recomputed when a key file changed); undefined on failure. */
  readonly ready: Promise<ProjectProfile | undefined>;
  /** Forces a new detection (e.g. `/memory init`). */
  refresh(): Promise<ProjectProfile | undefined>;
  readonly file: string;
}

async function readCache(file: string, root: string): Promise<ProjectProfile | undefined> {
  const parsed = parseJson(await readText(file)) as unknown as ProjectProfile | undefined;
  if (parsed === undefined || parsed.schema_version !== PROFILE_SCHEMA_VERSION || parsed.root !== root || !Array.isArray(parsed.watched)) return undefined;
  return parsed;
}

async function writeCache(file: string, profile: ProjectProfile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * Starts loading the profile of `workspaceRoot` in the background: the cached profile first (fast),
 * then a fingerprint check and, only when a key file changed, a new detection written back to the
 * user-scope cache. Nothing is written into the repository.
 */
export function startProjectProfile(home: string, projectId: string, workspaceRoot: string): ProjectProfileHandle {
  const root = path.resolve(workspaceRoot);
  const file = path.join(home, "projects", projectId, "profile.json");
  let latest: ProjectProfile | undefined;
  const detect = async (): Promise<ProjectProfile | undefined> => {
    const fresh = await detectProjectProfile(root).catch(() => undefined);
    if (fresh === undefined) return latest;
    latest = fresh;
    await writeCache(file, fresh).catch(() => undefined);
    return fresh;
  };
  const ready = (async (): Promise<ProjectProfile | undefined> => {
    const cached = await readCache(file, root).catch(() => undefined);
    if (cached !== undefined) {
      latest = cached;
      const now = await fingerprintOf(root, cached.watched).catch(() => undefined);
      if (now === cached.fingerprint) return cached;
    }
    return detect();
  })();
  ready.catch(() => undefined);
  return { current: () => latest, ready, refresh: detect, file };
}

/** Waits for `promise` up to `ms`; undefined when it takes longer. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- memory bootstrap facts (`/memory init`) -----------------------------------------------------

/** What `/memory init` writes (concept / evidence) and proposes (decision / preference) from a profile. */
export function profileMemoryFacts(profile: ProjectProfile): ProjectFacts {
  const concepts: BootstrapNote[] = [];
  const stack = [
    `Languages: ${profile.languages.join(", ") || "none detected"}.`,
    ...(profile.frameworks.length === 0 ? [] : [`Frameworks: ${profile.frameworks.join(", ")}.`]),
    `Package manager / build tool: ${profile.packageManager ?? "none detected"}.`,
    ...(profile.testFrameworks.length === 0 ? [] : [`Test frameworks: ${profile.testFrameworks.join(", ")}.`]),
    `Repository size: ${profile.repo.files}${profile.repo.capped ? "+" : ""} files (${profile.repo.size}).`,
    "Detected automatically by Synorch from the repository's manifests.",
  ];
  concepts.push({ key: "project-stack", title: `Project stack: ${stackLabel(profile)}`, body: stack.join("\n") });
  const commands = Object.entries(profile.commands).map(([name, value]) => `- ${name}: \`${value?.command ?? ""}\` (from ${value?.source ?? "?"})`);
  if (commands.length > 0) concepts.push({ key: "project-commands", title: "Project commands", body: ["How to test, build, lint and run this project:", ...commands].join("\n") });
  const layout = [
    ...(profile.workspace === null ? ["Single-package repository."] : [`Monorepo: ${profile.workspace.kind}.`, ...profile.workspace.packages.slice(0, 40).map((item) => `- ${item.name} (${item.path})`)]),
    ...(profile.keyDirectories.length === 0 ? [] : [`Top-level directories: ${profile.keyDirectories.join(", ")}.`]),
  ];
  concepts.push({ key: "project-layout", title: "Project layout", body: layout.join("\n") });
  if (profile.conventions.length > 0) concepts.push({ key: "project-conventions", title: "Project conventions", body: `Detected from configuration files: ${profile.conventions.join(", ")}.` });

  const evidence: BootstrapEvidence[] = [];
  const rootManifests = profile.manifests.filter((file) => !file.includes("/"));
  for (const file of rootManifests) {
    evidence.push({ key: `manifest-${file}`, title: `Manifest ${file}`, body: `${file} is one of the files the project profile was detected from; when it changes this note goes stale.`, sourceRef: file });
  }
  if (profile.workspace?.kind.startsWith("pnpm") === true) {
    evidence.push({ key: "manifest-pnpm-workspace-yaml", title: "Manifest pnpm-workspace.yaml", body: `Declares the pnpm workspace packages (${profile.workspace.packages.length}).`, sourceRef: "pnpm-workspace.yaml" });
  }

  const proposals: BootstrapProposal[] = [];
  const manifestSource = rootManifests.find((file) => ["package.json", "pom.xml", "pyproject.toml", "Cargo.toml", "go.mod", "build.gradle", "build.gradle.kts"].includes(file));
  if (profile.packageManager !== null) {
    proposals.push({
      key: `package-manager-${profile.packageManager}`,
      kind: "decision",
      title: `Use ${profile.packageManager} as the package manager`,
      body: `Install dependencies and run scripts with ${profile.packageManager}; do not switch to another package manager or add a different lockfile.`,
      rationale: `Detected from the repository (${manifestSource ?? "lockfiles"}); accepting makes it a standing project decision.`,
      ...(manifestSource === undefined ? {} : { sourceRef: manifestSource }),
    });
  }
  if (profile.workspace !== null) {
    proposals.push({
      key: `workspace-${profile.workspace.kind}`,
      kind: "decision",
      title: `The repository is a monorepo managed with ${profile.workspace.kind}`,
      body: profile.workspace.packages.length === 0 ? "" : `Packages: ${profile.workspace.packages.map((item) => item.name).slice(0, 20).join(", ")}.`,
      rationale: "Detected from the workspace configuration; new code belongs in one of the workspace packages.",
    });
  }
  if (profile.testFrameworks.length > 0) {
    proposals.push({
      key: `test-framework-${profile.testFrameworks.join("-")}`,
      kind: "decision",
      title: `Tests are written with ${profile.testFrameworks.join(" and ")}`,
      body: "New tests follow the existing framework; no second test framework is introduced.",
      rationale: "Detected from the project's dependencies and scripts.",
    });
  }
  const verify = profile.commands.check ?? profile.commands.test;
  if (verify !== undefined) {
    proposals.push({
      key: `verify-with-${verify.command}`,
      kind: "preference",
      title: `Verify changes with \`${verify.command}\``,
      body: `Run \`${verify.command}\` before reporting a change as done.`,
      rationale: `The project defines it (${verify.source}).`,
    });
  }
  return { concepts, evidence, proposals };
}
