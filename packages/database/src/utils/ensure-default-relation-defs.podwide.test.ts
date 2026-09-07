/**
 * Proves the pod-wide seeding half: `ensureDefaultRelationDefs(null, …)` writes
 * the 22 defaults as BASE rows (`workspace_id IS NULL`), and is idempotent
 * without relying on the unique partial index (migration 0118) as control flow.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let existingRows: Array<{ slug: string; workspaceId: string | null }> = [];
const captured: { inserts: Array<Record<string, unknown>> } = { inserts: [] };

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      relationDefs: {
        findMany: async () => existingRows,
        // `create()` dedups by scope; nothing pre-exists in the seeding test.
        findFirst: async () => undefined,
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.inserts.push(v);
        return { returning: async () => [{ id: "new-id", ...v }] };
      },
    }),
  };
  return { getDb: async () => db, sql: {} };
});

const { ensureDefaultRelationDefs } =
  await import("./ensure-default-relation-defs.js");
const { DEFAULT_RELATION_DEFS } = await import("./default-relation-defs.js");

describe("ensureDefaultRelationDefs — pod-wide base layer", () => {
  beforeEach(() => {
    existingRows = [];
    captured.inserts.length = 0;
  });

  it("seeds every default as a POD-WIDE row when called with a null workspace", async () => {
    const result = await ensureDefaultRelationDefs(null, "system");

    expect(result.status).toBe("created");
    expect(result.defsCreated).toBe(DEFAULT_RELATION_DEFS.length);
    expect(captured.inserts.length).toBe(DEFAULT_RELATION_DEFS.length);

    // The whole point: these rows must be pod-wide, not attributed to a
    // workspace. A non-null workspaceId here would leave the pod-scoped door
    // (capture under a project focus, link_entities with no workspaceId)
    // resolving nothing, which is the defect being fixed.
    for (const row of captured.inserts) {
      expect(row.workspaceId).toBeNull();
    }
    expect(new Set(captured.inserts.map((r) => r.slug)).size).toBe(
      DEFAULT_RELATION_DEFS.length
    );
  });

  it("is idempotent — a second boot writes nothing", async () => {
    existingRows = DEFAULT_RELATION_DEFS.map((d) => ({
      slug: d.slug,
      workspaceId: null,
    }));

    const result = await ensureDefaultRelationDefs(null, "system");

    // Idempotence must come from the existence check, NOT from a unique-index
    // violation used as control flow.
    expect(result.status).toBe("skipped");
    expect(captured.inserts.length).toBe(0);
  });

  it("reports a workspace covered ONLY by the base layer as pod-wide coverage", async () => {
    // This is the new-workspace-on-a-seeded-pod state: `list(ws)` returns the
    // globals, so nothing is missing and no workspace rows are created. The
    // result must SAY the coverage is pod-wide, so a "skipped" is never read as
    // "this workspace was seeded".
    existingRows = DEFAULT_RELATION_DEFS.map((d) => ({
      slug: d.slug,
      workspaceId: null,
    }));

    const result = await ensureDefaultRelationDefs("ws-new", "user-1");

    expect(result.status).toBe("skipped");
    expect(result.defsCreated).toBe(0);
    expect(result.podWideCovered).toBe(DEFAULT_RELATION_DEFS.length);
  });
});
