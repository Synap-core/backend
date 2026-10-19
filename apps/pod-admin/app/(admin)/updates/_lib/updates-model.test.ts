import { describe, expect, it } from "vitest";

import {
  currentRelease,
  outcomeView,
  parsePodUpdates,
  reasonInWords,
  updateCommand,
  updateIssue,
  type LastUpdate,
  type UpdateOutcome,
} from "./updates-model";

const settings = { auto: true, channel: "stable", explicit: false };

function outcome(over: Partial<UpdateOutcome> = {}): UpdateOutcome {
  return {
    status: "succeeded",
    from: "v1.0.0",
    to: "v1.1.0",
    at: "2026-10-01T10:00:00Z",
    reason: null,
    dbRestored: false,
    ...over,
  };
}

const recorded = (over?: Partial<UpdateOutcome>): LastUpdate => ({
  kind: "recorded",
  outcome: outcome(over),
});

describe("parsePodUpdates", () => {
  it("reads a recorded outcome", () => {
    const view = parsePodUpdates({
      settings,
      canEdit: true,
      lastUpdate: { read: "ok", outcome: { ...outcome(), updateId: "x" } },
    });
    expect(view?.settings).toEqual({ auto: true, channel: "stable" });
    expect(view?.canEdit).toBe(true);
    expect(view?.lastUpdate).toEqual({ kind: "recorded", outcome: outcome() });
  });

  it("tells 'never updated' from 'could not read'", () => {
    const base = { settings, canEdit: false };
    expect(
      parsePodUpdates({ ...base, lastUpdate: { read: "absent" } })?.lastUpdate
    ).toEqual({ kind: "none" });
    expect(
      parsePodUpdates({ ...base, lastUpdate: { read: "failed", error: "x" } })
        ?.lastUpdate
    ).toEqual({ kind: "unreadable" });
  });

  it("is not editable unless the pod says so", () => {
    const view = parsePodUpdates({
      settings,
      lastUpdate: { read: "absent" },
    });
    expect(view?.canEdit).toBe(false);
  });

  it("refuses a body that is not the contract instead of defaulting", () => {
    expect(parsePodUpdates(null)).toBeNull();
    expect(
      parsePodUpdates({ settings: null, lastUpdate: { read: "absent" } })
    ).toBeNull();
    expect(
      parsePodUpdates({
        settings: { auto: "yes", channel: "stable" },
        lastUpdate: { read: "absent" },
      })
    ).toBeNull();
    expect(
      parsePodUpdates({
        settings: { auto: true, channel: "nightly" },
        lastUpdate: { read: "absent" },
      })
    ).toBeNull();
  });
});

describe("outcomeView", () => {
  it("applied is healthy and does not need the owner", () => {
    const v = outcomeView(outcome());
    expect(v).toMatchObject({
      token: "applied",
      kind: "healthy",
      didNotLand: false,
      reason: null,
    });
    expect(v.sentence).toBe("Updated to v1.1.0.");
  });

  it("rolled back names where the pod is and the database", () => {
    const v = outcomeView(
      outcome({
        status: "rolled_back",
        reason: "backend migration failed",
        dbRestored: true,
      })
    );
    expect(v).toMatchObject({ token: "rolled_back", kind: "stale" });
    expect(v.didNotLand).toBe(true);
    expect(v.sentence).toContain("went back to v1.0.0");
    expect(v.sentence).toContain("database was restored");
    expect(v.reason).toBe("A database change in the new release failed.");
  });

  it("a failed rollback is down and says to check the host", () => {
    const v = outcomeView(outcome({ status: "rollback_failed" }));
    expect(v).toMatchObject({ kind: "down", didNotLand: true });
    expect(v.sentence).toContain("Check the machine hosting the pod");
  });

  it("aborted changed nothing, so it is not a task", () => {
    const v = outcomeView(
      outcome({ status: "aborted", reason: "not enough disk" })
    );
    expect(v.didNotLand).toBe(false);
    expect(v.reason).toBe("There wasn't enough free disk space.");
  });

  it("already on the release is up to date, not an unknown outcome", () => {
    const v = outcomeView(
      outcome({ status: "noop", from: "v1.1.0", to: "v1.1.0" })
    );
    expect(v).toMatchObject({
      token: "up_to_date",
      kind: "healthy",
      didNotLand: false,
    });
    expect(v.sentence).toBe("Already on v1.1.0; nothing needed to change.");
  });

  it("shows an unknown status as itself, never as success", () => {
    const v = outcomeView(outcome({ status: "paused" }));
    expect(v).toMatchObject({
      token: "other",
      kind: "unknown",
      label: "paused",
    });
  });
});

describe("reasonInWords", () => {
  it("falls back to the recorded string when it is unknown", () => {
    expect(reasonInWords("something new")).toBe("something new");
    expect(reasonInWords(null)).toBeNull();
  });

  it("covers the engine's rollback reasons", () => {
    expect(
      reasonInWords("the new backend image failed its canary health check")
    ).toBe("The new version didn't pass its health check.");
    expect(reasonInWords("below minFrom 0042")).toContain(
      "earlier release first"
    );
  });
});

describe("currentRelease", () => {
  it("is the target after an applied update", () => {
    expect(currentRelease(recorded())).toBe("v1.1.0");
  });

  it("is the release asked for when the pod was already on it", () => {
    expect(
      currentRelease(recorded({ status: "noop", from: "v1.1.0", to: "v1.1.0" }))
    ).toBe("v1.1.0");
  });

  it("is the previous release after a rollback or an abort", () => {
    expect(currentRelease(recorded({ status: "rolled_back" }))).toBe("v1.0.0");
    expect(currentRelease(recorded({ status: "aborted" }))).toBe("v1.0.0");
  });

  it("is unknown when it cannot be proved", () => {
    expect(currentRelease(recorded({ status: "rollback_failed" }))).toBeNull();
    expect(currentRelease(recorded({ status: "failed" }))).toBeNull();
    expect(currentRelease({ kind: "none" })).toBeNull();
    expect(currentRelease({ kind: "unreadable" })).toBeNull();
  });
});

describe("updateIssue", () => {
  it("raises a rollback as stale with the reason", () => {
    expect(
      updateIssue(
        recorded({ status: "rolled_back", reason: "image pull failed" })
      )
    ).toEqual({
      kind: "stale",
      headline: "The last update was rolled back",
      secondary: "The new release's images couldn't be downloaded.",
    });
  });

  it("raises a failure as down", () => {
    expect(updateIssue(recorded({ status: "failed" }))?.kind).toBe("down");
    expect(updateIssue(recorded({ status: "rollback_failed" }))).toMatchObject({
      kind: "down",
      headline: "The last update failed and could not roll back",
    });
  });

  it("stays quiet for applied, aborted, unknown and unreadable", () => {
    expect(updateIssue(recorded())).toBeNull();
    expect(updateIssue(recorded({ status: "aborted" }))).toBeNull();
    expect(updateIssue({ kind: "none" })).toBeNull();
    expect(updateIssue({ kind: "unreadable" })).toBeNull();
  });
});

describe("updateCommand", () => {
  it("names the channel the pod follows", () => {
    expect(updateCommand("stable")).toBe("synap update --release stable");
    expect(updateCommand("fast")).toBe("synap update --release fast");
  });
});
