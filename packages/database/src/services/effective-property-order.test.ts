/**
 * Effective property defs must have a TOTAL, explicable order.
 *
 * THE DEFECT, measured on the live pod 2026-09-21. Base defs
 * (`workspaceId: null`) and workspace-overlay defs each run their OWN `0..n`
 * `displayOrder` sequence, and `getEffectiveProperties` sorted on that number
 * alone. Every rank was a cross-layer tie broken only by hierarchy-iteration
 * order. The real `task` kind in the Builder workspace produced:
 *
 *     0 → title (base)          AND task-status (overlay)
 *     1 → task-priority (overlay) AND status (base)
 *     2 → priority (base)       AND task-project (overlay)
 *
 * — an interleaving nobody chose. Worse, the overlay twins winning some ties
 * are the DEAD ones: over 60 real tasks, `status` is filled 51 times and
 * `task-status` 4; `dueDate` vs `task-due-date` is 2.
 *
 * WHY IT BLOCKED A FEATURE, which is why it is worth a test: we are deriving
 * per-kind projections (table columns, LLM context, subtitles) from these
 * defs. Derived from a coin-flip order led by empty fields, that projection
 * would have been WORSE than the hardcoded list it replaces. This is the
 * prerequisite, not a polish item.
 *
 * THE FIXTURE IS THE REAL COLLISION, copied from the live pod — a
 * hand-invented one would not have reproduced the cross-layer tie at all.
 *
 * WHAT THIS DOES NOT COVER, measured: it tests the comparator, which is the
 * whole of the ordering decision. It does not run `getEffectiveProperties`
 * end to end (that needs a DB), so it does not prove the resolver still keys
 * its map by slug — the property the comparator's TOTALITY depends on. That
 * invariant is stated in the comparator's own docblock and enforced by the
 * map, not by this file.
 */
import { describe, expect, it } from "vitest";
import { compareEffectiveProperties } from "./profile-resolution-service.js";

const BASE = null;
const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";

/** Verbatim from the live `task` kind: base and overlay defs, colliding. */
const TASK_DEFS = [
  { slug: "title", workspaceId: BASE, displayOrder: 0 },
  { slug: "task-status", workspaceId: WS, displayOrder: 0 },
  { slug: "task-priority", workspaceId: WS, displayOrder: 1 },
  { slug: "status", workspaceId: BASE, displayOrder: 1 },
  { slug: "priority", workspaceId: BASE, displayOrder: 2 },
  { slug: "task-project", workspaceId: WS, displayOrder: 2 },
];

const order = (defs: typeof TASK_DEFS): string[] =>
  [...defs].sort(compareEffectiveProperties).map((d) => d.slug);

describe("compareEffectiveProperties", () => {
  it("NON-VACUITY: the fixture really does contain cross-layer collisions", () => {
    // If the fixture stopped colliding, every assertion below would pass for
    // the wrong reason.
    const collisions = TASK_DEFS.filter((d) =>
      TASK_DEFS.some(
        (o) =>
          o !== d &&
          o.displayOrder === d.displayOrder &&
          o.workspaceId !== d.workspaceId
      )
    );
    expect(collisions.length).toBeGreaterThanOrEqual(6);
  });

  it("THE LIVE CASE: base defs come first, each layer in its own sequence", () => {
    expect(order(TASK_DEFS)).toEqual([
      "title",
      "status",
      "priority",
      "task-status",
      "task-priority",
      "task-project",
    ]);
  });

  it("is TOTAL — no pair compares equal, so the result cannot depend on sort stability", () => {
    // The property that makes the order reproducible across engines and across
    // insertion orders. If any pair ties, ordering silently depends on input
    // order again — the exact bug.
    const ties: string[] = [];
    for (const a of TASK_DEFS) {
      for (const b of TASK_DEFS) {
        if (a !== b && compareEffectiveProperties(a, b) === 0) {
          ties.push(`${a.slug}~${b.slug}`);
        }
      }
    }
    expect(ties).toEqual([]);
  });

  it("is STABLE against input order — shuffling the input cannot change the output", () => {
    // Directly refutes the old behaviour, where hierarchy-iteration order
    // decided who won a tie.
    const shuffled = [...TASK_DEFS].reverse();
    expect(order(shuffled)).toEqual(order(TASK_DEFS));
  });

  it("orders within a layer by displayOrder, not alphabetically", () => {
    const defs = [
      { slug: "zulu", workspaceId: BASE, displayOrder: 0 },
      { slug: "alpha", workspaceId: BASE, displayOrder: 1 },
    ];
    expect(order(defs)).toEqual(["zulu", "alpha"]);
  });

  it("falls back to slug ONLY when layer and displayOrder both tie", () => {
    // Same layer, same order — the all-zeros case that agent-authored kinds
    // produce today, since `define_kind` defaults displayOrder to 0.
    const defs = [
      { slug: "beta", workspaceId: BASE, displayOrder: 0 },
      { slug: "alpha", workspaceId: BASE, displayOrder: 0 },
    ];
    expect(order(defs)).toEqual(["alpha", "beta"]);
  });
});
