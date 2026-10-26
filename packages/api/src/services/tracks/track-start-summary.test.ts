import { describe, expect, it } from "vitest";
import {
  TRACK_SPACE_GRANT_KEY,
  buildTrackStartSummary,
} from "./track-start-summary.js";

const grant = {
  [TRACK_SPACE_GRANT_KEY]: {
    agentName: "Claude Code",
    spaces: [{ workspaceId: "w1", name: "Strategy" }],
  },
};

describe("buildTrackStartSummary", () => {
  it("a plain start has no sentence of its own", () => {
    expect(buildTrackStartSummary("track", "create", { name: "Grow" })).toBe(
      null
    );
    expect(buildTrackStartSummary("track", "update", grant)).toBe(null);
  });

  it("states the space grant", () => {
    expect(
      buildTrackStartSummary("track", "create", { name: "Grow", ...grant })
    ).toBe(
      'Create Goal "Grow" and let Claude Code work in Strategy for this goal'
    );
  });

  it("states what the goal is made from, and how an ended entity arrives (D2)", () => {
    expect(
      buildTrackStartSummary("track", "create", {
        name: "Q4 growth",
        fromEntity: {
          entityId: "e1",
          kind: "okr",
          title: "Q4 growth",
          ended: null,
        },
      })
    ).toBe('Create Goal "Q4 growth" from OKR "Q4 growth"');
    expect(
      buildTrackStartSummary("track", "create", {
        name: "Run",
        fromEntity: {
          entityId: "e2",
          kind: "goal",
          title: "Run",
          ended: { status: "completed", verdict: "met" },
        },
        ...grant,
      })
    ).toBe(
      'Create Goal "Run" from goal "Run" — Closed (Met) and let Claude Code work in Strategy for this goal'
    );
    expect(
      buildTrackStartSummary("track", "create", {
        name: "Oboe",
        fromEntity: {
          entityId: "e3",
          kind: "objective",
          title: "Oboe",
          ended: { status: "archived", verdict: "no_longer_needed" },
        },
      })
    ).toBe(
      'Create Goal "Oboe" from objective "Oboe" — Dropped (No longer needed)'
    );
  });
});
