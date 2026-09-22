/**
 * A deliberately small reader for the shell strings a command can smuggle in (`bash -c`, `cmd /c`,
 * `powershell -Command`). It does not evaluate anything: it splits a script into pipelines and
 * words so every inner command can be classified like a top-level argv. Anything it cannot see
 * through (substitutions, script blocks) is reported so the classifier can stay conservative.
 */

export interface ShellScript {
  /** Pipelines in source order; each pipeline is the argv of every command piped together. */
  readonly pipelines: readonly (readonly (readonly string[])[])[];
  readonly substitution: boolean;
  readonly redirection: boolean;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function programName(token: string): string {
  const base = token.replaceAll("\\", "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

export type ShellDialect = "posix" | "cmd" | "powershell";

/**
 * Splits a script into pipelines of words. Escapes follow the dialect: backslash for POSIX
 * shells, caret for cmd, backtick for PowerShell; elsewhere a backslash is a path separator.
 */
export function parseShellScript(script: string, dialect: ShellDialect = "posix"): ShellScript {
  const escape = dialect === "posix" ? "\\" : dialect === "cmd" ? "^" : "`";
  const pipelines: string[][][] = [];
  let pipeline: string[][] = [];
  let command: string[] = [];
  let token = "";
  let started = false;
  let quote: "" | "'" | '"' = "";
  let substitution = false;
  let redirection = false;
  let dropNextWord = false;

  const endToken = (): void => {
    if (started) {
      if (dropNextWord) dropNextWord = false;
      else command.push(token);
    }
    token = "";
    started = false;
  };
  const endCommand = (): void => {
    endToken();
    const words = dropAssignments(command);
    if (words.length > 0) pipeline.push(words);
    command = [];
  };
  const endPipeline = (): void => {
    endCommand();
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] ?? "";
    const next = script[index + 1] ?? "";
    if (quote === "'") {
      if (character === "'") quote = "";
      else token += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = "";
      else if (character === escape && dialect !== "cmd" && next.length > 0 && (dialect === "powershell" || '"\\$`'.includes(next))) {
        token += next;
        index += 1;
      } else {
        if (character === "$" && next === "(") substitution = true;
        if (character === "`" && dialect === "posix") substitution = true;
        token += character;
      }
      continue;
    }
    if (character === escape && next.length > 0) {
      if (next !== "\n") token += next;
      started = true;
      index += 1;
    } else if (character === "'" && dialect === "cmd") {
      token += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === " " || character === "\t" || character === "\r") {
      endToken();
    } else if (character === "\n" || character === ";") {
      endPipeline();
    } else if (character === "&") {
      if (next === "&") index += 1;
      endPipeline();
    } else if (character === "|") {
      if (next === "|") {
        index += 1;
        endPipeline();
      } else endCommand();
    } else if (character === ">" || character === "<") {
      if (character === "<" && next === "(") {
        substitution = true;
        endPipeline();
        index += 1;
        continue;
      }
      if (/^\d+$/.test(token)) {
        token = "";
        started = false;
      }
      endToken();
      if (character === ">") redirection = true;
      while (script[index + 1] === ">") index += 1;
      if (script[index + 1] === "&") {
        index += 1;
        while (/[\d-]/.test(script[index + 1] ?? "")) index += 1;
        continue;
      }
      dropNextWord = true;
    } else if (character === "(" || character === ")" || character === "`" || character === "{" || character === "}") {
      if (character === "(" && token.endsWith("$")) token = token.slice(0, -1);
      if (character !== "}" && character !== ")") substitution = true;
      endPipeline();
    } else {
      token += character;
      started = true;
    }
  }
  endPipeline();
  return { pipelines, substitution, redirection };
}

function dropAssignments(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length - 1 && ASSIGNMENT.test(words[index] ?? "")) index += 1;
  return words.slice(index);
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "csh", "tcsh"]);
const POWERSHELLS = new Set(["powershell", "pwsh", "powershell_ise"]);
const POWERSHELL_VALUE_FLAGS = new Set([
  "-executionpolicy",
  "-ex",
  "-ep",
  "-windowstyle",
  "-w",
  "-inputformat",
  "-if",
  "-outputformat",
  "-of",
  "-o",
  "-version",
  "-v",
  "-workingdirectory",
  "-wd",
  "-configurationname",
  "-settingsfile",
  "-psconsolefile",
]);

/** What a shell program will run: an inline script, a file (or stdin), or something unreadable. */
export type InlineScript =
  | { readonly kind: "script"; readonly text: string }
  | { readonly kind: "file" }
  | { readonly kind: "opaque"; readonly reason: string };

/**
 * The inline script a shell program runs: `-c`/`/c`/`-Command`/`-EncodedCommand` (every
 * abbreviation), `file` for a shell that runs a file or reads stdin, `opaque` when the script
 * cannot be read (an undecodable encoded command), `undefined` for a program that is no shell.
 */
export function inlineScriptOf(program: string, args: readonly string[]): InlineScript | undefined {
  if (POSIX_SHELLS.has(program)) return orFile(posixInlineScript(args));
  if (program === "cmd") return orFile(cmdInlineScript(args));
  if (POWERSHELLS.has(program)) return powershellInlineScript(args);
  return undefined;
}

function orFile(script: string | null): InlineScript {
  return script === null ? { kind: "file" } : { kind: "script", text: script };
}

export function shellDialect(program: string): ShellDialect {
  if (program === "cmd") return "cmd";
  return POWERSHELLS.has(program) ? "powershell" : "posix";
}

export function isShellProgram(program: string): boolean {
  return POSIX_SHELLS.has(program) || POWERSHELLS.has(program) || program === "cmd";
}

function posixInlineScript(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument)) return args[index + 1] ?? "";
    if (argument === "-o" || argument === "+o") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-") || argument.startsWith("+")) continue;
    return null;
  }
  return null;
}

function cmdInlineScript(args: readonly string[]): string | null {
  const index = args.findIndex((argument) => /^\/[ckr]/i.test(argument));
  if (index === -1) return null;
  const first = (args[index] ?? "").slice(2);
  const script = [first, ...args.slice(index + 1)].filter((part) => part.length > 0).join(" ").trim();
  return script.length >= 2 && script.startsWith('"') && script.endsWith('"') ? script.slice(1, -1) : script;
}

/** PowerShell accepts en dash, em dash and horizontal bar wherever it accepts `-`. */
export function normalizeDash(argument: string): string {
  return DASH_CODES.has(argument.charCodeAt(0)) ? `-${argument.slice(1)}` : argument;
}

function powershellInlineScript(args: readonly string[]): InlineScript {
  for (let index = 0; index < args.length; index += 1) {
    const argument = normalizeDash(args[index] ?? "");
    const lower = argument.toLowerCase().replace(/^\//, "-");
    if (!lower.startsWith("-")) return { kind: "script", text: args.slice(index).join(" ") };
    if (lower === "-") return { kind: "file" };
    if (lower.includes(":")) return { kind: "opaque", reason: `PowerShell parameter ${argument} carries an attached value` };
    if (POWERSHELL_VALUE_FLAGS.has(lower) || isPrefixOf(lower, "-executionpolicy", 3) || isPrefixOf(lower, "-encodedarguments", 9) || lower === "-ea") {
      index += 1;
      continue;
    }
    if (lower.startsWith("-e")) return decodeEncodedCommand(args[index + 1]);
    if (lower === "-cwa" || isPrefixOf(lower, "-commandwithargs", 9)) return { kind: "script", text: args[index + 1] ?? "" };
    if (isPrefixOf(lower, "-command", 2)) return { kind: "script", text: args.slice(index + 1).join(" ") };
    if (isPrefixOf(lower, "-file", 2)) return { kind: "file" };
  }
  return { kind: "file" };
}

function isPrefixOf(value: string, full: string, minimum: number): boolean {
  return value.length >= minimum && full.startsWith(value);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DASH_CODES = new Set([0x2013, 0x2014, 0x2015]);
const REPLACEMENT_CHARACTER = 0xfffd;

function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32) || code === REPLACEMENT_CHARACTER) return true;
  }
  return false;
}

/** `-EncodedCommand` is UTF-16LE base64; anything that does not decode cleanly is opaque. */
function decodeEncodedCommand(value: string | undefined): InlineScript {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64.test(trimmed)) return { kind: "opaque", reason: "the encoded command is not valid base64" };
  const bytes = Buffer.from(trimmed, "base64");
  const text = bytes.toString("utf16le");
  if (bytes.length % 2 !== 0 || hasControlCharacters(text)) {
    return { kind: "opaque", reason: "the encoded command is not UTF-16LE text" };
  }
  return { kind: "script", text };
}
