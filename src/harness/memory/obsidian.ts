import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * The only Obsidian touch point: an `obsidian://open` URI handed to the operating system. No
 * Obsidian API, plugin, CLI or network call is involved, and every caller has a CLI fallback.
 */

export interface ObsidianLauncher {
  /** Best-effort check that the desktop app is installed; false means "show it in the CLI". */
  available(): Promise<boolean>;
  /** Hands the URI to the OS URL handler; resolves false when that could not be started. */
  open(uri: string): Promise<boolean>;
}

/** `obsidian://open?path=<absolute file>`: opens the file in whichever vault contains it. */
export function obsidianOpenUri(absoluteFile: string): string {
  return `obsidian://open?path=${encodeURIComponent(path.resolve(absoluteFile))}`;
}

function installCandidates(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  switch (platform) {
    case "win32":
      return [
        env.LOCALAPPDATA === undefined ? "" : path.win32.join(env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe"),
        env.ProgramFiles === undefined ? "" : path.win32.join(env.ProgramFiles, "Obsidian", "Obsidian.exe"),
      ];
    case "darwin":
      return ["/Applications/Obsidian.app", home === "" ? "" : path.posix.join(home, "Applications", "Obsidian.app")];
    default:
      return [
        ...(env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0).map((entry) => path.join(entry, "obsidian")),
        "/var/lib/flatpak/exports/bin/md.obsidian.Obsidian",
        home === "" ? "" : path.posix.join(home, ".local", "share", "flatpak", "exports", "bin", "md.obsidian.Obsidian"),
        "/snap/bin/obsidian",
        "/opt/Obsidian/obsidian",
      ];
  }
}

function urlHandler(platform: NodeJS.Platform, uri: string): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", uri] };
  if (platform === "darwin") return { command: "open", args: [uri] };
  return { command: "xdg-open", args: [uri] };
}

export function createSystemObsidianLauncher(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): ObsidianLauncher {
  return {
    async available(): Promise<boolean> {
      for (const candidate of installCandidates(env, platform)) {
        if (candidate.length === 0) continue;
        if (await stat(candidate).then(() => true, () => false)) return true;
      }
      return false;
    },
    open(uri: string): Promise<boolean> {
      const { command, args } = urlHandler(platform, uri);
      return new Promise((resolve) => {
        try {
          const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
          child.once("error", () => resolve(false));
          child.once("spawn", () => {
            child.unref();
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    },
  };
}
