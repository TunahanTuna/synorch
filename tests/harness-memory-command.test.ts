import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createId,
  deriveProjectId,
  EXIT_CODES,
  memoryNoteFrontmatterSchema,
  memoryProposalSchema,
  type CommandIO,
  type MemoryNoteFrontmatter,
  type TerminalRenderer,
} from "../src/harness/contracts/index.ts";
import { createMemoryCommand, createMemoryStore, obsidianOpenUri, readGitBranch, type ObsidianLauncher } from "../src/harness/memory/index.ts";

const NOW = new Date("2026-09-22T12:00:00Z");

const renderer: TerminalRenderer = {
  kind: "plain",
  input: undefined,
  start: async () => {},
  render: () => {},
  stop: async () => {},
  approvals: {
    availability: "headless",
    request: async () => {
      throw new Error("no approvals in memory commands");
    },
  },
  auth: {
    interactive: false,
    openBrowser: async () => false,
    showDeviceCode: () => {},
    promptSecret: async () => {
      throw new Error("no secrets in memory commands");
    },
    acknowledge: async () => false,
    notify: () => {},
  },
};

interface Harness {
  readonly base: string;
  readonly home: string;
  readonly workspace: string;
  readonly root: string;
  readonly projectId: string;
  readonly launcher: ObsidianLauncher & { readonly opened: string[] };
  run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

async function harness(obsidianInstalled = false): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), "syn-memory-cli-"));
  const home = path.join(base, "home");
  const workspace = path.join(base, "repo");
  await mkdir(workspace, { recursive: true });
  const projectId = deriveProjectId(workspace, process.platform);
  const opened: string[] = [];
  const launcher = {
    opened,
    available: async () => obsidianInstalled,
    open: async (uri: string) => {
      opened.push(uri);
      return true;
    },
  };
  const command = createMemoryCommand({ home, obsidian: launcher, now: () => NOW });
  return {
    base,
    home,
    workspace,
    root: path.join(home, ".synorch", "memory", projectId),
    projectId,
    launcher,
    async run(args) {
      let stdout = "";
      let stderr = "";
      const io: CommandIO = {
        cwd: workspace,
        env: {},
        renderer,
        signal: new AbortController().signal,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      };
      const code = await command(args, io);
      return { code, stdout, stderr };
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function frontmatter(projectId: string, overrides: Partial<Record<keyof MemoryNoteFrontmatter, unknown>>): MemoryNoteFrontmatter {
  return memoryNoteFrontmatterSchema.parse({
    schema_version: 1,
    project_id: projectId,
    scope: "project",
    created_at: "2026-09-22",
    confidence: "medium",
    owner: "synorch",
    relations: [],
    ...overrides,
  });
}

async function seed(h: Harness): Promise<void> {
  const store = createMemoryStore(h.root);
  await store.persist(
    { frontmatter: frontmatter(h.projectId, { id: "cpt-memory-architecture", kind: "concept", status: "active", tags: ["memory"] }), title: "Memory architecture", body: "Plain Markdown vault, Obsidian optional." },
    undefined,
  );
  await store.persist(
    { frontmatter: frontmatter(h.projectId, { id: "asm-memory-in-repo", kind: "assumption", status: "open" }), title: "Memory in repo", body: "Assumes the vault is inside the repository." },
    undefined,
  );
}

test("AC-1 syn memory search/show work with Obsidian absent and default root under the injected home", async () => {
  const h = await harness(false);
  try {
    await seed(h);
    const search = await h.run(["search", "obsidian", "optional"]);
    assert.equal(search.code, EXIT_CODES.success, search.stderr);
    assert.match(search.stdout, /cpt-memory-architecture {2}concept\/active {2}Memory architecture/);
    const show = await h.run(["show", "cpt-memory-architecture"]);
    assert.equal(show.code, EXIT_CODES.success);
    assert.match(show.stdout, /# Memory architecture\n\nPlain Markdown vault, Obsidian optional\./);
    assert.ok(show.stdout.includes(path.join(h.root, "concepts", "cpt-memory-architecture.md")));
  } finally {
    await h.cleanup();
  }
});

test("AC-1 open --in obsidian falls back to the CLI when Obsidian is not installed", async () => {
  const h = await harness(false);
  try {
    await seed(h);
    const result = await h.run(["open", "cpt-memory-architecture", "--in", "obsidian"]);
    assert.equal(result.code, EXIT_CODES.success);
    assert.match(result.stdout, /Obsidian is not available; showing the note here\./);
    assert.match(result.stdout, /uri: obsidian:\/\/open\?path=/);
    assert.match(result.stdout, /# Memory architecture/);
    assert.deepEqual(h.launcher.opened, []);
    assert.ok(!(await readdir(h.root)).includes(".obsidian"));
  } finally {
    await h.cleanup();
  }
});

test("open --in obsidian only hands an obsidian:// URI to the OS when Obsidian is installed", async () => {
  const h = await harness(true);
  try {
    await seed(h);
    const result = await h.run(["open", "cpt-memory-architecture", "--in", "obsidian"]);
    assert.equal(result.code, EXIT_CODES.success);
    const expected = obsidianOpenUri(path.join(h.root, "concepts", "cpt-memory-architecture.md"));
    assert.deepEqual(h.launcher.opened, [expected]);
    assert.match(expected, /^obsidian:\/\/open\?path=[^&\s]+$/);
    assert.equal(decodeURIComponent(expected.slice("obsidian://open?path=".length)), path.join(h.root, "concepts", "cpt-memory-architecture.md"));
    const unsupported = await h.run(["open", "cpt-memory-architecture", "--in", "vscode"]);
    assert.equal(unsupported.code, EXIT_CODES.usage);
  } finally {
    await h.cleanup();
  }
});

test("AC-3 syn memory review/accept/reject drive the queue as the user", async () => {
  const h = await harness();
  try {
    await seed(h);
    const store = createMemoryStore(h.root);
    const run = createId("run", NOW.getTime());
    const decision = memoryProposalSchema.parse({
      schema_version: 1,
      proposal_id: createId("proposal", NOW.getTime()),
      kind: "note",
      note: frontmatter(h.projectId, { id: "dec-0042", kind: "decision", status: "proposed" }),
      body: "# Memory lives under ~/.synorch",
      rationale: "ADR-16 accepted.",
      evidence: [{ kind: "file", ref: "docs/harness/decisions/ADR-16-memory-location.md", produced_by: "orchestrator" }],
      created_by: { run_id: run },
      created_at: NOW.toISOString(),
      state: "pending",
    });
    const contradiction = memoryProposalSchema.parse({
      ...decision,
      proposal_id: createId("proposal", NOW.getTime() + 1),
      kind: "contradiction",
      note: undefined,
      body: undefined,
      target: "cpt-memory-architecture",
      relation: { type: "contradicts", target: "asm-memory-in-repo" },
      rationale: "Model thinks these conflict.",
    });
    await store.propose(decision);
    await store.propose(contradiction);

    const review = await h.run(["review"]);
    assert.match(review.stdout, new RegExp(`${decision.proposal_id} {2}\\[note\\] new decision dec-0042`));
    assert.match(review.stdout, /\[contradiction\] cpt-memory-architecture contradicts asm-memory-in-repo/);

    const accepted = await h.run(["accept", decision.proposal_id, "--reason", "ADR-16"]);
    assert.equal(accepted.code, EXIT_CODES.success, accepted.stderr);
    assert.match(accepted.stdout, /accepted prop_\w+; wrote dec-0042 \(decisions\/dec-0042\.md\)/);
    const rejected = await h.run(["reject", contradiction.proposal_id]);
    assert.equal(rejected.code, EXIT_CODES.success);
    assert.equal((await h.run(["review"])).stdout, "review queue is empty\n");

    const shown = await h.run(["show", "dec-0042"]);
    assert.match(shown.stdout, /reviewed: 2026-09-22/);
    assert.deepEqual((await store.get(frontmatter(h.projectId, { id: "cpt-memory-architecture", kind: "concept", status: "active" }).id))?.frontmatter.relations, []);

    const again = await h.run(["accept", decision.proposal_id]);
    assert.equal(again.code, EXIT_CODES.usage);
    assert.match(again.stderr, /already accepted/);
  } finally {
    await h.cleanup();
  }
});

test("AC-4 syn memory reindex rebuilds a deleted index and lists broken links", async () => {
  const h = await harness();
  try {
    await seed(h);
    await writeFile(
      path.join(h.root, "concepts", "cpt-dangling.md"),
      `---\nschema_version: 1\nid: cpt-dangling\nkind: concept\nproject_id: ${h.projectId}\nscope: project\nstatus: active\ncreated_at: 2026-09-22\nconfidence: low\nowner: human\nrelations: []\n---\n\n# Dangling\n\n[missing](nope.md)\n`,
      "utf8",
    );
    await writeFile(path.join(h.root, "concepts", "broken.md"), "no frontmatter here\n", "utf8");
    await rm(path.join(h.root, ".index"), { recursive: true, force: true });
    const result = await h.run(["reindex"]);
    assert.equal(result.code, EXIT_CODES.success);
    assert.match(result.stdout, /^indexed 3 notes; 1 broken links\n {2}broken link: concepts\/cpt-dangling\.md -> concepts\/nope\.md\n {2}invalid note: concepts\/broken\.md/);
  } finally {
    await h.cleanup();
  }
});

test("syn memory status and related summarise the vault", async () => {
  const h = await harness();
  try {
    await seed(h);
    const status = await h.run(["status"]);
    assert.equal(status.code, EXIT_CODES.success);
    assert.match(status.stdout, /0 geçerli karar, 1 açık varsayım, 0 açık soru, 0 olası çelişki/);
    assert.match(status.stdout, /notes: 2\n {2}assumption: 1 open\n {2}concept: 1 active/);
    assert.match(status.stdout, /pending review: 0/);
    const related = await h.run(["related", "cpt-memory-architecture"]);
    assert.equal(related.code, EXIT_CODES.success);
    assert.match(related.stdout, /relations: none/);
  } finally {
    await h.cleanup();
  }
});

test("AC-6 syn memory search honours --branch against branch-scoped notes", async () => {
  const h = await harness();
  try {
    const store = createMemoryStore(h.root);
    await store.persist(
      { frontmatter: frontmatter(h.projectId, { id: "cpt-harness-only", kind: "concept", status: "active", scope: "branch", branch: "harness" }), title: "Harness only", body: "runtime layout" },
      undefined,
    );
    assert.equal((await h.run(["search", "runtime", "--branch", "main"])).stdout, "no matching memory\n");
    assert.match((await h.run(["search", "runtime", "--branch", "harness"])).stdout, /cpt-harness-only/);
    assert.match((await h.run(["search", "runtime", "--branch", "main", "--all"])).stdout, /\[STALE\].*\n.*not current here/);
  } finally {
    await h.cleanup();
  }
});

test("usage errors exit 2, unknown ids exit 1, and help exits 0", async () => {
  const h = await harness();
  try {
    assert.equal((await h.run([])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["frobnicate"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["search"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["search", "x", "--kind", "nonsense"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["search", "x", "--limit", "0"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["show", "not an id"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["accept", "prop_nope"])).code, EXIT_CODES.usage);
    assert.equal((await h.run(["show", "dec-0999"])).code, EXIT_CODES.internal);
    assert.equal((await h.run(["--bogus"])).code, EXIT_CODES.usage);
    const help = await h.run(["help"]);
    assert.equal(help.code, EXIT_CODES.success);
    assert.match(help.stdout, /syn memory <command>/);
    const unknownProposal = await h.run(["accept", createId("proposal")]);
    assert.equal(unknownProposal.code, EXIT_CODES.usage);
    assert.match(unknownProposal.stderr, /next: syn memory review/);
  } finally {
    await h.cleanup();
  }
});

test("readGitBranch reads HEAD of plain and worktree checkouts", async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.workspace, ".git"), { recursive: true });
    await writeFile(path.join(h.workspace, ".git", "HEAD"), "ref: refs/heads/harness\n", "utf8");
    await mkdir(path.join(h.workspace, "src"), { recursive: true });
    assert.equal(await readGitBranch(path.join(h.workspace, "src")), "harness");

    const worktree = path.join(h.base, "wt");
    const gitDir = path.join(h.base, "gitdirs", "wt");
    await mkdir(worktree, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/codex/harness-i6-memory\n", "utf8");
    assert.equal(await readGitBranch(worktree), "codex/harness-i6-memory");
    await writeFile(path.join(gitDir, "HEAD"), "0123456789abcdef0123456789abcdef01234567\n", "utf8");
    assert.equal(await readGitBranch(worktree), undefined);
  } finally {
    await h.cleanup();
  }
});
