/**
 * `retireCapabilityShadows` on a real Postgres — the removal can only ever
 * touch what the shadow list shows, never strands a skill, and leaves the pack
 * alone.
 *
 * ENGINE: PGlite; `skills`, `tools`, `links`, `vault_grants` are created from
 * their drizzle definitions (enums mapped to text, constraints dropped). The
 * shadow SET is injected (`load`) so this test is about the transaction, not
 * the visibility SQL; `classifyShadows` has its own pure test.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return { db: undefined as unknown };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { links, skills, tools, vaultGrants } from "@synap/database/schema";
import {
  retireCapabilityShadows,
  type CapabilityShadow,
} from "./capability-shadows.js";

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

const PACK = randomUUID();

async function seed() {
  const client = new PGlite();
  for (const t of [skills, tools, links, vaultGrants]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client);
  const id = {
    toolLive: randomUUID(),
    toolOld: randomUUID(),
    calLive: randomUUID(),
    calOld: randomUUID(),
  };
  await client.query(
    `insert into tools (id, name) values ($1, 'google'), ($2, 'google')`,
    [id.toolLive, id.toolOld]
  );
  await client.query(
    `insert into skills (id, name, kind) values ($1, 'calendar_list', 'declarative'), ($2, 'calendar_list', 'code')`,
    [id.calLive, id.calOld]
  );
  const edge = (ft: string, f: string, tt: string, t: string, lt: string) =>
    client.query(
      `insert into links (from_type, from_id, to_type, to_id, link_type) values ($1,$2,$3,$4,$5)`,
      [ft, f, tt, t, lt]
    );
  await edge("tool", id.toolLive, "capability", PACK, "member_of");
  await edge("skill", id.calLive, "capability", PACK, "member_of");
  await edge("skill", id.calLive, "tool", id.toolLive, "requires");
  await edge("skill", id.calOld, "tool", id.toolOld, "requires");
  await client.query(
    `insert into vault_grants (grantable_type, grantable_id) values ('skill', $1), ('skill', $2)`,
    [id.calOld, id.calLive]
  );

  const shadow = (
    type: "skill" | "tool",
    sid: string,
    name: string
  ): CapabilityShadow => ({
    type,
    id: sid,
    name,
    workspaceId: null,
    shadows: [{ id: "x", containerId: PACK, containerName: "Pack" }],
  });
  const set = [
    shadow("skill", id.calOld, "calendar_list"),
    shadow("tool", id.toolOld, "google"),
  ];
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await client.query<{ n: number }>(sql, params)).rows[0]!.n);
  return { client, id, load: async () => set, count };
}

const allow = async () => {};

describe("retireCapabilityShadows", () => {
  it("removes the stale skill + tool, their edges, and revokes their grants — the pack is untouched", async () => {
    const { id, load, count } = await seed();
    const res = await retireCapabilityShadows({
      userId: "u1",
      ids: [id.calOld, id.toolOld],
      authorize: allow,
      load,
    });
    expect(res.refused).toEqual([]);
    expect(res.retired.map((r) => r.id).sort()).toEqual(
      [id.calOld, id.toolOld].sort()
    );
    expect(
      await count(`select count(*)::int n from skills where id = $1`, [
        id.calOld,
      ])
    ).toBe(0);
    expect(
      await count(`select count(*)::int n from tools where id = $1`, [
        id.toolOld,
      ])
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int n from links where from_id = $1 or to_id = $1`,
        [id.calOld]
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int n from vault_grants where grantable_id = $1 and revoked_at is not null`,
        [id.calOld]
      )
    ).toBe(1);
    // The pack's own parts, edges and grants survive.
    expect(
      await count(`select count(*)::int n from skills where id = $1`, [
        id.calLive,
      ])
    ).toBe(1);
    expect(
      await count(`select count(*)::int n from tools where id = $1`, [
        id.toolLive,
      ])
    ).toBe(1);
    expect(
      await count(`select count(*)::int n from links where to_id = $1`, [PACK])
    ).toBe(2);
    expect(
      await count(
        `select count(*)::int n from vault_grants where grantable_id = $1 and revoked_at is null`,
        [id.calLive]
      )
    ).toBe(1);
  });

  it("refuses an id that is not a shadow — a pack member is never removable here", async () => {
    const { id, load, count } = await seed();
    const res = await retireCapabilityShadows({
      userId: "u1",
      ids: [id.calLive],
      authorize: allow,
      load,
    });
    expect(res.retired).toEqual([]);
    expect(res.refused).toEqual([
      { id: id.calLive, reason: "not a shadow (or not visible to you)" },
    ]);
    expect(
      await count(`select count(*)::int n from skills where id = $1`, [
        id.calLive,
      ])
    ).toBe(1);
  });

  it("refuses a stale tool while a skill that is NOT being removed still requires it", async () => {
    const { id, load, count } = await seed();
    const res = await retireCapabilityShadows({
      userId: "u1",
      ids: [id.toolOld],
      authorize: allow,
      load,
    });
    expect(res.retired).toEqual([]);
    expect(res.refused).toEqual([
      {
        id: id.toolOld,
        reason: "1 skill(s) outside this removal still require this tool",
      },
    ]);
    expect(
      await count(`select count(*)::int n from tools where id = $1`, [
        id.toolOld,
      ])
    ).toBe(1);
  });

  it("a row the caller may not remove is refused with the floor's reason", async () => {
    const { id, load, count } = await seed();
    const res = await retireCapabilityShadows({
      userId: "u1",
      ids: [id.calOld],
      authorize: async () => {
        throw new Error("pod admin only");
      },
      load,
    });
    expect(res.refused).toEqual([{ id: id.calOld, reason: "pod admin only" }]);
    expect(
      await count(`select count(*)::int n from skills where id = $1`, [
        id.calOld,
      ])
    ).toBe(1);
  });
});
