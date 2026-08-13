/**
 * The `isEnabled` predicate for `resolveTool("discord", …)` calls that care
 * SPECIFICALLY about event-sync (run-event-sync.ts, migrate-gcal-events.ts —
 * both read/write `discord.eventSync`). Do NOT reuse this for a caller that
 * cares about a different discord sub-feature (e.g. mail-feed) — that
 * mismatch (a caller's tie-break preferring a row enabled for a DIFFERENT
 * feature than the one it's asking about) is exactly the bug this predicate
 * being caller-supplied, instead of hard-coded in the resolver, exists to
 * prevent. Each feature passes its OWN predicate.
 */
export function isDiscordEventSyncEnabled(metadata: unknown): boolean {
  const discord = (
    metadata as { discord?: { eventSync?: { enabled?: boolean } } }
  )?.discord;
  return discord?.eventSync?.enabled === true;
}

/**
 * The `isEnabled` predicate for `resolveTool("discord", …)` calls that care
 * about mail-feed (run-mail-feed.ts, which reads/writes `discord.mailFeed`).
 * Deliberately a SEPARATE predicate from `isDiscordEventSyncEnabled` — see
 * that function's doc comment for why reusing one feature's flag as another
 * feature's tie-break reproduces the original incident.
 */
export function isDiscordMailFeedEnabled(metadata: unknown): boolean {
  const discord = (
    metadata as { discord?: { mailFeed?: { enabled?: boolean } } }
  )?.discord;
  return discord?.mailFeed?.enabled === true;
}
