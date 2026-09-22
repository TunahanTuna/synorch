/**
 * One human-readable rendering of a zod failure, shared by every diagnostic that reports one.
 *
 * `ZodError.message` is the pretty-printed JSON dump of the issue array. It is accurate and
 * unreadable in a terminal, so a diagnostic carries `path: message` per issue instead, joined
 * on one line.
 */

export interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export interface ZodErrorLike {
  readonly issues: readonly ZodIssueLike[];
}

export function formatZodIssues(error: ZodErrorLike): string {
  if (error.issues.length === 0) return "the value does not match the schema";
  return error.issues.map(formatZodIssue).join("; ");
}

/** Issues whose first path segment is one of `fields`, and the rest, split in two. */
export function partitionZodIssues(
  error: ZodErrorLike,
  fields: readonly string[],
): { readonly reported: readonly ZodIssueLike[]; readonly remaining: readonly ZodIssueLike[] } {
  const owned = new Set(fields);
  const reported: ZodIssueLike[] = [];
  const remaining: ZodIssueLike[] = [];
  for (const issue of error.issues) {
    (owned.has(String(issue.path[0])) ? reported : remaining).push(issue);
  }
  return { reported, remaining };
}

function formatZodIssue(issue: ZodIssueLike): string {
  const location = issue.path.map(String).join(".");
  return location.length === 0 ? issue.message : `${location}: ${issue.message}`;
}
