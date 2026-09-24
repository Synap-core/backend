/**
 * `skillRequiresTool` — verb resolution by PROVENANCE, on a real Postgres.
 *
 * The live defect this pins: a pod holding two skills named `calendar_list` —
 * a stale code skill tied to an old `google` tool, and the pack's declarative
 * one tied to the live tool. Resolving by name alone picked the stale one.
 * Connection sync now narrows to the skill whose `requires` edge points at the
 * connection's tool; this runs the EXACT fragment the executor uses (not a
 * copy), because its uuid→text cast only fails at runtime (SQLSTATE 42883).
 *
 * ENGINE: PGlite; `skills` and `links` are created from their drizzle
 * definitions (enums mapped to text, constraints dropped).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, and, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { links, skills } from "@synap/database/schema";
import { skillRequiresTool } from "./execute-capability.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

async function seed() {
  const client = new PGlite();
  await client.exec(ddlFor(skills as unknown as PgTable));
  await client.exec(ddlFor(links as unknown as PgTable));
  const oldTool = randomUUID();
  const liveTool = randomUUID();
  const stale = randomUUID();
  const current = randomUUID();
  for (const [id, kind] of [
    [stale, "code"],
    [current, "declarative"],
  ] as const) {
    await client.query(
      `insert into skills (id, name, kind) values ($1, 'calendar_list', $2)`,
      [id, kind]
    );
  }
  for (const [skillId, toolId] of [
    [stale, oldTool],
    [current, liveTool],
  ]) {
    await client.query(
      `insert into links (from_type, from_id, to_type, to_id, link_type)
       values ('skill', $1, 'tool', $2, 'requires')`,
      [skillId, toolId]
    );
  }
  // A non-`requires` edge to the live tool must not qualify the stale skill.
  await client.query(
    `insert into links (from_type, from_id, to_type, to_id, link_type)
     values ('skill', $1, 'tool', $2, 'member_of')`,
    [stale, liveTool]
  );
  return { db: drizzle(client), oldTool, liveTool, stale, current };
}

const byName = (toolId: string) =>
  and(eq(skills.name, "calendar_list"), skillRequiresTool(toolId));

describe("skillRequiresTool — a verb name resolves through the connection's tool", () => {
  it("the live tool answers with the pack's skill, never the stale same-named one", async () => {
    const { db, liveTool, current } = await seed();
    const rows = await db
      .select({ id: skills.id, kind: skills.kind })
      .from(skills)
      .where(byName(liveTool));
    expect(rows).toEqual([{ id: current, kind: "declarative" }]);
  });

  it("the old tool answers with its own skill — the pin is symmetric, not a preference", async () => {
    const { db, oldTool, stale } = await seed();
    const rows = await db
      .select({ id: skills.id })
      .from(skills)
      .where(byName(oldTool));
    expect(rows).toEqual([{ id: stale }]);
  });

  it("a tool no skill requires resolves to nothing — not_found, never a fallback", async () => {
    const { db } = await seed();
    const rows = await db
      .select({ id: skills.id })
      .from(skills)
      .where(byName(randomUUID()));
    expect(rows).toEqual([]);
  });
});
