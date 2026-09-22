import { parseYaml } from "./serialization.ts";

/**
 * Minimal, dependency-free reader for the `---` YAML frontmatter block used by
 * generated agent manifests and skills. Pure: it never touches the file system.
 */

const DELIMITER = "---";

export interface ParsedFrontmatter {
  readonly kind: "parsed";
  /** The raw YAML mapping; callers validate it against their own schema. */
  readonly data: Record<string, unknown>;
  /** Everything after the closing delimiter, with normalized line endings. */
  readonly body: string;
}

export interface MissingFrontmatter {
  readonly kind: "missing";
}

export interface MalformedFrontmatter {
  readonly kind: "malformed";
  readonly message: string;
}

export type FrontmatterResult = ParsedFrontmatter | MissingFrontmatter | MalformedFrontmatter;

export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = normalizeLineEndings(content).split("\n");
  if (lines[0]?.trim() !== DELIMITER) {
    return { kind: "missing" };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === DELIMITER,
  );
  if (closingIndex === -1) {
    return { kind: "malformed", message: "Frontmatter block is never closed with '---'." };
  }

  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, closingIndex).join("\n"));
  } catch (error: unknown) {
    return { kind: "malformed", message: error instanceof Error ? error.message : String(error) };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "malformed", message: "Frontmatter must be a YAML mapping." };
  }

  return {
    kind: "parsed",
    data: data as Record<string, unknown>,
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

/**
 * Splits a markdown body into its level-two sections, keyed by the normalized
 * heading text. Headings inside fenced code blocks are ignored so an example
 * cannot forge a required section. The first occurrence of a heading wins.
 */
export function splitMarkdownSections(body: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let currentHeading: string | undefined;
  let currentLines: string[] = [];
  let insideFence = false;

  const flush = (): void => {
    if (currentHeading !== undefined && !sections.has(currentHeading)) {
      sections.set(currentHeading, currentLines.join("\n").trim());
    }
    currentLines = [];
  };

  for (const line of normalizeLineEndings(body).split("\n")) {
    if (line.trimStart().startsWith("```")) {
      insideFence = !insideFence;
    }
    const heading = insideFence ? undefined : matchLevelTwoHeading(line);
    if (heading === undefined) {
      if (currentHeading !== undefined) currentLines.push(line);
      continue;
    }
    flush();
    currentHeading = normalizeSectionName(heading);
  }
  flush();

  return sections;
}

/** Normalizes a heading for comparison: case and surrounding punctuation free. */
export function normalizeSectionName(value: string): string {
  return value.trim().replace(/[:.]+$/, "").toLowerCase();
}

function matchLevelTwoHeading(line: string): string | undefined {
  const match = /^##\s+(\S.*?)\s*$/.exec(line);
  return match?.[1];
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}
