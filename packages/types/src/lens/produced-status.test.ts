/**
 * A Produced card's lifecycle status — the landed row's `status` (the
 * entity's `status` + `status_category`) through `lensOutputOfSignal` to the
 * mark both surfaces draw: words from the vocabulary, a tone TOKEN from the
 * category (`lifecycleOptionTone`). Absent or unknown ⇒ no mark, never a guess.
 */
import { describe, expect, it } from "vitest";
import { lensOutputOfSignal, type LensPageSignal } from "./page.js";

const output = (status?: unknown): LensPageSignal => ({
  id: "output:s1|entity:e1",
  kind: "output",
  title: "Pinned surfaces",
  landed: {
    kind: "entity",
    title: "Pinned surfaces",
    ref: { kind: "entity", id: "e1" },
    createdAt: "2026-10-22T09:00:00.000Z",
    entityProfile: { slug: "feature" },
    ...(status === undefined ? {} : { status: status as never }),
  },
});

describe("Produced card status", () => {
  it("a done status reads its words in the success tone", () => {
    expect(
      lensOutputOfSignal(output({ key: "delivered", category: "done" }))?.status
    ).toEqual({
      key: "delivered",
      label: "Delivered",
      tone: "success",
    });
  });

  it("an active one is the primary tone (work in flight)", () => {
    expect(
      lensOutputOfSignal(output({ key: "in_review", category: "active" }))
        ?.status?.tone
    ).toBe("primary");
  });

  it("no status, or a category outside the five, draws no mark", () => {
    expect(lensOutputOfSignal(output())).not.toHaveProperty("status");
    expect(lensOutputOfSignal(output(null))).not.toHaveProperty("status");
    expect(
      lensOutputOfSignal(output({ key: "x", category: "weird" }))
    ).not.toHaveProperty("status");
  });
});
