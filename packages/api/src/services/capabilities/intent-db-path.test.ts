/**
 * The DATABASE PATH of the intent spine — the part the pure coverage guard in
 * `capability-intent-index.coverage.test.ts` explicitly does NOT test.
 *
 * WHY THIS FILE EXISTS: that guard says so in its own docblock. It drives
 * `foldIntentCoverage` / `selectIntentProviders` — both pure — and never calls
 * `readWorkspaceTaskIntents` or `workspaceIntentCoverage`. So the half of the
 * spine that reads real workspace settings had ZERO coverage while 23 tests ran
 * green beside it. A guard's absence is worth as much as its assertions; this
 * closes it.
 *
 * ⚠️ WHAT IS STILL NOT COVERED, stated rather than implied:
 *   - The REAL Postgres round-trip. `@synap/database` is mocked at the module
 *     boundary, so this proves the DECISION each row shape produces, not that
 *     Drizzle reads `settings` correctly. That is NEEDS-DOGFOOD against a live
 *     pod; the `.pglite` suites are the door for it.
 *   - The `settings` WRITE. Only the read side is covered here.
 *
 * ── WHY THE THROWS ARE THE POINT ─────────────────────────────────────────────
 * Every case below exists to separate three answers that a `catch { return [] }`
 * would collapse into one:
 *   - the workspace does not exist        → THROW (we cannot know its needs)
 *   - its `taskIntents` is absent/null    → `[]` (it declares nothing — a fact)
 *   - its `taskIntents` is the wrong type → THROW (the stored data is malformed)
 * Absent is a real answer; unknown is not. That distinction is the whole reason
 * this file asserts on the ERROR rather than on an empty array.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** The row `readWorkspaceTaskIntents` will see; replaced per test. */
let settingsRow: unknown = { settings: null };
/** When set, the query rejects — standing in for a failed database read. */
let queryFailure: Error | null = null;

// Partial mock: the REAL module is loaded and only the workspaces query is
// replaced. A hand-written `{ db, workspaces, eq }` stub looked sufficient and
// was not — the module graph pulls `entities` and friends at import time, and a
// missing export fails COLLECTION with a message that says nothing about intent.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      ...(actual.db as Record<string, unknown>),
      query: {
        ...((actual.db as Record<string, unknown>).query as Record<
          string,
          unknown
        >),
        workspaces: {
          findFirst: async () => {
            if (queryFailure) throw queryFailure;
            return settingsRow;
          },
        },
      },
    },
  };
});

const { readWorkspaceTaskIntents } =
  await import("./capability-intent-index.js");

const WS = "ws-1";

beforeEach(() => {
  settingsRow = { settings: null };
  queryFailure = null;
});

describe("readWorkspaceTaskIntents — absent is [] , unknown is a THROW", () => {
  it("NON-VACUITY: a declared list actually reaches the caller", () => {
    // Without this, every "returns []" assertion below would pass on a reader
    // that always returns [].
    settingsRow = {
      settings: { taskIntents: ["generate_media", "send_message"] },
    };
    return expect(
      readWorkspaceTaskIntents({ workspaceId: WS })
    ).resolves.toEqual(["generate_media", "send_message"]);
  });

  it("an ABSENT key means the workspace declares nothing — [], not an error", async () => {
    settingsRow = { settings: { someOtherSetting: true } };
    await expect(
      readWorkspaceTaskIntents({ workspaceId: WS })
    ).resolves.toEqual([]);
  });

  it("an explicit null is the same fact as absent", async () => {
    settingsRow = { settings: { taskIntents: null } };
    await expect(
      readWorkspaceTaskIntents({ workspaceId: WS })
    ).resolves.toEqual([]);
  });

  it("a MISSING workspace THROWS — we cannot report 'declares nothing' about a row we never read", async () => {
    settingsRow = undefined;
    await expect(readWorkspaceTaskIntents({ workspaceId: WS })).rejects.toThrow(
      /no workspace/
    );
  });

  it("a MALFORMED taskIntents THROWS rather than being silently coerced", async () => {
    settingsRow = { settings: { taskIntents: "generate_media" } };
    await expect(readWorkspaceTaskIntents({ workspaceId: WS })).rejects.toThrow(
      /not an array/
    );
  });

  it("a FAILED READ THROWS — never [] , or a broken database reads as a workspace with no needs", async () => {
    queryFailure = new Error("ECONNREFUSED");
    await expect(readWorkspaceTaskIntents({ workspaceId: WS })).rejects.toThrow(
      /ECONNREFUSED/
    );
  });

  it("non-string members are filtered out, not passed through as intents", async () => {
    settingsRow = {
      settings: { taskIntents: ["generate_media", 42, null, "send_message"] },
    };
    await expect(
      readWorkspaceTaskIntents({ workspaceId: WS })
    ).resolves.toEqual(["generate_media", "send_message"]);
  });
});
