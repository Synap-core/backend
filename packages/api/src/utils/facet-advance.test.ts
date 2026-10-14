/**
 * Forward-only advance for a DECLARED lifecycle reads the category, never the
 * position (review arch F7 / backend F14). Each row is one where position and
 * category DISAGREE, so it rules the positional rule out.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ lifecycle: null as unknown }));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  ProfileResolutionService: class {
    async getEffectiveLifecycle() {
      return h.lifecycle;
    }
  },
}));

import {
  advanceExistingFacet,
  isForwardCategory,
  isForwardStage,
} from "./facet-advance.js";

// leadStage with an overlay-APPENDED open option (`cold`) and `qualified`
// (done) declared BEFORE `engaged` (active) — the order lies, the category
// does not.
const ORDER = [
  "new",
  "qualified",
  "engaged",
  "nurturing",
  "disqualified",
  "cold",
];
const CATS = {
  new: "open",
  qualified: "done",
  engaged: "active",
  nurturing: "paused",
  disqualified: "lost",
  cold: "open",
} as const;

describe("isForwardCategory — a booking moves a lead to engaged", () => {
  it("an open lead declared AFTER engaged still advances (position says no)", () => {
    expect(isForwardStage(ORDER, "cold", "engaged")).toBe(false);
    expect(isForwardCategory(CATS, "cold", "engaged")).toBe(true);
  });

  it("a done lead declared BEFORE engaged is never pulled back (position says yes)", () => {
    expect(isForwardStage(ORDER, "qualified", "engaged")).toBe(true);
    expect(isForwardCategory(CATS, "qualified", "engaged")).toBe(false);
  });

  it("no status advances; active stays; paused and lost are never left", () => {
    expect(isForwardCategory(CATS, null, "engaged")).toBe(true);
    expect(isForwardCategory(CATS, "engaged", "engaged")).toBe(false);
    expect(isForwardCategory(CATS, "nurturing", "engaged")).toBe(false);
    expect(isForwardCategory(CATS, "disqualified", "engaged")).toBe(false);
    expect(isForwardCategory(CATS, "unknown", "engaged")).toBe(false);
  });
});

describe("advanceExistingFacet — the declared path uses the category rule", () => {
  h.lifecycle = {
    propertySlug: "leadStage",
    options: ORDER.map((key) => ({
      key,
      category: CATS[key as keyof typeof CATS],
    })),
  };
  const run = async (status: string) => {
    const updateFacet = vi.fn().mockResolvedValue({ status: "moved" });
    const r = await advanceExistingFacet(
      { updateFacet },
      { id: "f1", profileId: "lead", status },
      { status: "engaged", properties: { leadStage: "engaged" } }
    );
    return { r, calls: updateFacet.mock.calls.length };
  };

  it("advances a lead at an appended open option, keeps a done one", async () => {
    expect(await run("cold")).toEqual({ r: "advanced", calls: 1 });
    expect(await run("qualified")).toEqual({ r: "kept", calls: 0 });
  });
});
