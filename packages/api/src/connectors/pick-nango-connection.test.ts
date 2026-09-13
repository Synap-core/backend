import { describe, it, expect } from "vitest";
import { pickNangoConnection } from "./external-dispatch.js";
import type { SyncConnectorConnection } from "./SyncConnector.js";

/**
 * The 1-of-N account pick shared by every `nango://` route.
 *
 * The defect this pins: an `accountHint` that matched none of the user's
 * connections fell back to `matching[0]` — so a run pinned to account B (e.g. a
 * disconnected work inbox) silently executed as account A. A pinned account the
 * user no longer has is a refusal, never a substitution.
 */

function conn(
  connectionId: string,
  createdAt: string
): SyncConnectorConnection {
  return {
    connectionId,
    provider: "google",
    userId: "user-1",
    createdAt: new Date(createdAt),
  };
}

const PERSONAL = conn("conn-personal-aaa111", "2026-08-01T00:00:00.000Z");
const WORK = conn("conn-work-bbb222", "2026-09-01T00:00:00.000Z");

describe("pickNangoConnection", () => {
  it("a hint that matches nothing REFUSES — it never runs as another account", () => {
    const pick = pickNangoConnection([PERSONAL, WORK], "google", "ccc333");
    expect(pick).toEqual({ ok: false, reason: "hint_mismatch" });
  });

  it("a hint that matches pins exactly that account, even when it is not the newest", () => {
    const pick = pickNangoConnection([PERSONAL, WORK], "google", "aaa111");
    expect(pick).toEqual({ ok: true, connection: PERSONAL });
  });

  it("no hint → the most recently created connection", () => {
    const pick = pickNangoConnection([PERSONAL, WORK], "google", undefined);
    expect(pick).toEqual({ ok: true, connection: WORK });
  });

  it("no connection for the provider → no_connection (distinct from a mismatch)", () => {
    expect(pickNangoConnection([PERSONAL], "notion", undefined)).toEqual({
      ok: false,
      reason: "no_connection",
    });
    expect(pickNangoConnection([], "google", "aaa111")).toEqual({
      ok: false,
      reason: "no_connection",
    });
  });
});
