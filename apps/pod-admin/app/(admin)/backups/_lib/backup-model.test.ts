import { describe, expect, it } from "vitest";
import {
  backupVerdict,
  directionWords,
  peerGaveUp,
  peerVerdict,
  syncSummary,
  SYNC_GIVES_UP_AFTER,
  type SyncPeerLike,
} from "./backup-model";

const rel = () => "3m ago";

const peer = (over: Partial<SyncPeerLike> = {}): SyncPeerLike => ({
  id: "p1",
  peerPodUrl: "https://cloud.example",
  direction: "push",
  enabled: true,
  syncState: {
    status: "idle",
    lastSyncAt: "2026-10-12T11:57:00Z",
    errorCount: 0,
    lastError: null,
  },
  ...over,
});

describe("peerVerdict", () => {
  it("caught up says when", () => {
    expect(peerVerdict(peer(), rel)).toEqual({
      kind: "healthy",
      label: "Caught up",
      sentence: "Caught up — last synced 3m ago.",
    });
  });

  it("switched off is down whatever its state", () => {
    expect(peerVerdict(peer({ enabled: false }), rel).label).toBe("Off");
  });

  it("an error still retrying is stale and counts the attempts", () => {
    const v = peerVerdict(
      peer({
        syncState: {
          status: "error",
          errorCount: 3,
          lastError: "ECONNREFUSED",
        },
      }),
      rel
    );
    expect(v.kind).toBe("stale");
    expect(v.sentence).toBe(
      "Failing — 3 failed attempts in a row, still retrying."
    );
  });

  it("past the workers' limit it has stopped and says so", () => {
    const p = peer({
      syncState: {
        status: "error",
        errorCount: SYNC_GIVES_UP_AFTER,
        lastError: "401",
      },
    });
    expect(peerGaveUp(p)).toBe(true);
    expect(peerVerdict(p, rel)).toMatchObject({
      kind: "down",
      label: "Stopped",
    });
  });

  it("a lastError alone counts as an error", () => {
    expect(
      peerVerdict(
        peer({ syncState: { status: "idle", errorCount: 0, lastError: "x" } }),
        rel
      ).label
    ).toBe("Failing");
  });

  it("no state yet is unknown, never healthy", () => {
    expect(peerVerdict(peer({ syncState: null }), rel)).toMatchObject({
      kind: "unknown",
      label: "Not yet",
    });
  });
});

describe("syncSummary", () => {
  it("no peers is standalone", () => {
    expect(syncSummary([]).label).toBe("Standalone");
  });

  it("failing outranks off, and counts only enabled peers as failing", () => {
    const s = syncSummary([
      peer({ id: "a", enabled: false }),
      peer({
        id: "b",
        syncState: { status: "error", errorCount: 1, lastError: "x" },
      }),
      peer({ id: "c" }),
    ]);
    expect(s).toMatchObject({ kind: "stale", label: "1 failing" });
    expect(s.sentence).toBe("1 of 3 peers is failing to sync.");
  });

  it("all good says so", () => {
    expect(syncSummary([peer(), peer({ id: "b" })]).sentence).toBe(
      "All 2 peers are in sync."
    );
  });
});

describe("backupVerdict", () => {
  it.each([
    ["ok", "healthy", "Healthy"],
    ["stale", "stale", "Stale"],
    ["error", "down", "Failing"],
    ["never", "unknown", "Never"],
  ] as const)("%s → %s", (status, kind, label) => {
    expect(backupVerdict(status, "2026-10-12T06:00:00Z", rel)).toMatchObject({
      kind,
      label,
    });
  });

  it("names the last good backup when there is one", () => {
    expect(backupVerdict("ok", "2026-10-12T06:00:00Z", rel).sentence).toBe(
      "Backed up 3m ago."
    );
    expect(backupVerdict("stale", null, rel).sentence).toBe(
      "No backup has ever succeeded."
    );
  });
});

describe("directionWords", () => {
  it("words each direction and falls back calmly", () => {
    expect(directionWords("push")).toBe("Sends to");
    expect(directionWords("bidirectional")).toBe("Syncs both ways with");
    expect(directionWords("sideways")).toBe("Syncs with");
  });
});
