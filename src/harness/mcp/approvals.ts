import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Project MCP servers are repository content: each is spawned only after the user approved exactly
 * that definition (digest) for exactly that workspace root. Stored in the user scope
 * (`<synorch home>/mcp-approvals.json`), never in a repository.
 */

export const MCP_APPROVALS_FILE = "mcp-approvals.json";

const fileSchema = z.strictObject({
  schema_version: z.literal(1),
  approvals: z.array(z.strictObject({ root: z.string().min(1), name: z.string().min(1), digest: z.string().min(1), approved_at: z.string().min(1) })).max(4096),
});
type ApprovalsFile = z.infer<typeof fileSchema>;

export interface McpApprovalStore {
  readonly file: string;
  isApproved(root: string, name: string, digest: string): boolean;
  approve(root: string, name: string, digest: string): Promise<void>;
  revoke(root: string, name: string): Promise<boolean>;
}

export function createMcpApprovalStore(home: string, now: () => Date = () => new Date()): McpApprovalStore {
  const file = path.join(path.resolve(home), MCP_APPROVALS_FILE);
  const read = (): ApprovalsFile => {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or unreadable: nothing is approved.
    }
    return { schema_version: 1, approvals: [] };
  };
  const persist = async (data: ApprovalsFile): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };
  return {
    file,
    isApproved: (root, name, digest) => read().approvals.some((entry) => entry.root === root && entry.name === name && entry.digest === digest),
    async approve(root, name, digest) {
      const data = read();
      const approvals = data.approvals.filter((entry) => !(entry.root === root && entry.name === name));
      approvals.push({ root, name, digest, approved_at: now().toISOString() });
      await persist({ schema_version: 1, approvals });
    },
    async revoke(root, name) {
      const data = read();
      const approvals = data.approvals.filter((entry) => !(entry.root === root && entry.name === name));
      if (approvals.length === data.approvals.length) return false;
      await persist({ schema_version: 1, approvals });
      return true;
    },
  };
}
