/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions cost 1. */
export function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const current = table[row] as number[];
      const previous = table[row - 1] as number[];
      let best = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, ((table[row - 2] as number[])[column - 2] as number) + 1);
      }
      current[column] = best;
    }
  }
  return (table[rows - 1] as number[])[columns - 1] as number;
}

/** The closest candidate within a length-scaled distance (at most 3), or undefined when nothing is plausibly meant. */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  const limit = Math.min(3, Math.max(1, Math.ceil(needle.length / 3)));
  let best: { readonly candidate: string; readonly distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}
