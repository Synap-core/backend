/**
 * Redact secrets that live in a URL PATH, before the path reaches a log sink.
 *
 * Most of this pod's credentials arrive in a header, and `hono/logger` never
 * prints headers. Two routes deliberately put the capability IN THE PATH
 * instead, because the client is a dumb fetcher that cannot send a header:
 *
 *   GET /api/hub/calendar/feed/{token}.ics   — a subscribed calendar client
 *   GET /api/hub/setup/agent/pending/{keyId} — a browser opening a setup link
 *
 * A calendar client polls every 5–15 minutes forever, so without this the
 * pod's stdout accumulates thousands of copies of a permanent, unauthenticated
 * read credential — in the log aggregator, in retained backups, and in any
 * support bundle. Rotation does not help: the log keeps the old URL AND the
 * new one.
 *
 * Applied at BOTH sinks that see a raw path: the request logger and the global
 * error handler (a 500 during a poll logs `c.req.path` too).
 *
 * The replacement keeps the route shape so the logs stay useful — you can still
 * see that a feed was polled and whether it 404'd, you just cannot replay it.
 */

/**
 * Path segments whose VALUE is a secret. Each entry is matched against the
 * de-queried path; the capturing group is what gets replaced.
 *
 * Adding a route that puts a secret in its path? Add it here in the same
 * commit — `redact-secret-path.test.ts` asserts every `skipAuthPaths` entry
 * that carries a path parameter is covered.
 */
const SECRET_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  // Calendar ICS feed — the token IS the capability. Keep the `.ics` suffix.
  /(\/calendar\/feed\/)([^/?#]+?)(\.ics)/gi,
  // Agent setup hand-off — the keyId is a bearer-equivalent secret.
  /(\/setup\/agent\/pending\/)([^/?#]+)/gi,
];

/** `[redacted]` keeps the segment countable in a log without being replayable. */
const MASK = "[redacted]";

/**
 * Replace every secret path segment in `input` with `[redacted]`.
 *
 * Takes an arbitrary string, not just a path, so it can be handed the whole
 * pre-formatted log line (`<-- GET /api/hub/calendar/feed/abc.ics`) as well as
 * a bare `c.req.path`.
 */
export function redactSecretPath(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATH_PATTERNS) {
    // Each RegExp carries /g, so reset lastIndex — these are module-level and
    // reused across requests. Without this, every other call silently skips.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      // String.replace passes (match, ...groups, offset, string). A pattern
      // with two groups therefore hands a NUMBER where a three-group pattern
      // hands the third group — so test the type, never truthiness. (Testing
      // truthiness put the match offset into the output here once already.)
      const prefix = args[1] as string;
      const suffix = typeof args[3] === "string" ? args[3] : "";
      return `${prefix}${MASK}${suffix}`;
    });
  }
  return out;
}
