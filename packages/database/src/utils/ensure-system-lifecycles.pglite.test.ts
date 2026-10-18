/**
 * The core kinds' lifecycles (PGlite): the pass gives `task.status` its option
 * categories and declares it, keeps a value the pod added, fills existing rows'
 * columns, and converges — a second pass rewrites nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import { ensureSystemLifecycles } from "./ensure-system-lifecycles.js";
import { readStoredEnumOptions } from "./property-enum.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import * as schema from "../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;
let taskId: string;
let defId: string;
let rowId: string;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  const [task] = await db
    .insert(schema.profiles)
    .values({ slug: "task", displayName: "Task", scope: "system" })
    .returning();
  taskId = task.id;
  // The seeder's GLOBAL `status` def (bare strings) + a value the pod added.
  const [def] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "status",
      valueType: "string",
      constraints: {
        enum: ["todo", "in-progress", "done", "cancelled", "blocked"],
      },
    })
    .returning();
  defId = def.id;
  await db
    .insert(schema.profileProperties)
    .values({ profileId: taskId, propertyDefId: def.id });
  const [row] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      type: "task",
      profileId: taskId,
      properties: { status: "done" },
    })
    .returning();
  rowId = row.id;
}, 120_000);
afterAll(async () => h?.pg.close());

describe("ensureSystemLifecycles", () => {
  it("declares task.status with categories, keeps pod values, fills rows, converges", async () => {
    const first = await ensureSystemLifecycles(db);
    expect(first.declared).toContain("task");
    expect(first.optionsUpdated).toContain("task");

    const [def] = await db
      .select()
      .from(schema.propertyDefs)
      .where(eq(schema.propertyDefs.id, defId));
    expect(def.constraints.enum).toEqual([
      "todo",
      "in-progress",
      "done",
      "cancelled",
      "blocked",
    ]);
    expect(
      readStoredEnumOptions({ constraints: def.constraints })?.[3]
    ).toEqual({
      key: "cancelled",
      category: "lost",
    });

    const lc = await new ProfileResolutionService(db).getEffectiveLifecycle(
      taskId
    );
    expect(lc?.propertySlug).toBe("status");
    expect(lc?.unclassified).toEqual(["blocked"]);

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, rowId));
    expect([row.status, row.statusCategory]).toEqual(["done", "done"]);

    const second = await ensureSystemLifecycles(db);
    expect(second.optionsUpdated).toEqual([]);
    expect(second.declared).toEqual([]);
  });
});
