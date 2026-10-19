/**
 * Sort every run of two or more string literals joined by ` | ` (gen-types
 * post-process). Only consecutive literals move: `null` / `undefined` / other
 * members keep their place, so a literal run split by a non-literal member is
 * sorted per run. Order is meaningless in a literal union, so this changes no
 * type — it only makes the printed file independent of the upstream dists.
 */
export function sortStringLiteralUnions(text) {
  return text.replace(/"[^"\n]*"(?: \| "[^"\n]*")+/g, (run) =>
    run.split(" | ").sort().join(" | ")
  );
}
