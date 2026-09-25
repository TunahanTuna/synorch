import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PanelActionResult, PanelBlock, PanelItem, PanelPage } from "../../contracts/index.ts";

/**
 * Shared pieces of the panel adapters (`cli/panels/*`): run an existing slash handler and keep
 * its last line as the panel's status, browse a folder, show a file, open a file outside Synorch.
 * The adapters stay thin: the data and the actions are the text commands' own.
 */

/** Runs `handler` with a `print` that collects its lines; resolves the lines. */
export async function captured(handler: (print: (lines: readonly string[]) => void) => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  await handler((printed) => lines.push(...printed));
  return lines;
}

/**
 * An action result from a text handler's output: its last line becomes the status line (and the
 * one line the transcript gets, through `note`), the page reloads.
 */
export function outcome(lines: readonly string[], note: ((line: string) => void) | undefined, extra: Partial<PanelActionResult> = {}): PanelActionResult {
  const last = [...lines].reverse().find((line) => line.trim() !== "") ?? "done";
  const failed = /^(no |not |unknown|error|sign-in .* did not)/i.test(last);
  if (!failed) note?.(last);
  return { message: last, level: failed ? "warning" : "success", refresh: true, ...extra };
}

const GUI_EDITORS = new Set(["code", "code-insiders", "cursor", "codium", "windsurf", "zed", "subl", "sublime_text", "atom", "notepad", "notepad++", "gedit", "kate", "mate", "idea", "webstorm", "fleet", "gvim", "mvim"]);

/**
 * Opens a file for the user without leaving the TUI: a graphical `$VISUAL` / `$EDITOR` (VS Code,
 * Cursor, Zed, Sublime…), else the system's default application. A terminal editor (vim, nano) is
 * never started here: it would fight the TUI for the terminal. Resolves a line for the status bar.
 */
export async function openFile(file: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): Promise<string> {
  const editor = (env.VISUAL ?? env.EDITOR ?? "").trim();
  const words = editor.split(/\s+/).filter((word) => word !== "" && word !== "--wait" && word !== "-w");
  const program = words[0];
  const base = program === undefined ? "" : path.basename(program).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (program !== undefined && GUI_EDITORS.has(base)) {
    const windows = platform === "win32";
    const args = [...words.slice(1), windows ? `"${file}"` : file];
    if (await launch(windows ? `"${program}"` : program, args, windows)) return `opened in ${base}: ${file}`;
  }
  const system = platform === "win32" ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", file] } : platform === "darwin" ? { command: "open", args: [file] } : { command: "xdg-open", args: [file] };
  if (env.SSH_CONNECTION === undefined && env.SSH_TTY === undefined && (await launch(system.command, system.args, false))) return `opened ${file}`;
  return `open it yourself: ${file} (set VISUAL to a graphical editor such as code)`;
}

function launch(command: string, args: readonly string[], shell: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true, shell });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const MAX_FILES = 300;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".venv", "dist"]);

/** Files under `dir` (relative paths, sorted, at most 300, four levels deep, VCS and dependency folders skipped). */
export async function listFiles(dir: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, level: number): Promise<void> => {
    if (out.length >= MAX_FILES || level > depth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(full, level + 1);
      } else if (entry.isFile()) out.push(path.relative(dir, full));
    }
  };
  await walk(dir, 0);
  return out;
}

const MAX_SHOWN_BYTES = 256 * 1024;

/** A file as panel blocks: markdown rendered, other text verbatim, binary and huge files described. */
export async function fileBlocks(file: string): Promise<PanelBlock[]> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    return [{ kind: "text", text: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, tone: "warning" }];
  }
  const bytes = await readFile(file).catch(() => undefined);
  if (bytes === undefined) return [{ kind: "text", text: `cannot read ${file}`, tone: "warning" }];
  const head = bytes.subarray(0, MAX_SHOWN_BYTES);
  if (head.includes(0)) return [{ kind: "fields", rows: [{ label: "file", value: file }, { label: "size", value: `${size} bytes` }] }, { kind: "text", text: "binary file: press o to open it", tone: "muted" }];
  const text = head.toString("utf8");
  const blocks: PanelBlock[] = [/\.(md|markdown|mdx)$/i.test(file) ? { kind: "markdown", text } : { kind: "code", text }];
  if (size > MAX_SHOWN_BYTES) blocks.push({ kind: "text", text: `… showing the first ${MAX_SHOWN_BYTES / 1024} KB of ${Math.round(size / 1024)} KB`, tone: "muted" });
  return blocks;
}

/** A file's page with `o` to open it outside. */
export function filePage(file: string, crumb: string, env: Readonly<Record<string, string | undefined>>): () => Promise<PanelPage> {
  return async () => ({
    title: crumb,
    crumb,
    subtitle: file,
    views: [{ kind: "document", label: crumb, blocks: await fileBlocks(file) }],
    actions: [{ key: "o", label: "open file", run: async () => ({ message: await openFile(file, env) }) }],
  });
}

/** The items of a folder listing, each opening its file page. */
export async function folderItems(dir: string, env: Readonly<Record<string, string | undefined>>): Promise<PanelItem[]> {
  const files = await listFiles(dir);
  return files.map((relative) => {
    const full = path.join(dir, relative);
    return {
      id: relative,
      label: relative.split(path.sep).join("/"),
      open: filePage(full, path.basename(relative), env),
      actions: [{ key: "o", label: "open file", run: async () => ({ message: await openFile(full, env) }) }],
    };
  });
}

/** `12 items` / `1 item`. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}
