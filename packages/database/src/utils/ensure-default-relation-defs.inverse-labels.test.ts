/**
 * Inverse-label convergence: an EXISTING default-slug row with no
 * `uiHints.inverseLabel` gets the curated one; a row that has one (even a
 * workspace's own wording) is never overwritten; nothing is stamped.
 *
 * Discriminating rows:
 *   - a workspace-scoped copy of a default (it shadows the base row by slug, so
 *     a base-only fill would leave the label invisible where it is read);
 *   - a row with a CUSTOM inverse label (a blind overwrite rule fills it);
 *   - a non-default slug (a slug-blind rule writes a label nobody curated);
 *   - other uiHints keys survive the merge.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  slug: string;
  workspaceId: string | null;
  uiHints: Record<string, unknown> | null;
};
let rows: Row[] = [];
const updates: Array<Record<string, unknown>> = [];

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      relationDefs: {
        findMany: async () => rows,
        findFirst: async () => undefined,
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => [{ id: "new-id", ...v }],
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(v);
            return [{ id: "x", ...v }];
          },
        }),
      }),
    }),
  };
  return { getDb: async () => db, sql: {} };
});

const { ensureDefaultRelationDefs } =
  await import("./ensure-default-relation-defs.js");
const { DEFAULT_RELATION_DEFS } = await import("./default-relation-defs.js");

/** Every default present as a pod-wide row WITH its current uiHints. */
function seededBase(): Row[] {
  return DEFAULT_RELATION_DEFS.map((d) => ({
    id: `base-${d.slug}`,
    slug: d.slug,
    workspaceId: null,
    uiHints: { ...d.uiHints },
  }));
}

beforeEach(() => {
  rows = [];
  updates.length = 0;
});

describe("ensureDefaultRelationDefs — inverse-label convergence", () => {
  it("fills an ABSENT inverse label on base AND workspace rows at boot, merging the rest of uiHints", async () => {
    rows = [
      ...seededBase().filter((r) => r.slug !== "mentions"),
      // base row seeded before the label existed
      {
        id: "base-mentions",
        slug: "mentions",
        workspaceId: null,
        uiHints: { category: "reference", color: "blue" },
      },
      // workspace copy that shadows the base row
      {
        id: "ws-blocks",
        slug: "blocks",
        workspaceId: "ws-1",
        uiHints: { category: "workflow" },
      },
    ];
    const result = await ensureDefaultRelationDefs(null, "system");
    expect(result.status).toBe("skipped");
    expect(result.inverseLabelsFilled).toBe(2);
    const hints = updates.map((u) => u.uiHints);
    expect(hints).toContainEqual({
      category: "reference",
      color: "blue",
      inverseLabel: "Mentioned in",
    });
    expect(hints).toContainEqual({
      category: "workflow",
      inverseLabel: "Blocked by",
    });
  });

  it("never overwrites a label a workspace set, and never labels a non-default slug", async () => {
    rows = [
      ...seededBase(),
      {
        id: "ws-refs",
        slug: "references",
        workspaceId: "ws-1",
        uiHints: { category: "reference", inverseLabel: "Cited by" },
      },
      {
        id: "custom",
        slug: "sponsors",
        workspaceId: "ws-1",
        uiHints: { category: "custom" },
      },
    ];
    const result = await ensureDefaultRelationDefs(null, "system");
    expect(result.inverseLabelsFilled).toBe(0);
    expect(updates).toEqual([]);
  });

  it("every directional default carries a curated inverse label", () => {
    const missing = DEFAULT_RELATION_DEFS.filter(
      (d) =>
        d.isDirectional &&
        !(d.uiHints as { inverseLabel?: string }).inverseLabel
    ).map((d) => d.slug);
    expect(missing).toEqual([]);
    // non-vacuity: the scan sees the defaults
    expect(DEFAULT_RELATION_DEFS.length).toBeGreaterThan(20);
  });
});
