/**
 * REGRESSION GUARD for the silent-skip cascade opened by the pod-wide
 * relation-def base layer.
 *
 * Once the 22 defaults exist pod-wide (workspace_id IS NULL),
 * `ensureDefaultRelationDefs` correctly creates ZERO workspace rows for a new
 * workspace — the base layer already covers every slug. If
 * `seedPropertyRelationMappings` then looks defs up STRICTLY workspace-scoped
 * (`eq(relationDefs.workspaceId, workspaceId)`, as it did), it finds nothing and
 * `property_defs.relation_def_id` silently stops being set for every new
 * workspace. Nothing surfaces the miss: relations still resolve at the capture
 * door through the very fallback this lookup was missing.
 *
 * These tests therefore model a workspace with NO relation rows of its own and
 * assert the mappings are still written. That is the exact state a new
 * workspace is in on a seeded pod.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mutable mock state ───────────────────────────────────────────────────────
const MAPPED_SLUGS = [
  "assigned_to",
  "belongs_to_project",
  "works_at",
  "deal_for",
];

/**
 * The row set `RelationDefRepository.list(workspaceId)` returns for a NEW
 * workspace on a seeded pod: the pod-wide base rows and NOTHING of its own.
 * The seeder must resolve every mapping from these.
 */
let visibleRows: Array<{
  id: string;
  slug: string;
  workspaceId: string | null;
}> = [];

const captured: { updates: Array<Record<string, unknown>> } = { updates: [] };

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      propertyDefs: {
        // Every mapped property_def exists and is UNMAPPED (relationDefId null),
        // so the seeder always reaches the relation-def resolution under test.
        findFirst: async () => ({ id: "propdef-1", relationDefId: null }),
      },
      // `RelationDefRepository.list()` → findMany. Returning the rows verbatim
      // keeps this test blind to SQL shape and sensitive only to the JS
      // precedence rule, which is where the guard now lives.
      relationDefs: { findMany: async () => visibleRows },
      profiles: { findFirst: async () => ({ id: "profile-1" }) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          captured.updates.push(v);
          return [];
        },
      }),
    }),
  };
  return { getDb: async () => db, sql: {} };
});

const { seedPropertyRelationMappings } =
  await import("./seed-property-relation-mappings.js");

describe("seedPropertyRelationMappings — pod-wide fallback", () => {
  beforeEach(() => {
    visibleRows = MAPPED_SLUGS.map((slug) => ({
      id: `podwide-${slug}`,
      slug,
      workspaceId: null,
    }));
    captured.updates.length = 0;
  });

  it("sets relation_def_id from the POD-WIDE base layer when the workspace owns no relation defs", async () => {
    const result = await seedPropertyRelationMappings("ws-new");

    // THE regression: a new workspace on a seeded pod must still get its
    // property↔relation mappings. Zero updates here means every new workspace
    // silently ships with `relation_def_id` unset — invisible to every other
    // gate, because relations still resolve through the same fallback.
    expect(result.status).toBe("updated");
    expect(result.mappingsUpdated).toBe(MAPPED_SLUGS.length);
    expect(captured.updates.length).toBe(MAPPED_SLUGS.length);
    expect(captured.updates.map((u) => u.relationDefId).sort()).toEqual(
      MAPPED_SLUGS.map((s) => `podwide-${s}`).sort()
    );
  });

  it("prefers the WORKSPACE row over the pod-wide row for the same slug", async () => {
    visibleRows.push({
      id: "ws-assigned_to",
      slug: "assigned_to",
      workspaceId: "ws-new",
    });

    await seedPropertyRelationMappings("ws-new");

    const ids = captured.updates.map((u) => u.relationDefId);
    // Precedence must match `getBySlug`: a workspace override still wins.
    expect(ids).toContain("ws-assigned_to");
    expect(ids).not.toContain("podwide-assigned_to");
  });

  it("ignores another workspace's row", async () => {
    visibleRows = [
      { id: "other-ws-row", slug: "assigned_to", workspaceId: "ws-other" },
    ];

    const result = await seedPropertyRelationMappings("ws-new");

    // Widening WHERE we look must never cross a workspace boundary.
    expect(result.mappingsUpdated).toBe(0);
    expect(captured.updates.length).toBe(0);
  });

  it("writes nothing when neither a workspace row nor a pod-wide row exists", async () => {
    visibleRows = [];
    const result = await seedPropertyRelationMappings("ws-new");

    // The fallback must not invent a mapping — it only widens WHERE we look.
    expect(result.status).toBe("skipped");
    expect(captured.updates.length).toBe(0);
  });
});
