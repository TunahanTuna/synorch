#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import { DoctorService, type Diagnostic } from "./application/doctor-service.ts";
import { ProjectDiscoveryService } from "./application/project-discovery.ts";
import { StructureService } from "./application/structure-service.ts";
import { scopeSchema, type StructureScope } from "./domain/config.ts";
import { CliError } from "./domain/errors.ts";
import type { GenerationPlan } from "./domain/generation.ts";
import { NodeFileSystem } from "./infrastructure/file-system.ts";

const HELP = `ai-structure — Codex and Claude Code orchestration structure generator

Usage:
  ai-structure inspect [--target <path>] [--scope workspace|repository]
  ai-structure init [--target <path>] [--scope workspace|repository] [--force]
  ai-structure sync [--target <path>] [--force] [--json]
  ai-structure doctor [--target <path>] [--json]

Commands:
  inspect  Preview every generated file and conflict without writing.
  init     Create the canonical structure and provider entrypoints.
  sync     Discover projects after a manual trigger and refresh the registry.
  doctor   Validate structure, profiles and constitutional safety settings.

Safety:
  Existing differing files are never overwritten unless --force is explicit.
  Model fallback is never silent.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      target: { type: "string", short: "t" },
      scope: { type: "string", short: "s" },
      force: { type: "boolean", short: "f", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    console.log("0.1.0");
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
        console.log(`Created: ${result.created.length}, updated: ${result.updated.length}, unchanged: ${result.unchanged.length}`);
        console.log("Next: run `ai-structure sync`, then `ai-structure doctor`.");
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
      throw new CliError(`Unknown command: ${String(command)}\n\n${HELP}`, 2);
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
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Unexpected error: ${message}`);
  process.exitCode = 1;
});
