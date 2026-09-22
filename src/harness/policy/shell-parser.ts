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

/**
 * The inline script a shell program runs: a string for `-c`/`/c`/`-Command`/`-EncodedCommand`,
 * `null` for a shell that runs a file or reads stdin, `undefined` for a program that is no shell.
 */
export function inlineScriptOf(program: string, args: readonly string[]): string | null | undefined {
  if (POSIX_SHELLS.has(program)) return posixInlineScript(args);
  if (program === "cmd") return cmdInlineScript(args);
  if (POWERSHELLS.has(program)) return powershellInlineScript(args);
  return undefined;
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
  const index = args.findIndex((argument) => /^\/[ck]/i.test(argument));
  if (index === -1) return null;
  const first = (args[index] ?? "").slice(2);
  const script = [first, ...args.slice(index + 1)].filter((part) => part.length > 0).join(" ").trim();
  return script.length >= 2 && script.startsWith('"') && script.endsWith('"') ? script.slice(1, -1) : script;
}

function powershellInlineScript(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const lower = argument.toLowerCase().replace(/^\//, "-");
    if (POWERSHELL_VALUE_FLAGS.has(lower)) {
      index += 1;
      continue;
    }
    if (lower.startsWith("-") && lower.length >= 2 && "-command".startsWith(lower)) {
      return args.slice(index + 1).join(" ");
    }
    if (lower.startsWith("-e") && lower.length >= 2 && "-encodedcommand".startsWith(lower)) {
      return decodeEncodedCommand(args[index + 1] ?? "");
    }
    if (lower.startsWith("-f") && lower.length >= 2 && "-file".startsWith(lower)) return null;
    if (lower.startsWith("-")) continue;
    return args.slice(index).join(" ");
  }
  return null;
}

function decodeEncodedCommand(value: string): string {
  return Buffer.from(value, "base64").toString("utf16le");
}
