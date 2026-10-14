/**
 * `media-urls` is DECLARED pod-wide: the real `ensureSystemProfiles()` on
 * PGlite seeds it as a GLOBAL property def (profile_id NULL, workspace_id
 * NULL), typed as an array of strings — the property capture producers write
 * external image URLs into and the media-copy job reads (any kind may carry
 * it, so it is not linked to one profile).
 *
 * Rows that rule out a wrong rule: a profile-base def (profile_id SET) would
 * be invisible to the other kinds that carry the property; a STRING def would
 * mistype the list the producers write.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import * as schema from "../schema/index.js";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => h.db };
});

import { ensureSystemProfiles } from "./ensure-system-profiles.js";

let pglite: Awaited<ReturnType<typeof makeLifecyclePglite>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pglite = await makeLifecyclePglite();
  db = pglite.db;
  h.db = db;
}, 120_000);
afterAll(async () => pglite?.pg.close());

describe("media-urls global property def", () => {
  it("is seeded once as a global array-of-strings def, idempotently", async () => {
    await ensureSystemProfiles();
    await ensureSystemProfiles();
    const rows = await db
      .select()
      .from(schema.propertyDefs)
      .where(eq(schema.propertyDefs.slug, "media-urls"));
    expect(rows).toHaveLength(1);
    const [def] = rows;
    expect(def.profileId).toBeNull();
    expect(def.workspaceId).toBeNull();
    expect(def.valueType).toBe("array");
    expect(def.uiHints).toMatchObject({ itemValueType: "string" });

    const globals = await db
      .select()
      .from(schema.propertyDefs)
      .where(
        and(
          isNull(schema.propertyDefs.profileId),
          isNull(schema.propertyDefs.workspaceId)
        )
      );
    // Non-vacuity: the seed under test really ran (its sibling global is there).
    expect(globals.map((g: { slug: string }) => g.slug)).toContain("favicon");
  });
});
