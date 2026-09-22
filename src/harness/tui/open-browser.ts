import { spawn } from "node:child_process";

/**
 * Best-effort browser launch for `AuthInteraction.openBrowser`. Only http(s) URLs are opened, never
 * through a shell (no `cmd /c start`, whose metacharacters would reinterpret `&` in OAuth URLs), and
 * never over SSH, where the browser would open on the wrong machine. The URL is always printed too.
 */

export type BrowserLauncher = (command: string, args: readonly string[]) => Promise<boolean>;

export interface BrowserEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function browserCommand(url: string, environment: BrowserEnvironment): { readonly command: string; readonly args: readonly string[] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (environment.env.SSH_CONNECTION !== undefined || environment.env.SSH_TTY !== undefined) return undefined;
  const href = parsed.href;
  switch (environment.platform) {
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] };
    case "darwin":
      return { command: "open", args: [href] };
    default:
      if (environment.env.DISPLAY === undefined && environment.env.WAYLAND_DISPLAY === undefined) return undefined;
      return { command: "xdg-open", args: [href] };
  }
}

export const spawnBrowser: BrowserLauncher = (command, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

export async function openBrowser(url: string, environment: BrowserEnvironment, launch: BrowserLauncher = spawnBrowser): Promise<boolean> {
  const command = browserCommand(url, environment);
  if (command === undefined) return false;
  return launch(command.command, command.args);
}
