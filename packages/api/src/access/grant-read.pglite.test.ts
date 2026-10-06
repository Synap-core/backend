/**
 * W1e — scoped reads honour the calling key's grant.
 *
 * Through the REAL `scopedDb(AccessContext).findMany` on PGlite with every
 * @synap/database table, inside `runWithGrant` (what the key-auth doors enter).
 * The control case — no grant — proves the human floor alone shows every row,
 * so each narrower result below is the GRANT at work, not the floor.
 *
 * Rows rule out: the kind ignored (task visible to a knowledge-only grant), the
 * profile slug ignored in favour of legacy `type` only, the workspace set
 * ignored, an unrelated subject leaking (documents to an entity-only grant).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documents, entities } from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { AccessContext, scopedDb } from "./index.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import { sessionReadableWhere } from "./session-visibility.js";
import { channels, focusSessions } from "@synap/database/schema";

const ALICE = "alice-grant";
const WA = randomUUID();
const WB = randomUUID();
const KNOWLEDGE_PROFILE = randomUUID();
const K_A = randomUUID(); // knowledge (via profile slug), workspace A
const K_B = randomUUID(); // knowledge (via legacy type), workspace B
const T_A = randomUUID(); // task, workspace A
const DOC = randomUUID();
const CHAN = randomUUID();
const SESS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'a@x', 'human')`,
    [ALICE]
  );
  for (const ws of [WA, WB]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, 'w', $2, '{}'::jsonb)`,
      [ws, ALICE]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, ALICE]
    );
  }
  await q(`insert into profiles (id, slug) values ($1, 'knowledge')`, [
    KNOWLEDGE_PROFILE,
  ]);
  await q(
    `insert into entities (id, type, profile_id, user_id, workspace_id) values
       ($1, 'note', $2, $5, $6), ($3, 'knowledge', null, $5, $7), ($4, 'task', null, $5, $6)`,
    [K_A, KNOWLEDGE_PROFILE, K_B, T_A, ALICE, WA, WB]
  );
  await q(
    `insert into documents (id, title, user_id, workspace_id) values ($1, 'd', $2, $3)`,
    [DOC, ALICE, WA]
  );
  await q(
    `insert into channels (id, user_id, channel_type, status) values ($1, $2, 'ai_thread', 'active')`,
    [CHAN, ALICE]
  );
  await q(
    `insert into focus_sessions (id, user_id, goal, status) values ($1, $2, 'g', 'active')`,
    [SESS, ALICE]
  );
});

const read = async (table: object, grant?: GrantScope) => {
  const run = () =>
    scopedDb(AccessContext.operator({ userId: ALICE })).findMany<{
      id: string;
    }>(table);
  const rows = grant ? await runWithGrant(grant, run) : await run();
  return rows.map((r) => r.id).sort();
};

describe("scopedDb honours the key's grant (W1e)", () => {
  it("CONTROL — no grant: the floor alone shows every row", async () => {
    expect(await read(entities)).toEqual([K_A, K_B, T_A].sort());
    expect(await read(documents)).toEqual([DOC]);
  });

  it("a kind grant shows that kind only — by profile slug AND legacy type", async () => {
    expect(
      await read(entities, { permissions: ["entity.knowledge.read"] })
    ).toEqual([K_A, K_B].sort());
  });

  it("a workspace set narrows within the kind", async () => {
    expect(
      await read(entities, { permissions: ["entity.read"], workspaceIds: [WA] })
    ).toEqual([K_A, T_A].sort());
  });

  it("an entity pin shows only that object", async () => {
    expect(
      await read(entities, { permissions: ["entity"], entityIds: [T_A] })
    ).toEqual([T_A]);
  });

  it("a subject the grant does not name is invisible", async () => {
    expect(await read(documents, { permissions: ["entity.read"] })).toEqual([]);
    expect(await read(documents, { permissions: ["document.read"] })).toEqual([
      DOC,
    ]);
  });

  it("a write-only grant reads nothing, and deny-all reads nothing", async () => {
    expect(
      await read(entities, { permissions: ["entity.knowledge.create"] })
    ).toEqual([]);
    expect(await read(entities, { permissions: [] })).toEqual([]);
  });

  it("the explicit full-access grant reads like the floor", async () => {
    expect(await read(entities, { permissions: ["*"] })).toEqual(
      [K_A, K_B, T_A].sort()
    );
  });
});

describe("the DATA-table seam (accessScopeWhere) honours the grant too", () => {
  // Doors such as the entities router read through this seam directly, not
  // through scopedDb — the clause must land here as well.
  const seamRead = async (grant?: GrantScope) => {
    const run = () =>
      (
        h.db as {
          select: (c: object) => {
            from: (t: object) => {
              where: (w: unknown) => Promise<{ id: string }[]>;
            };
          };
        }
      )
        .select({ id: entities.id })
        .from(entities)
        .where(
          accessScopeWhere({
            workspaceIdColumn: entities.workspaceId,
            entityIdColumn: entities.id,
            ownerColumn: entities.userId,
            userId: ALICE,
          })
        );
    const rows = grant ? await runWithGrant(grant, run) : await run();
    return rows.map((r) => r.id).sort();
  };

  it("CONTROL — no grant: every row", async () => {
    expect(await seamRead()).toEqual([K_A, K_B, T_A].sort());
  });

  it("a kind grant narrows the seam", async () => {
    expect(await seamRead({ permissions: ["entity.task.read"] })).toEqual([
      T_A,
    ]);
  });
});

describe("the shared channel and session helpers honour the grant", () => {
  type Sel = {
    select: (c: object) => {
      from: (t: object) => { where: (w: unknown) => Promise<{ id: string }[]> };
    };
  };
  const ids = async (
    table: object,
    idCol: unknown,
    where: () => unknown,
    grant?: GrantScope
  ) => {
    const run = () =>
      (h.db as Sel)
        .select({ id: idCol as never })
        .from(table)
        .where(where());
    const rows = grant ? await runWithGrant(grant, run) : await run();
    return rows.map((r) => r.id);
  };

  it("channels: visible with no grant or channel.read, hidden from an entity-only grant", async () => {
    const w = () => channelVisibilityWhere(ALICE);
    expect(await ids(channels, channels.id, w)).toEqual([CHAN]);
    expect(
      await ids(channels, channels.id, w, { permissions: ["channel.read"] })
    ).toEqual([CHAN]);
    expect(
      await ids(channels, channels.id, w, { permissions: ["entity.read"] })
    ).toEqual([]);
  });

  it("sessions: visible with no grant or session.read, hidden from an entity-only grant", async () => {
    const w = () => sessionReadableWhere({ userId: ALICE });
    expect(await ids(focusSessions, focusSessions.id, w)).toEqual([SESS]);
    expect(
      await ids(focusSessions, focusSessions.id, w, {
        permissions: ["session.read"],
      })
    ).toEqual([SESS]);
    expect(
      await ids(focusSessions, focusSessions.id, w, {
        permissions: ["entity.read"],
      })
    ).toEqual([]);
  });
});
