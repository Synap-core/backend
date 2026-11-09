import { describe, expect, it } from "vitest";
import {
  needsFreshSignIn,
  presenceRecoveryView,
} from "./presence-recovery-model";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ready = (data: Parameters<typeof presenceRecoveryView>[0]["data"]) => ({
  isLoading: false,
  error: null,
  data,
});

describe("presenceRecoveryView: the recovery door's states", () => {
  it("never asked: ask for a reset", () => {
    expect(presenceRecoveryView(ready(null), NOW)).toEqual({
      kind: "none",
      cancelledAt: null,
    });
  });

  it("a cancelled reset says when, and offers to ask again", () => {
    expect(
      presenceRecoveryView(
        ready({
          status: "cancelled",
          maturesAt: "2026-11-07T10:00:00Z",
          cancelledAt: "2026-11-06T11:00:00Z",
          completedAt: null,
        }),
        NOW
      )
    ).toEqual({ kind: "none", cancelledAt: "2026-11-06T11:00:00Z" });
  });

  it("pending before its 24 h: waiting, until when", () => {
    expect(
      presenceRecoveryView(
        ready({
          status: "pending",
          maturesAt: "2026-11-07T10:00:00Z",
          cancelledAt: null,
          completedAt: null,
        }),
        NOW
      )
    ).toEqual({ kind: "waiting", maturesAt: "2026-11-07T10:00:00Z" });
  });

  it("pending past its 24 h: ready to finish", () => {
    expect(
      presenceRecoveryView(
        ready({
          status: "pending",
          maturesAt: new Date("2026-11-06T11:59:00Z"),
          cancelledAt: null,
          completedAt: null,
        }),
        NOW
      ).kind
    ).toBe("ready");
  });

  it("completed: add a first factor again", () => {
    expect(
      presenceRecoveryView(
        ready({
          status: "completed",
          maturesAt: "2026-11-06T10:00:00Z",
          cancelledAt: null,
          completedAt: "2026-11-06T11:00:00Z",
        }),
        NOW
      )
    ).toEqual({ kind: "done", completedAt: "2026-11-06T11:00:00Z" });
  });

  it("GUARDRAIL: a failed read is said, never read as 'no reset'", () => {
    expect(
      presenceRecoveryView(
        { isLoading: false, error: { message: "boom" } },
        NOW
      )
    ).toEqual({ kind: "failed", detail: "boom" });
    expect(
      presenceRecoveryView(
        { isLoading: false, error: { data: { code: "UNAUTHORIZED" } } },
        NOW
      )
    ).toEqual({ kind: "signedOut" });
    expect(presenceRecoveryView({ isLoading: true }, NOW)).toEqual({
      kind: "loading",
    });
  });

  it("a stale sign-in on Finish is told apart from other refusals", () => {
    expect(needsFreshSignIn({ data: { reasonCode: "STEP_UP_REQUIRED" } })).toBe(
      true
    );
    expect(needsFreshSignIn({ data: { reasonCode: "CONFLICT" } })).toBe(false);
    expect(needsFreshSignIn(new Error("x"))).toBe(false);
  });
});
