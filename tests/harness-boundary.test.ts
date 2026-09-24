import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ADR-01 / ADR-02 / ADR-04 / ADR-12 module boundaries, enforced statically on the source tree:
 *
 * - The existing CLI layers never import the runtime; `src/cli.ts` may only reach it through the
 *   literal dynamic import of the harness CLI entry.
 * - Every harness module depends only on `contracts` (plus zod, node built-ins and src/domain);
 *   `cli` is the only composition root allowed to import sibling modules.
 * - `contracts` is a leaf.
 * - No harness file loads code through a computed dynamic import.
 * - `@earendil-works/pi-tui` is imported from exactly one adapter file.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HARNESS = path.join(SRC, "harness");

const HARNESS_MODULES = [
  "contracts",
  "core",
  "store",
  "providers",
  "auth",
  "tools",
  "policy",
  "orchestration",
  "context",
  "memory",
  "tui",
  "cli",
] as const;
type HarnessModule = (typeof HARNESS_MODULES)[number];

const ALLOWED_HARNESS_DEPENDENCIES: { readonly [M in HarnessModule]: readonly HarnessModule[] } = {
  contracts: [],
  core: ["contracts"],
  store: ["contracts"],
  providers: ["contracts"],
  auth: ["contracts"],
  tools: ["contracts"],
  policy: ["contracts"],
  orchestration: ["contracts"],
  context: ["contracts"],
  memory: ["contracts"],
  tui: ["contracts"],
  cli: HARNESS_MODULES.filter((module) => module !== "cli"),
};

/**
 * The one non-domain source the composition root may read: the generator's structure templates,
 * which are the built-in canonical `.ai/` defaults the runtime falls back to when a repository has
 * no `.ai/` (one source of truth for what `syn init` writes and what the runtime assumes). Only
 * `cli` may import it; every other harness module still sees `contracts` and `src/domain` only.
 */
// The composition root reuses the legacy discovery and init engines (zero-config project profile, `/init`).
const CLI_EXTRA_SOURCES: readonly string[] = [
  path.join(SRC, "templates", "structure-templates.ts"),
  path.join(SRC, "application", "project-discovery.ts"),
  path.join(SRC, "application", "structure-service.ts"),
  path.join(SRC, "infrastructure", "file-system.ts"),
];

const HARNESS_CLI_ENTRY = "./harness/cli/index.ts";
const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const PI_TUI_ADAPTER = path.join(HARNESS, "tui", "pi-tui-renderer.ts");

interface ImportSite {
  readonly specifier: string;
  readonly dynamic: boolean;
  readonly computed: boolean;
}

async function listTypeScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScript(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function importSites(source: string): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const match of source.matchAll(/(?:^|[;\n])\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    sites.push({ specifier: match[1] ?? "", dynamic: false, computed: false });
  }
  for (const match of source.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) {
    sites.push({ specifier: match[1] ?? "", dynamic: false, computed: false });
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1] ?? "";
    const literal = /^(["'])([^"'`$]+)\1$/.exec(argument);
    sites.push({ specifier: literal?.[2] ?? argument, dynamic: true, computed: literal === null });
  }
  return sites;
}

function resolveRelative(file: string, specifier: string): string | undefined {
  return specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : undefined;
}

function harnessModuleOf(absolute: string): HarnessModule | undefined {
  const relative = path.relative(HARNESS, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const first = relative.split(path.sep)[0];
  return HARNESS_MODULES.find((module) => module === first);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

test("every harness module exists with an index.ts entry", async () => {
  for (const module of HARNESS_MODULES) {
    const info = await stat(path.join(HARNESS, module, "index.ts"));
    assert.ok(info.isFile(), `${module}/index.ts`);
  }
});

test("existing CLI layers never import the runtime eagerly", async () => {
  const legacy = (await listTypeScript(SRC)).filter((file) => !isInside(HARNESS, file));
  assert.ok(legacy.length > 0);
  for (const file of legacy) {
    const source = await readFile(file, "utf8");
    for (const site of importSites(source)) {
      const target = resolveRelative(file, site.specifier);
      if (target === undefined || !isInside(HARNESS, target)) continue;
      const allowed = file === path.join(SRC, "cli.ts") && site.dynamic && site.specifier === HARNESS_CLI_ENTRY;
      assert.ok(allowed, `${path.relative(SRC, file)} imports ${site.specifier}; only a dynamic import of ${HARNESS_CLI_ENTRY} from cli.ts is allowed`);
    }
  }
});

test("harness modules depend only on contracts; cli is the only composition root", async () => {
  for (const file of await listTypeScript(HARNESS)) {
    const owner = harnessModuleOf(file);
    assert.ok(owner !== undefined, `${path.relative(SRC, file)} is outside a known harness module`);
    const source = await readFile(file, "utf8");
    for (const site of importSites(source)) {
      const target = resolveRelative(file, site.specifier);
      if (target === undefined) continue;
      if (isInside(HARNESS, target)) {
        const dependency = harnessModuleOf(target);
        assert.ok(dependency !== undefined, `${path.relative(SRC, file)} imports unknown ${site.specifier}`);
        if (dependency === owner) continue;
        assert.ok(
          ALLOWED_HARNESS_DEPENDENCIES[owner].includes(dependency),
          `${owner} must not import ${dependency} (${path.relative(SRC, file)} -> ${site.specifier})`,
        );
        continue;
      }
      if (owner === "cli" && CLI_EXTRA_SOURCES.includes(target)) continue;
      assert.ok(
        isInside(path.join(SRC, "domain"), target),
        `${path.relative(SRC, file)} reaches outside harness and domain: ${site.specifier}`,
      );
    }
  }
});

test("contracts is a leaf that imports only zod, node built-ins, siblings and src/domain", async () => {
  for (const file of await listTypeScript(path.join(HARNESS, "contracts"))) {
    const source = await readFile(file, "utf8");
    for (const site of importSites(source)) {
      const bare = !site.specifier.startsWith(".");
      if (bare) {
        assert.ok(
          site.specifier === "zod" || site.specifier.startsWith("node:"),
          `${path.relative(SRC, file)} imports package ${site.specifier}`,
        );
        continue;
      }
      const target = resolveRelative(file, site.specifier) ?? "";
      assert.ok(
        isInside(path.join(HARNESS, "contracts"), target) || isInside(path.join(SRC, "domain"), target),
        `${path.relative(SRC, file)} imports ${site.specifier}`,
      );
    }
  }
});

test("no harness file performs a computed dynamic import", async () => {
  for (const file of await listTypeScript(HARNESS)) {
    for (const site of importSites(await readFile(file, "utf8"))) {
      assert.ok(!site.computed, `${path.relative(SRC, file)} has a computed import(${site.specifier})`);
    }
  }
});

test("pi-tui is imported only by the TUI adapter", async () => {
  for (const file of await listTypeScript(SRC)) {
    for (const site of importSites(await readFile(file, "utf8"))) {
      if (site.specifier === PI_TUI_PACKAGE || site.specifier.startsWith(`${PI_TUI_PACKAGE}/`)) {
        assert.equal(file, PI_TUI_ADAPTER, `${path.relative(SRC, file)} imports ${PI_TUI_PACKAGE}`);
      }
    }
  }
});

test("the import scanner sees static, side-effect, re-export and dynamic forms", () => {
  const sites = importSites(
    [
      'import { a } from "./a.ts";',
      "import type {",
      "  B,",
      '} from "../b.ts";',
      'export * from "./c.ts";',
      'import "./d.ts";',
      'const e = await import("./e.ts");',
      "const f = await import(name);",
    ].join("\n"),
  );
  assert.deepEqual(
    sites.map((site) => [site.specifier, site.dynamic, site.computed]),
    [
      ["./a.ts", false, false],
      ["../b.ts", false, false],
      ["./c.ts", false, false],
      ["./d.ts", false, false],
      ["./e.ts", true, false],
      ["name", true, true],
    ],
  );
});
