import { HarnessError, type AuthInteraction, type AuthNotice, type DeviceCodePrompt } from "../contracts/index.ts";
import type { LineSource } from "./line-source.ts";
import { openBrowser, type BrowserEnvironment, type BrowserLauncher } from "./open-browser.ts";
import { sanitizeInline } from "./sanitize.ts";

/**
 * `AuthInteraction` for the plain and JSONL renderers. Every message goes to stderr so JSONL stdout
 * stays pure. Without a terminal a secret can never be prompted (the flow fails with
 * `auth_required`) and a notice that needs acknowledgement is never acknowledged on the user's behalf.
 */

export function deviceCodeText(prompt: DeviceCodePrompt): string {
  return `To sign in, open ${prompt.verificationUri} and enter the code ${prompt.userCode} (expires ${prompt.expiresAt}).\n`;
}

export class HeadlessAuthInteraction implements AuthInteraction {
  public readonly interactive = false;
  private readonly stderr: (text: string) => void;

  public constructor(stderr: (text: string) => void) {
    this.stderr = stderr;
  }

  public async openBrowser(url: string): Promise<boolean> {
    this.stderr(`Open this URL in a browser: ${url}\n`);
    return false;
  }

  public showDeviceCode(prompt: DeviceCodePrompt): void {
    this.stderr(deviceCodeText(prompt));
  }

  public async promptSecret(label: string, _signal: AbortSignal): Promise<string> {
    throw new HarnessError({
      code: "auth_required",
      message: `${sanitizeInline(label, 100)} cannot be prompted without an interactive terminal`,
      workspace_effect: "none",
      retry_safe: true,
      next_command: "run the same `syn login` command in an interactive terminal",
    });
  }

  public async acknowledge(notice: AuthNotice, _signal: AbortSignal): Promise<boolean> {
    this.stderr(`notice: ${notice.text}\n`);
    return !notice.requiresAcknowledgement;
  }

  public notify(message: string): void {
    this.stderr(`${sanitizeInline(message, 1000)}\n`);
  }
}

export interface LineAuthInteractionOptions {
  readonly lines: LineSource;
  readonly write: (text: string) => void;
  readonly environment: BrowserEnvironment;
  readonly launch?: BrowserLauncher;
}

export class LineAuthInteraction implements AuthInteraction {
  public readonly interactive = true;
  private readonly options: LineAuthInteractionOptions;

  public constructor(options: LineAuthInteractionOptions) {
    this.options = options;
  }

  public async openBrowser(url: string): Promise<boolean> {
    this.options.write(`Open this URL in a browser: ${url}\n`);
    return openBrowser(url, this.options.environment, this.options.launch);
  }

  public showDeviceCode(prompt: DeviceCodePrompt): void {
    this.options.write(deviceCodeText(prompt));
  }

  public async promptSecret(label: string, signal: AbortSignal): Promise<string> {
    this.options.write(`${sanitizeInline(label, 100)}: `);
    try {
      return await this.options.lines.readSecret(signal);
    } finally {
      this.options.write("\n");
    }
  }

  public async acknowledge(notice: AuthNotice, signal: AbortSignal): Promise<boolean> {
    this.options.write(`notice: ${notice.text}\n`);
    if (!notice.requiresAcknowledgement) return true;
    this.options.write("Continue? [y/N] ");
    const answer = await this.options.lines.next(signal);
    return answer !== undefined && /^\s*y(es)?\s*$/i.test(answer);
  }

  public notify(message: string): void {
    this.options.write(`${sanitizeInline(message, 1000)}\n`);
  }
}
