import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — the conversation socket-event NAME contract is consistent across
 * the backend↔frontend repo boundary.
 *
 * WHY: realtime event names are bare strings that cross a repo boundary with no
 * compiler between them. A subscriber guessing a name the server never emits, or
 * a rename on one side without the other, silently breaks a live feature with no
 * build error — this is exactly the `proposal.new` / `proposal.created`
 * phantom-event bug that left the proposals badge dead.
 *
 * This test reads BOTH typed SSOTs from the filesystem and asserts every event
 * the FRONTEND subscribes to is one the BACKEND emits. If you rename an emitted
 * event without updating the subscriber SSOT (or vice-versa), this goes red.
 *
 *   Emitter SSOT:    synap-backend/.../api/src/realtime/socket-events.ts
 *                    → SERVER_CONVERSATION_EVENTS
 *   Subscriber SSOT: synap-app/.../synap-client/src/socket/conversation-events.ts
 *                    → SUBSCRIBED_CONVERSATION_EVENTS
 *
 * If this fails with a "phantom subscription": the frontend listens for a name
 * nothing emits. Either wire up the emit, fix the subscriber name to a real
 * emitted one, or (if the subscription is genuinely dead) delete it — do NOT
 * paper over it by adding to KNOWN_ORPHAN_SUBSCRIPTIONS unless it is a real,
 * documented, pre-existing dead subscription being tracked for removal.
 */

// Resolve paths relative to THIS test file (not process.cwd()) so the tripwire
// gives the same verdict whether run from the package dir, the repo root, or CI.
// __dir = synap-backend/packages/api/src/__tripwires__
const __dir = dirname(fileURLToPath(import.meta.url));
const BACKEND_SSOT = join(__dir, "..", "realtime", "socket-events.ts");
// Walk up to the /synap meta-root (5 levels: __tripwires__→src→api→packages→
// synap-backend→synap), then into the sibling synap-app repo.
const FRONTEND_SSOT = join(
  __dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "synap-app",
  "packages",
  "synap-client",
  "src",
  "socket",
  "conversation-events.ts"
);

/**
 * Pre-existing dead subscriptions the frontend still declares but the backend
 * never emits. Each entry is a REAL bug tracked for removal, NOT a license to
 * add new phantoms. The second assertion below forces this list to stay honest:
 * when the subscription is finally removed (or the backend starts emitting it),
 * the entry MUST be pruned from here or the test fails.
 *
 * (Empty: the `chat:error` phantom was removed from useChannelStream — stream
 * interruptions surface via `chat:stream:error`.)
 */
const KNOWN_ORPHAN_SUBSCRIPTIONS: string[] = [];

/**
 * Extract the string VALUES of an `as const` event-name record from raw source.
 * Matches only UPPER_SNAKE key entries (`  KEY: "value",`) so doc-comment prose
 * inside the block can never be mistaken for an event name.
 */
function extractEventValues(fileText: string, constName: string): string[] {
  const declStart = fileText.indexOf(`${constName} = {`);
  if (declStart === -1) {
    throw new Error(`Could not find "${constName} = {" in SSOT source`);
  }
  const braceStart = fileText.indexOf("{", declStart);
  const blockEnd = fileText.indexOf("} as const", braceStart);
  if (blockEnd === -1) {
    throw new Error(`Could not find "} as const" closing ${constName}`);
  }
  const block = fileText.slice(braceStart, blockEnd);
  const values: string[] = [];
  const entry = /^\s*[A-Z][A-Z0-9_]*:\s*"([^"]+)"\s*,?/gm;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block)) !== null) {
    values.push(m[1]);
  }
  return values;
}

describe("tripwire: conversation socket-event names are consistent backend↔frontend", () => {
  it("both SSOT files exist at their expected paths", () => {
    expect(
      existsSync(BACKEND_SSOT),
      `missing backend SSOT: ${BACKEND_SSOT}`
    ).toBe(true);
    expect(
      existsSync(FRONTEND_SSOT),
      `missing frontend SSOT: ${FRONTEND_SSOT}`
    ).toBe(true);
  });

  it("every event the frontend subscribes to is one the backend emits", () => {
    const emitted = extractEventValues(
      readFileSync(BACKEND_SSOT, "utf8"),
      "SERVER_CONVERSATION_EVENTS"
    );
    const subscribed = extractEventValues(
      readFileSync(FRONTEND_SSOT, "utf8"),
      "SUBSCRIBED_CONVERSATION_EVENTS"
    );

    // Sanity: the extractor actually found entries (guards against a silent
    // parse failure making the subset check trivially pass).
    expect(emitted.length).toBeGreaterThan(5);
    expect(subscribed.length).toBeGreaterThan(5);

    const phantomSubscriptions = subscribed.filter(
      (name) =>
        !emitted.includes(name) && !KNOWN_ORPHAN_SUBSCRIPTIONS.includes(name)
    );

    expect(
      phantomSubscriptions,
      `Frontend subscribes to socket event(s) the backend never emits: ` +
        `${JSON.stringify(phantomSubscriptions)}. Either emit them from ` +
        `SERVER_CONVERSATION_EVENTS or fix the subscriber name.`
    ).toEqual([]);
  });

  it("KNOWN_ORPHAN_SUBSCRIPTIONS stays honest (each is still a real orphan)", () => {
    const emitted = extractEventValues(
      readFileSync(BACKEND_SSOT, "utf8"),
      "SERVER_CONVERSATION_EVENTS"
    );
    const subscribed = extractEventValues(
      readFileSync(FRONTEND_SSOT, "utf8"),
      "SUBSCRIBED_CONVERSATION_EVENTS"
    );

    for (const orphan of KNOWN_ORPHAN_SUBSCRIPTIONS) {
      // Still declared as a subscription — else the dead sub was removed (the
      // fix) and this entry must be pruned from the allowlist.
      expect(
        subscribed,
        `"${orphan}" is no longer subscribed — remove it from KNOWN_ORPHAN_SUBSCRIPTIONS`
      ).toContain(orphan);
      // Still not emitted — else the backend now emits it and it is no longer an
      // orphan, so it must be pruned from the allowlist.
      expect(
        emitted,
        `"${orphan}" is now emitted by the backend — remove it from KNOWN_ORPHAN_SUBSCRIPTIONS`
      ).not.toContain(orphan);
    }
  });

  it("reports (does not fail on) events emitted but not subscribed", () => {
    const emitted = extractEventValues(
      readFileSync(BACKEND_SSOT, "utf8"),
      "SERVER_CONVERSATION_EVENTS"
    );
    const subscribed = extractEventValues(
      readFileSync(FRONTEND_SSOT, "utf8"),
      "SUBSCRIBED_CONVERSATION_EVENTS"
    );
    const unsubscribed = emitted.filter((name) => !subscribed.includes(name));
    if (unsubscribed.length > 0) {
      // Informational only: other consumers (browser/, webhooks) may subscribe.
      console.info(
        `[socket-event-consistency] emitted but not in the synap-app subscriber SSOT: ${JSON.stringify(
          unsubscribed
        )}`
      );
    }
    // No assertion — this direction is not a bug by itself.
    expect(true).toBe(true);
  });
});
