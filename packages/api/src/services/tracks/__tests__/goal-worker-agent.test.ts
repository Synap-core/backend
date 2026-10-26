import { describe, it, expect } from "vitest";
import { goalWorkerAgent } from "../track-participant-store.js";

const row = (
  principalId: string,
  over: Partial<{
    role: "owner" | "judge" | "delegate" | "integrator";
    principalKind: "agent" | "person";
    commitmentState: string | null;
    createdAt: Date;
  }> = {}
) => ({
  principalId,
  role: "delegate" as const,
  principalKind: "agent" as const,
  commitmentState: "accepted",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

describe("goalWorkerAgent — who a goal's next run is handed to", () => {
  it("an accepted agent delegate beats an older one only asked", () => {
    expect(
      goalWorkerAgent([
        row("asked", { commitmentState: "proposed", createdAt: new Date(1) }),
        row("yes", { createdAt: new Date(2) }),
      ] as never)
    ).toBe("yes");
  });
  it("among the same state, the first asked", () => {
    expect(
      goalWorkerAgent([
        row("second", { createdAt: new Date(2) }),
        row("first", { createdAt: new Date(1) }),
      ] as never)
    ).toBe("first");
  });
  it("never a person, never a closed commitment, never another role", () => {
    expect(
      goalWorkerAgent([
        row("person", { principalKind: "person" }),
        row("declined", { commitmentState: "declined" }),
        row("impossible", { commitmentState: "reported_impossible" }),
        row("done", { commitmentState: "done" }),
        row("owner", { role: "owner", commitmentState: null }),
      ] as never)
    ).toBeNull();
  });
  it("an agent only asked still gets it when nobody accepted", () => {
    expect(
      goalWorkerAgent([row("asked", { commitmentState: "countered" })] as never)
    ).toBe("asked");
  });
});
