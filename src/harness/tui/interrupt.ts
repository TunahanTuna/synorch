/**
 * Ctrl+C / Esc semantics (ADR-04, CLI contract §3). The first Ctrl+C cancels the active request;
 * once nothing is left to cancel it offers a safe exit, and a further Ctrl+C inside the
 * confirmation window exits. Esc only ever cancels. The machine is pure so every renderer (raw-mode
 * TUI keys, SIGINT in plain and JSONL modes) shares exactly the same behaviour.
 */

export type InterruptKey = "ctrl+c" | "escape";
export type InterruptAction = "cancel-request" | "offer-exit" | "exit" | "none";

export const EXIT_CONFIRMATION_WINDOW_MS = 2000;

export class InterruptController {
  private active = false;
  private cancelRequested = false;
  private exitOfferedAt: number | undefined;
  private readonly windowMs: number;

  public constructor(windowMs: number = EXIT_CONFIRMATION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  public get requestActive(): boolean {
    return this.active;
  }

  /** Called when a turn or model request settles or continues; `begin` marks a new one, re-arming cancellation. */
  public setActive(active: boolean, begin = false): void {
    if (active && (begin || !this.active)) this.cancelRequested = false;
    this.active = active;
    if (!active) this.cancelRequested = false;
    if (active) this.exitOfferedAt = undefined;
  }

  public press(key: InterruptKey, now: number): InterruptAction {
    if (this.active && !this.cancelRequested) {
      this.cancelRequested = true;
      this.exitOfferedAt = undefined;
      return "cancel-request";
    }
    if (key === "escape") return "none";
    if (this.exitOfferedAt !== undefined && now - this.exitOfferedAt <= this.windowMs) {
      this.exitOfferedAt = undefined;
      return "exit";
    }
    this.exitOfferedAt = now;
    return "offer-exit";
  }
}

export const INTERRUPT_NOTICES = {
  cancelled: "Cancelling the active request (Ctrl+C again offers a safe exit).",
  offerExit: "Press Ctrl+C again to exit safely.",
} as const;
