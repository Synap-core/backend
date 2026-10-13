import { describe, it, expect, vi, afterEach } from "vitest";
import {
  catalogDetailHref,
  catalogFreshness,
  catalogKindLabel,
  countNoun,
  describeInstall,
} from "./catalog-model";

afterEach(() => vi.useRealTimers());

describe("catalogKindLabel", () => {
  it("names each catalog kind from the registry, tool-family kinds apart", () => {
    expect(catalogKindLabel("workspace")).toBe("Space");
    expect(catalogKindLabel("automation")).toBe("Rule");
    expect(catalogKindLabel("cell")).toBe("Card");
    expect(catalogKindLabel("capability")).toBe("Action");
    expect(catalogKindLabel("skill")).toBe("Skill");
  });
});

describe("countNoun", () => {
  it("uses the registry's singular and plural", () => {
    expect(countNoun("automation", 1)).toBe("1 rule");
    expect(countNoun("automation", 3)).toBe("3 rules");
    expect(countNoun("view", 2)).toBe("2 views");
  });
});

describe("catalogDetailHref", () => {
  it("carries kind and source, and encodes a cell's package/key slug", () => {
    expect(
      catalogDetailHref({
        kind: "cell",
        slug: "charts/bar",
        source: "https://cp.synap.live",
      })
    ).toBe(
      "/marketplace/charts%2Fbar?kind=cell&source=https%3A%2F%2Fcp.synap.live"
    );
  });
});

describe("catalogFreshness", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");
  const source = {
    source: "https://cp.synap.live",
    name: "Synap",
    enabled: true,
    lastSyncAt: "2026-10-13T11:55:00.000Z",
    unreachable: false,
  };

  it("is null with no enabled source (the empty state speaks instead)", () => {
    expect(catalogFreshness([])).toBeNull();
    expect(catalogFreshness([{ ...source, enabled: false }])).toBeNull();
  });

  it("says where the catalog is from and when it was refreshed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(catalogFreshness([source])).toBe("From Synap · refreshed 5m ago.");
  });

  it("says plainly when the source could not be reached", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(catalogFreshness([{ ...source, unreachable: true }])).toMatch(
      /^Couldn't reach Synap at the last attempt \(5m ago\)/
    );
  });

  it("says a source that never synced has not synced yet", () => {
    expect(catalogFreshness([{ ...source, lastSyncAt: null }])).toMatch(
      /has not synced yet/
    );
  });
});

describe("describeInstall", () => {
  it("a proposal is not an install", () => {
    const s = describeInstall({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "https://pod/open/p-1",
    });
    expect(s).toMatchObject({ tone: "stale", proposalId: "p-1" });
    expect(s.sentence).toMatch(/Sent for review/);
  });

  it("a template names a new space apart from an existing one", () => {
    expect(
      describeInstall({
        status: "installed",
        result: { kind: "template", workspaceId: "ws-1", created: true },
      })
    ).toMatchObject({
      tone: "healthy",
      workspaceId: "ws-1",
      sentence: "A new space was created from this package.",
    });
    expect(
      describeInstall({
        status: "installed",
        result: { kind: "template", workspaceId: "ws-1", created: false },
      }).sentence
    ).toMatch(/^Already installed/);
  });

  it("a template whose living layers failed says so and how to resume", () => {
    const s = describeInstall({
      status: "installed",
      result: {
        kind: "template",
        workspaceId: "ws-1",
        created: true,
        layers: [
          { layer: "post-workspace", status: "failed", message: "boom" },
        ],
      },
    });
    expect(s.tone).toBe("stale");
    expect(s.sentence).toContain("boom");
    expect(s.sentence).toContain("Install again to resume.");
  });

  it("automations report created, reused and failed items", () => {
    const s = describeInstall({
      status: "installed",
      result: {
        kind: "automation",
        automations: [
          { name: "A", status: "created" },
          { name: "B", status: "reused" },
          { name: "C", status: "error", message: "bad flow" },
        ],
      },
    });
    expect(s.tone).toBe("stale");
    expect(s.sentence).toBe(
      "Added 1 rule. 1 rule was already there. 1 rule could not be added: C (bad flow)."
    );
  });

  it("views report created, updated and failed", () => {
    expect(
      describeInstall({
        status: "installed",
        result: {
          kind: "view",
          created: ["Board"],
          updated: ["Calendar", "Table"],
          failed: [],
        },
      }).sentence
    ).toBe("Added 1 view. Updated 2 views.");
  });

  it("a capability re-install says nothing new was added", () => {
    expect(
      describeInstall({
        status: "installed",
        result: { kind: "capability", key: "gmail", created: false },
      }).sentence
    ).toBe("Already installed — nothing new was added.");
  });
});
