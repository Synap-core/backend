import { describe, expect, it } from "vitest";
import { scopeSyncStatusToUser } from "./sync-status-scope.js";

describe("scopeSyncStatusToUser", () => {
  const rows = [
    { provider: "google", kind: "event", connectionId: "mine", error: "x" },
    {
      provider: "google",
      kind: "event",
      connectionId: "theirs",
      proposalId: "p-1",
    },
    {
      provider: "google",
      kind: "contact",
      phase: "failed",
      error: "no_connection",
    },
  ];

  it("drops another member's connection rows and keeps the caller's", () => {
    const scoped = scopeSyncStatusToUser(rows, new Set(["mine"]));
    expect(scoped.map((r) => r.connectionId ?? "(provider)")).toEqual([
      "mine",
      "(provider)",
    ]);
  });

  it("a user who owns no connection sees only provider-level rows", () => {
    expect(scopeSyncStatusToUser(rows, new Set())).toEqual([rows[2]]);
  });
});
