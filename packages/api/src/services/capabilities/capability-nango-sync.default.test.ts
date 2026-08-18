import { describe, it, expect } from "vitest";

import {
  chooseHealthyDefault,
  type DefaultCandidateRow,
} from "./capability-nango-sync.js";

/**
 * The default must point at a connection that WORKS.
 *
 * Live-observed failure this locks: the registry default sat on `26fd5a6f`
 * (dead — Gmail proxy 400 "refresh limit reached") while `ac25528d` (live,
 * HTTP 200) sat right beside it unused. An explicit-default run would fail
 * against a perfectly good account.
 */
function row(over: Partial<DefaultCandidateRow>): DefaultCandidateRow {
  return {
    id: "r",
    accountHint: null,
    isDefault: false,
    connectionState: null,
    createdAt: new Date("2026-01-01"),
    ...over,
  };
}

describe("chooseHealthyDefault", () => {
  it("moves the default off a needs_reauth connection onto a healthy one", () => {
    const move = chooseHealthyDefault(
      [
        row({ id: "dead", isDefault: true, connectionState: "needs_reauth" }),
        row({ id: "live", createdAt: new Date("2026-02-01") }),
      ],
      []
    );
    expect(move).toEqual({ demoteId: "dead", promoteId: "live" });
  });

  it("treats a broker-errored connection as dead even when the mirror looks healthy", () => {
    // The exact live case: mirror said "healthy", Nango said errored.
    const move = chooseHealthyDefault(
      [
        row({ id: "dead", isDefault: true, accountHint: "conn-dead" }),
        row({ id: "live", accountHint: "conn-live" }),
      ],
      ["conn-dead"]
    );
    expect(move).toEqual({ demoteId: "dead", promoteId: "live" });
  });

  it("picks the NEWEST healthy pointer (agrees with what dispatch picks)", () => {
    const move = chooseHealthyDefault(
      [
        row({ id: "dead", isDefault: true, connectionState: "needs_reauth" }),
        row({ id: "older", createdAt: new Date("2026-01-05") }),
        row({ id: "newest", createdAt: new Date("2026-03-09") }),
      ],
      []
    );
    expect(move?.promoteId).toBe("newest");
  });

  it("never promotes another dead connection", () => {
    const move = chooseHealthyDefault(
      [
        row({ id: "dead", isDefault: true, connectionState: "needs_reauth" }),
        row({ id: "alsoDead", accountHint: "conn-bad" }),
      ],
      ["conn-bad"]
    );
    expect(move).toBeNull();
  });

  it("leaves a HEALTHY default alone", () => {
    const move = chooseHealthyDefault(
      [
        row({ id: "ok", isDefault: true }),
        row({ id: "other", createdAt: new Date("2026-05-01") }),
      ],
      []
    );
    expect(move).toBeNull();
  });

  it("no-ops when there is no default at all", () => {
    expect(chooseHealthyDefault([row({ id: "a" })], [])).toBeNull();
  });
});
