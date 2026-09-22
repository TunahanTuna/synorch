import { BRIDGE_STRIPPED_ENV } from "../contracts/index.ts";

/**
 * Child environments are built from an allowlist, never inherited wholesale: provider keys,
 * tokens and anything else in the parent environment stay out of tool processes unless named
 * here. Model-supplied variables may add values but never override loader or shell hooks.
 */
export const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "CI",
] as const;

const BLOCKED_OVERRIDE =
  /^(?:PATH|PATHEXT|LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PROMPT_COMMAND|PS\d|SHELLOPTS|BASHOPTS|IFS|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG\w*|GIT_ASKPASS|SSH_ASKPASS|SYSTEMROOT|COMSPEC|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;

export function isBlockedEnvName(name: string): boolean {
  const stripped: readonly string[] = BRIDGE_STRIPPED_ENV;
  return BLOCKED_OVERRIDE.test(name) || stripped.includes(name.toUpperCase()) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function childEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  const wanted = new Set<string>(INHERITED_ENV_ALLOWLIST.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && wanted.has(name.toLowerCase())) environment[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!isBlockedEnvName(name)) environment[name] = value;
  }
  return environment;
}
