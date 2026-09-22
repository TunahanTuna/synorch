/**
 * I5 — composition root for runtime commands. `src/cli.ts` reaches this module only through a
 * literal dynamic `import("./harness/cli/index.ts")`, so `inspect/init/sync/doctor` never load it.
 */
export const HARNESS_COMMANDS = ["agent", "run", "runs", "show", "login", "logout", "auth", "memory"] as const;
export type HarnessCommand = (typeof HARNESS_COMMANDS)[number];
