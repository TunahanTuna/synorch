/**
 * Line input for the plain renderer. It splits on LF only (a trailing CR is dropped), never uses
 * `readline` (U+2028/U+2029 would split a line) and never echoes. Secrets are read in raw mode
 * when the input is a TTY, so the typed characters are not shown.
 */

export interface InputStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

type Waiter = { readonly resolve: (line: string | undefined) => void; readonly reject: (error: Error) => void };

export class LineSource {
  private readonly input: InputStream;
  private readonly lines: string[] = [];
  private readonly waiters: Waiter[] = [];
  private buffer = "";
  private ended = false;
  private attached = false;
  private secretHandler: ((chunk: string) => void) | undefined;
  private readonly onData = (chunk: string | Buffer): void => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  private readonly onEnd = (): void => this.finish();

  public constructor(input: InputStream) {
    this.input = input;
  }

  public get interactive(): boolean {
    return this.input.isTTY === true;
  }

  /** Resolves with the next line, or undefined once the input has ended. */
  public next(signal: AbortSignal): Promise<string | undefined> {
    this.attach();
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (line) => {
          signal.removeEventListener("abort", onAbort);
          resolve(line);
        },
        reject,
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new DOMException("The input request was aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Reads one line without echo when the input is a TTY; Ctrl+C rejects with an AbortError. */
  public readSecret(signal: AbortSignal): Promise<string> {
    if (!this.interactive || this.input.setRawMode === undefined) {
      return this.next(signal).then((line) => {
        if (line === undefined) throw new DOMException("The input ended before a secret was entered", "AbortError");
        return line;
      });
    }
    this.attach();
    this.input.setRawMode(true);
    return new Promise((resolve, reject) => {
      let secret = "";
      const done = (error: Error | undefined): void => {
        this.secretHandler = undefined;
        this.input.setRawMode?.(false);
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(secret);
        else reject(error);
      };
      const onAbort = (): void => done(new DOMException("The secret prompt was aborted", "AbortError"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.secretHandler = (chunk) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") return done(undefined);
          if (character === "\u0003" || character === "\u0004") return done(new DOMException("The secret prompt was cancelled", "AbortError"));
          if (character === "\u007f" || character === "\b") secret = [...secret].slice(0, -1).join("");
          else if (character >= " ") secret += character;
        }
      };
    });
  }

  public close(): void {
    if (!this.attached) return;
    this.attached = false;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.pause?.();
  }

  private attach(): void {
    if (this.attached || this.ended) return;
    this.attached = true;
    this.input.setEncoding?.("utf8");
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.resume?.();
  }

  private receive(chunk: string): void {
    if (this.secretHandler !== undefined) {
      this.secretHandler(chunk);
      return;
    }
    const parts = (this.buffer + chunk).split("\n");
    this.buffer = parts.pop() ?? "";
    for (const part of parts) this.deliver(part.replace(/\r$/, ""));
  }

  private finish(): void {
    this.ended = true;
    if (this.buffer.length > 0) this.deliver(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.lines.push(line);
    else waiter.resolve(line);
  }
}
