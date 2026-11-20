/**
 * The one usable-in-space rule on PGlite: home, pod-wide, or a `space_access`
 * grant — the function form and the SQL form agree on every case, and a grant
 * of one object type never admits another type's object of the same id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import {
  notUsableInSpaceReason,
  usableInSpace,
  usableInSpaceWhere,
  usableWith,
} from "./usable-in-space.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const POD = "44444444-4444-4444-8444-444444444444";
const HOMED = "55555555-5555-4555-8555-555555555555";
const SHARED = "66666666-6666-4666-8666-666666666666";

const things = pgTable("things", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id"),
  name: text("name").notNull(),
});

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create table space_access (
      object_type text not null, object_id uuid not null, workspace_id uuid not null,
      granted_by text, granted_at timestamptz not null default now(),
      primary key (object_type, object_id, workspace_id)
    );
    create table things (id uuid primary key, workspace_id uuid, name text not null);
    insert into things values ('${POD}', null, 'pod'), ('${HOMED}', '${A}', 'homed'), ('${SHARED}', '${A}', 'shared');
    insert into space_access (object_type, object_id, workspace_id)
      values ('playbook', '${SHARED}', '${B}'), ('skill', '${HOMED}', '${B}');
  `);
  db = drizzle(pg);
});
afterAll(async () => {
  await pg.close();
});

const CASES: Array<[string, string, string | null, boolean]> = [
  ["pod-wide, in a space", POD, B, true],
  ["pod-wide, outside any space", POD, null, true],
  ["homed, at home", HOMED, A, true],
  ["homed, elsewhere", HOMED, B, false],
  ["homed, outside any space", HOMED, null, false],
  ["shared, in the granted space", SHARED, B, true],
  ["shared, in a space not granted", SHARED, C, false],
  ["shared, outside any space", SHARED, null, false],
];

describe("usableInSpace — one rule, function and SQL", () => {
  it.each(CASES)("%s", async (_label, id, space, expected) => {
    const object = { id, workspaceId: id === POD ? null : A };
    expect(await usableInSpace(db, "playbook", object, space)).toBe(expected);
    const listed = await db
      .select({ id: things.id })
      .from(things)
      .where(
        usableInSpaceWhere("playbook", things.id, things.workspaceId, space)
      );
    expect(listed.map((r) => r.id).includes(id)).toBe(expected);
  });

  it("a grant is per object type: a skill grant does not share a playbook", async () => {
    expect(
      await usableInSpace(db, "playbook", { id: HOMED, workspaceId: A }, B)
    ).toBe(false);
    expect(
      await usableInSpace(db, "skill", { id: HOMED, workspaceId: A }, B)
    ).toBe(true);
  });

  it("the pure rule reads only the grants it is given", () => {
    expect(usableWith({ workspaceId: A }, B)).toBe(false);
    expect(usableWith({ workspaceId: A }, B, new Set([B]))).toBe(true);
    expect(usableWith({ workspaceId: A }, null, new Set([B]))).toBe(false);
  });

  it("the refusal names where it lives and both fixes", () => {
    expect(
      notUsableInSpaceReason(
        "Playbook",
        { id: HOMED, workspaceId: A, name: "Ship" },
        B
      )
    ).toBe(
      `Playbook "Ship" (${HOMED}) lives in space ${A}, so it is not visible in space ${B}: run it in space ${A}, or share it with space ${B}.`
    );
  });
});
