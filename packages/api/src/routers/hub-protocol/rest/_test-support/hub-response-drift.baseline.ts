/**
 * SHRINK-ONLY baseline of Hub REST routes whose 2xx body, served by the REAL
 * handler on PGlite rows in `hub-response-drift.tripwire.test.ts`, does not
 * match its registered response schema (`METHOD /spec/path`). Fixed one
 * resource file per PR (plan "App access done right" R4), deleting the entry in
 * the same PR. The tripwire is exact both ways: a new drift fails, and an entry
 * whose route now matches must be deleted. Print what it found with
 * `HUB_DRIFT_DUMP=1`.
 */
export const HUB_RESPONSE_DRIFT_BASELINE: readonly string[] = [
  "GET /focus-sessions",
  "GET /focus-sessions/{id}",
];
