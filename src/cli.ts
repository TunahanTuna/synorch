#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import { DoctorService, type Diagnostic } from "./application/doctor-service.ts";
import { ProjectDiscoveryService } from "./application/project-discovery.ts";
import { StructureService } from "./application/structure-service.ts";
import { scopeSchema, type StructureScope } from "./domain/config.ts";
import { CliError } from "./domain/errors.ts";
import type { GenerationPlan } from "./domain/generation.ts";
import { versionLine } from "./infrastructure/build-info.ts";
import { closestMatch } from "./domain/suggest.ts";
import { NodeFileSystem } from "./infrastructure/file-system.ts";

const HELP = `syn — Synorch orchestration structure generator for Codex and Claude Code

Usage:
  syn inspect [--target <path>] [--scope workspace|repository]
  syn init [--target <path>] [--scope workspace|repository] [--force]
  syn sync [--target <path>] [--force] [--json]
  syn doctor [--target <path>] [--json]

Commands:
  inspect  Preview every generated file and conflict without writing.
  init     Create the canonical structure and provider entrypoints.
  sync     Discover projects after a manual trigger and refresh the registry.
  doctor   Validate structure, profiles and constitutional safety settings.

Runtime commands (syn <command> --help for details):
  agent             Interactive orchestrated session (--resume <session>, --fork <session>).
  run "<goal>"      Run one goal to completion; --mode jsonl writes machine frames.
  runs              List the runs of this project.
  show <id>         Plan, workers, approvals, evidence and usage of a run or session.
  doctor --runtime  Sandbox, store, auth and capability health; no network request.
  login, logout     Connect or remove a provider identity.
  auth status       Provider identities, without secrets.
  memory <command>  Project memory: status, search, show, review, accept, reject.
  trust [--revoke]  Trust this workspace's tests and build scripts to run unconfined.
  config <command>  User settings: list, get, set, unset, edit, path.

Safety:
  Existing differing files are never overwritten unless --force is explicit.
  Model fallback is never silent.
`;

const HARNESS_COMMAND_NAMES: readonly string[] = ["agent", "run", "runs", "show", "login", "logout", "auth", "memory", "trust", "config", "mcp", "skills", "plugin"];

const LEGACY_OPTIONS = {
  target: { type: "string", short: "t" },
  scope: { type: "string", short: "s" },
  force: { type: "boolean", short: "f", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

const LEGACY_COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  inspect: ["--target", "-t", "--scope", "-s", "--force", "-f", "--json", "--help", "-h"],
  init: ["--target", "-t", "--scope", "-s", "--force", "-f", "--json", "--help", "-h"],
  sync: ["--target", "-t", "--force", "-f", "--json", "--help", "-h"],
  doctor: ["--target", "-t", "--json", "--help", "-h"],
};

const LEGACY_COMMAND_NAMES = Object.keys(LEGACY_COMMAND_FLAGS);

class UsageFailure extends CliError {
  public constructor(lines: readonly string[]) {
    super(lines.join("\n"), 2);
    this.name = "UsageFailure";
  }
}

function usageLine(command: string): string | undefined {
  return HELP.split("\n").find((line) => line.trim().startsWith(`syn ${command} `))?.trim();
}

function flagName(token: string): string {
  const separator = token.indexOf("=");
  return separator === -1 ? token : token.slice(0, separator);
}

async function flagsAccepted(command: string, args: readonly string[]): Promise<boolean> {
  const flags = args.filter((token) => token.startsWith("-") && token !== "--").map(flagName);
  if (flags.length === 0) return true;
  const accepted = new Set(LEGACY_COMMAND_FLAGS[command] ?? []);
  if (HARNESS_COMMAND_NAMES.includes(command) || command === "doctor") {
    const harness = await import("./harness/cli/index.ts");
    for (const flag of harness.harnessCommandFlags(command)) accepted.add(flag);
  }
  return flags.every((flag) => accepted.has(flag));
}

async function unknownCommand(command: string, args: readonly string[]): Promise<UsageFailure> {
  const lines = [`Unknown command: ${command}`];
  const match = closestMatch(command, [...LEGACY_COMMAND_NAMES, ...HARNESS_COMMAND_NAMES]);
  if (match !== undefined) {
    const suggestion = (await flagsAccepted(match, args)) ? ["syn", match, ...args] : ["syn", match];
    lines.push(`Did you mean: ${suggestion.join(" ")}?`);
  }
  lines.push("Run syn --help for all commands.");
  return new UsageFailure(lines);
}

function unknownOption(error: unknown, command: string | undefined): UsageFailure | undefined {
  if ((error as { code?: unknown } | null)?.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") return undefined;
  const flag = /Unknown option '([^']+)'/.exec(error instanceof Error ? error.message : "")?.[1] ?? "";
  if (command === undefined || LEGACY_COMMAND_FLAGS[command] === undefined) {
    return new UsageFailure([`Unknown option ${flag}`, "Run syn --help for all commands."]);
  }
  const lines = [`Unknown option ${flag} for syn ${command}`];
  const match = flag.startsWith("--") ? closestMatch(flag, (LEGACY_COMMAND_FLAGS[command] ?? []).filter((candidate) => candidate.startsWith("--"))) : undefined;
  if (match !== undefined) lines.push(`Did you mean ${match}?`);
  const usage = usageLine(command);
  if (usage !== undefined) lines.push(`Usage: ${usage}`);
  return new UsageFailure(lines);
}

function isHarnessInvocation(argv: readonly string[]): boolean {
  const [command] = argv;
  if (HARNESS_COMMAND_NAMES.includes(command ?? "")) {
    return true;
  }
  if (command !== "doctor") {
    return false;
  }
  const terminator = argv.indexOf("--");
  return (terminator === -1 ? argv : argv.slice(0, terminator)).includes("--runtime");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHarnessInvocation(argv)) {
    const harness = await import("./harness/cli/index.ts");
    process.exitCode = await harness.runHarnessCommand(argv);
    return;
  }
  // Bare `syn` in an interactive terminal opens the conversation (like `claude`); pipes and CI keep the help text.
  if (argv.length === 0 && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const harness = await import("./harness/cli/index.ts");
    process.exitCode = await harness.runHarnessCommand(["agent"]);
    return;
  }

  const [first] = argv;
  if (first !== undefined && !first.startsWith("-") && !LEGACY_COMMAND_NAMES.includes(first)) {
    throw await unknownCommand(first, argv.slice(1));
  }

  let parsed: ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; strict: true; options: typeof LEGACY_OPTIONS }>>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: LEGACY_OPTIONS });
  } catch (error) {
    throw unknownOption(error, argv.find((token) => !token.startsWith("-"))) ?? new CliError(error instanceof Error ? error.message : String(error), 2);
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(versionLine());
    return;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const command = positionals[0];
  if (positionals.length > 1) {
    throw new CliError(`Unexpected positional arguments: ${positionals.slice(1).join(" ")}`, 2);
  }

  const target = values.target ?? process.cwd();
  const scope = parseScope(values.scope);
  const fileSystem = new NodeFileSystem();

  switch (command) {
    case "inspect": {
      const plan = await new StructureService(fileSystem).createPlan(target, scope, values.force);
      printPlan(plan, values.json);
      return;
    }
    case "init": {
      const service = new StructureService(fileSystem);
      const plan = await service.createPlan(target, scope, values.force);
      const result = await service.initialize(plan);
      if (values.json) {
        console.log(JSON.stringify({ scope: plan.scope, target: plan.targetDirectory, ...result }, null, 2));
      } else {
        console.log(`Initialized ${plan.scope} structure at ${plan.targetDirectory}`);
        console.log(
          `Created: ${result.created.length}, updated: ${result.updated.length}, ` +
            `unchanged: ${result.unchanged.length}, preserved: ${result.preserved.length}`,
        );
        if (result.preserved.length > 0) {
          console.log(`Preserved (never overwritten): ${result.preserved.join(", ")}`);
        }
        console.log("Next: run `syn sync`, then `syn doctor`.");
      }
      return;
    }
    case "sync": {
      rejectUnsupported(scope !== undefined, "--scope", command);
      const result = await new ProjectDiscoveryService(fileSystem).sync(target, {
        force: values.force,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Discovered ${result.projects.length} project(s).`);
        for (const project of result.projects) {
          console.log(`  ${project.id}: ${project.path}`);
        }
        if (result.prunedObservations > 0) {
          console.log(`Pruned ${result.prunedObservations} expired observation(s).`);
        }
      }
      return;
    }
    case "doctor": {
      rejectUnsupported(values.force, "--force", command);
      rejectUnsupported(scope !== undefined, "--scope", command);
      const diagnostics = await new DoctorService(fileSystem).diagnose(target);
      printDiagnostics(diagnostics, values.json);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw await unknownCommand(String(command), []);
  }
}

function parseScope(value: string | undefined): StructureScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = scopeSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(`Invalid scope: ${value}. Expected workspace or repository.`, 2);
  }
  return result.data;
}

function rejectUnsupported(condition: boolean, option: string, command: string): void {
  if (condition) {
    throw new CliError(`${option} is not supported by the ${command} command.`, 2);
  }
}

function printPlan(plan: GenerationPlan, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Target: ${plan.targetDirectory}`);
  console.log(`Scope: ${plan.scope}`);
  for (const file of plan.files) {
    console.log(`${statusSymbol(file.status)} ${file.status.padEnd(9)} ${file.relativePath}`);
  }

  const conflicts = plan.files.filter((file) => file.status === "conflict").length;
  if (conflicts > 0) {
    console.log(`\n${conflicts} conflict(s) found. Existing files will not be overwritten without --force.`);
  }
}

function statusSymbol(status: GenerationPlan["files"][number]["status"]): string {
  switch (status) {
    case "create":
      return "+";
    case "update":
      return "~";
    case "unchanged":
      return "=";
    case "preserved":
      return "=";
    case "conflict":
      return "!";
  }
}

function printDiagnostics(diagnostics: readonly Diagnostic[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(diagnostics, null, 2));
    return;
  }
  for (const diagnostic of diagnostics) {
    const location = diagnostic.path === undefined ? "" : ` (${diagnostic.path})`;
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${location}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageFailure) {
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode;
    return;
  }
  const debug = process.env.SYN_DEBUG === "1";
  const message = error instanceof Error ? (debug ? error.stack ?? error.message : error.message) : String(error);
  console.error(`Unexpected error: ${message}`);
  process.exitCode = 1;
});
