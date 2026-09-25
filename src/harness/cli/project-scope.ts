import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Is this folder a project? Synorch started in the home folder (or a drive root, or a folder with
 * no git and no project files) must not read `~/.mcp.json`, `~/.claude/skills` and friends as a
 * repository's declarations: those are the user's own files, and asking to "approve the
 * repository's servers" there is noise.
 */

const PROJECT_MARKERS = [
  ".git",
  ".mcp.json",
  ".synorch",
  ".claude",
  ".ai",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "deno.json",
  "Makefile",
  "CMakeLists.txt",
  "project.godot",
] as const;

function same(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

export function isProjectFolder(root: string, userHome: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  const resolved = path.resolve(root);
  if (userHome !== undefined && userHome !== "" && same(resolved, userHome, platform)) return false;
  if (path.dirname(resolved) === resolved) return false;
  if (PROJECT_MARKERS.some((marker) => existsSync(path.join(resolved, marker)))) return true;
  // A subfolder of a repository is part of that project.
  for (let current = path.dirname(resolved); path.dirname(current) !== current; current = path.dirname(current)) {
    if (userHome !== undefined && same(current, userHome, platform)) break;
    if (existsSync(path.join(current, ".git"))) return true;
  }
  return false;
}
