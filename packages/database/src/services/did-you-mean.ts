/**
 * did-you-mean — dependency-free nearest-key suggestion.
 *
 * Used by PropertyValidationService to turn an unknown property key into a
 * recovery hint ("you wrote `duedate`, did you mean `due-date`?") instead of a
 * silent verbatim store. Deliberately tiny and dependency-free: it runs on the
 * write path of every entity create.
 */

/**
 * Levenshtein distance with an early-exit cap. Returns `max + 1` as soon as the
 * distance is known to exceed `max`, so long unrelated strings cost O(n) rather
 * than O(n*m).
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[b.length];
}

/**
 * Closest candidate to `input`, or undefined when nothing is close enough.
 *
 * Comparison is case-insensitive and ignores `-`/`_`/space, so the common
 * casing/separator mistakes (`dueDate` vs `due-date`, `Status` vs `status`)
 * resolve at distance 0. The distance budget scales with the key length
 * (~1 edit per 4 chars, min 1, max 3) so short keys don't collide.
 */
export function suggestClosest(
  input: string,
  candidates: readonly string[]
): string | undefined {
  const fold = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const target = fold(input);
  if (!target) return undefined;

  const budget = Math.max(1, Math.min(3, Math.floor(target.length / 4)));
  let best: string | undefined;
  let bestDistance = budget + 1;

  for (const candidate of candidates) {
    const distance = levenshtein(target, fold(candidate), bestDistance);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      if (distance === 0) break;
    }
  }

  return best;
}
