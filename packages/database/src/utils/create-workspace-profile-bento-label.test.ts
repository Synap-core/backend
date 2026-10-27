/**
 * The auto-generated profile bento's stat-card label in the create path.
 *
 * The label prefers the profile ROW's stored `plural` — data — and only falls
 * back to the legacy string when the row has none. No pluralizer is introduced.
 * (Written when `@synap/database` could not import `@synap-core/types`; it can
 * now, but moving this label to the vocabulary door would change its words —
 * a decision of its own, not made here.)
 *
 * NOT covered here: that the resolved row's `plural` reaches the builder through
 * `profileHintsMap` (profile step + resume rebuild) — that threading is proven by
 * the typecheck only, not by a test driving the create door.
 */
import { describe, it, expect, vi } from "vitest";

// Pure builder under test; the module graph only needs these names to exist.
vi.mock("../client-pg.js", () => ({
  getDb: async () => ({}),
  sql: {},
  db: {},
}));

const { buildDefaultProfileBentoBlocks } =
  await import("./create-workspace-from-definition.js");

function statLabel(plural: string | null | undefined): unknown {
  const blocks = buildDefaultProfileBentoBlocks({
    slug: "company",
    displayName: "Company",
    plural,
  });
  const stat = blocks.find((b) => b.widgetType === "stat-card");
  expect(stat).toBeDefined();
  return (stat!.config as { label?: unknown }).label;
}

describe("create path: profile bento stat-card label", () => {
  it("uses the row's stored plural when present (irregular: Companies)", () => {
    expect(statLabel("Companies")).toBe("Total Companies");
  });

  it("absent plural (null / undefined / empty) keeps today's label unchanged", () => {
    expect(statLabel(null)).toBe("Total Companys");
    expect(statLabel(undefined)).toBe("Total Companys");
    expect(statLabel("")).toBe("Total Companys");
  });
});
