// Fuzzy string matching utilities.
//
// Goals (per the user's spec):
//   - case-insensitive
//   - whitespace-insensitive
//   - partial matches allowed above a 70% similarity threshold
//
// We normalize by lowercasing and stripping all whitespace AND common separators
// (dash / underscore / dot / slash) so that "claude opus 4 5", "claude-opus-4-5",
// and "ClaudeOpus4.5" all collapse to a single comparable form.

/**
 * Normalize a string for fuzzy comparison.
 * Lowercase + strip whitespace + common separators.
 */
export function normalize(input: string): string {
  return input.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/**
 * Levenshtein edit distance (iterative two-row DP, O(n) memory).
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n] ?? 0;
}

/**
 * Similarity score in [0, 1].
 *   1.0   = exact match after normalization
 *   0.7-1 = one is a substring of the other (sub-linear by length ratio)
 *   0-1   = otherwise 1 - (editDistance / maxLen)
 */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;

  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    return 0.7 + 0.3 * (minLen / maxLen);
  }

  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Pick the candidate with the highest similarity to `query`,
 * but only if it crosses the threshold.
 *
 * Returns `{ value, score }` or `null` if no candidate qualifies.
 */
export function bestMatch<T>(
  query: string,
  candidates: readonly T[],
  threshold: number,
  score: (item: T) => number,
): { value: T; score: number } | null {
  let best: { value: T; score: number } | null = null;
  for (const c of candidates) {
    const s = score(c);
    if (s >= threshold && (best === null || s > best.score)) {
      best = { value: c, score: s };
    }
  }
  return best;
}