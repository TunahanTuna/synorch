import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * `/allow <command prefix>` (ADR-21, orchestrator decision 1): the user extends the conversation
 * agent's exec allowlist for one workspace. Grants live only in the user scope
 * (`<synorch home>/command-grants.json`, keyed by the canonical workspace root the trust store
 * uses), so nothing in the repository can grant them, and the Synorch home is unwritable for every
 * tool. A grant never relaxes a hard rail, a destructive-command rule, a git mutation refusal or
 * workspace trust; each one is audited as `command/allowed` in the conversation log.
 */

export const COMMAND_GRANTS_FILE = "command-grants.json";
const MAX_GRANTS = 256;

const grantsFileSchema = z.strictObject({
  schema_version: z.literal(1),
  workspaces: z.record(z.string(), z.array(z.string().min(1).max(500)).max(MAX_GRANTS)),
});

/** Programs a prefix may not be just the name of: they would grant any script or any command. */
const TOO_BROAD = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "env", "sudo", "doas", "xargs", "npx", "pnpx", "bunx"]);
const PLAIN_WORD = /^[A-Za-z0-9._+\-=:/@\\]+$/;

export interface CommandGrantStore {
  readonly file: string;
  list(): Promise<readonly string[]>;
  add(prefix: string): Promise<readonly string[]>;
  remove(prefix: string): Promise<readonly string[]>;
}

/** The normalized prefix (single spaces), or why it cannot be granted. */
export function normalizeGrant(raw: string): { readonly prefix: string } | { readonly error: string } {
  const words = raw.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return { error: "type the command prefix to allow, for example /allow node check.mjs" };
  const bad = words.find((word) => !PLAIN_WORD.test(word));
  if (bad !== undefined) return { error: `${bad} is not a plain word; /allow takes the program and its leading arguments exactly as the agent would pass them (no quotes, pipes or shell syntax)` };
  const program = (words[0] ?? "").replaceAll("\\", "/").split("/").pop()?.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "") ?? "";
  if (words.length === 1 && TOO_BROAD.has(program)) return { error: `allowing every ${program} command would allow anything; name the script too, for example /allow ${program} scripts/build.sh` };
  if (program === "git") return { error: "git commands are not granted: read-only git already runs, and git history changes stay with you" };
  return { prefix: words.join(" ") };
}

export function createCommandGrantStore(home: string, workspaceKey: string): CommandGrantStore {
  const file = path.join(home, COMMAND_GRANTS_FILE);
  const read = async (): Promise<z.infer<typeof grantsFileSchema>> => {
    try {
      const parsed = grantsFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      return parsed.success ? parsed.data : { schema_version: 1, workspaces: {} };
    } catch {
      return { schema_version: 1, workspaces: {} };
    }
  };
  const write = async (data: z.infer<typeof grantsFileSchema>): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    file,
    async list() {
      return (await read()).workspaces[workspaceKey] ?? [];
    },
    async add(prefix) {
      const data = await read();
      const current = data.workspaces[workspaceKey] ?? [];
      if (current.includes(prefix)) return current;
      const next = [...current, prefix].slice(-MAX_GRANTS);
      await write({ schema_version: 1, workspaces: { ...data.workspaces, [workspaceKey]: next } });
      return next;
    },
    async remove(prefix) {
      const data = await read();
      const next = (data.workspaces[workspaceKey] ?? []).filter((entry) => entry !== prefix);
      await write({ schema_version: 1, workspaces: { ...data.workspaces, [workspaceKey]: next } });
      return next;
    },
  };
}
