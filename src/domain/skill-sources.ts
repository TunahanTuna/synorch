import type { SkillPackTrigger } from "./skill-packs.ts";

export type SkillSourceTrust = "bundled" | "reference-only";

export interface SkillSourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly repository: string | null;
  readonly revision: string;
  readonly license: string;
  readonly trust: SkillSourceTrust;
  readonly notes: string;
}

export interface BundledSkillDefinition {
  readonly id: string;
  readonly sourceId: "ingenium";
  readonly activation: "automatic" | "on-demand";
  readonly triggers: readonly SkillPackTrigger[];
}

export const SKILL_SOURCES: readonly SkillSourceDefinition[] = [
  {
    id: "ingenium",
    name: "Ingenium",
    repository: null,
    revision: "local-snapshot-2026-09-20",
    license: "Project-owned",
    trust: "bundled",
    notes: "Bundled from the project owner's Ingenium plugin skill library.",
  },
  {
    id: "anthropic-skills",
    name: "Anthropic Agent Skills",
    repository: "https://github.com/anthropics/skills",
    revision: "34040c9c568585f6929bedeaad110ad08f079624",
    license: "Mixed: Apache-2.0 and source-available; inspect per skill",
    trust: "reference-only",
    notes: "Official format and implementation reference; content is not auto-imported.",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    repository: "https://github.com/obra/superpowers",
    revision: "5bf4e78011075bcfc0dc295f0724994cd123ee71",
    license: "MIT",
    trust: "reference-only",
    notes: "Mature engineering methodology; not auto-activated because it can overlap orchestration protocols.",
  },
  {
    id: "microsoft-skills",
    name: "Microsoft Agent Skills",
    repository: "https://github.com/microsoft/skills",
    revision: "14655200e871a89c013803b3aa4d88202cb03fc1",
    license: "MIT",
    trust: "reference-only",
    notes: "Large Azure and Foundry catalog; import only when matching platform evidence exists.",
  },
];

const AUTOMATIC_SKILLS: Readonly<Record<string, readonly SkillPackTrigger[]>> = {
  "frontend-craft": [{ kind: "framework", values: ["react", "nextjs", "vue", "nuxt", "angular"] }],
  "react-modern": [{ kind: "framework", values: ["react", "nextjs"] }],
  "vue-modern": [{ kind: "framework", values: ["vue", "nuxt"] }],
  "java-backend": [
    { kind: "language", values: ["java"] },
    { kind: "framework", values: ["spring-boot"] },
  ],
  "node-backend": [{ kind: "framework", values: ["express", "fastify", "nestjs"] }],
  "db-schema-craft": [{ kind: "framework", values: ["jpa", "hibernate"] }],
  "query-tuning": [{ kind: "framework", values: ["jpa", "hibernate"] }],
  "tailwind-v4-tokens": [
    { kind: "dependency", values: ["tailwindcss", "@tailwindcss/vite", "@tailwindcss/postcss"] },
  ],
};

const INGENIUM_SKILL_IDS = [
  "db-schema-craft",
  "debug-detective",
  "design-system",
  "docs-sync",
  "dotnet-backend",
  "frontend-craft",
  "game-audio",
  "game-design",
  "godot-dev",
  "human-made-design",
  "java-backend",
  "jev",
  "motion-craft",
  "multiplayer-netcode",
  "node-backend",
  "perf-audit",
  "pixel-art-assets",
  "pixel-game-dev",
  "project-onboard",
  "pwa-offline",
  "query-tuning",
  "react-modern",
  "refactor-safe",
  "release-prep",
  "safe-merge",
  "session-recap",
  "shader-vfx",
  "tailwind-v4-tokens",
  "task-conductor",
  "tauri-game-dev",
  "ui-ux-design",
  "vue-modern",
  "web-kickoff",
] as const;

export const BUNDLED_SKILLS: readonly BundledSkillDefinition[] = INGENIUM_SKILL_IDS.map(
  (id) => ({
    id,
    sourceId: "ingenium",
    activation: AUTOMATIC_SKILLS[id] === undefined ? "on-demand" : "automatic",
    triggers: AUTOMATIC_SKILLS[id] ?? [],
  }),
);

