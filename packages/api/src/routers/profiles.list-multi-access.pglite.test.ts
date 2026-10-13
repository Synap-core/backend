/**
 * `profiles.listMulti` × the workspace floor (homes final review G), on PGlite
 * through the REAL procedure and the real access check
 * (`validateWorkspaceAccess`, `utils/workspace-membership.ts`).
 *
 *   OWNED   — A owns it and has NO member row (a sovereign pod's owner): its
 *             workspace-scope kind must be listed. The member-only floor
 *             dropped it.
 *   MEMBER  — a space A joined. Without one, the procedure's no-workspace
 *             fallback (`getAccessibleProfiles(userId, "")`, already on the full
 *             floor) would mask the defect — so A holds one.
 *   STRANGE — private, owned by B, A neither member nor owner: its kind must
 *             never reach A, whether named or not.
 *
 * What this CANNOT see: production Postgres (DDL is generated from the Drizzle
 * tables) and the pod-visible branch (covered by the floor's own suites).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { router } from "../trpc.js";
import { profilesRouter } from "./profiles.js";

const testRouter = router({ listMulti: profilesRouter.listMulti });

const A = randomUUID();
const B = randomUUID();
const OWNED = randomUUID();
const STRANGE = randomUUID();
const MEMBER = randomUUID();
const OWNED_KIND = randomUUID();
const STRANGE_KIND = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function slugsFor(
  userId: string,
  workspaceIds?: string[]
): Promise<Set<string>> {
  const res = await testRouter
    .createCaller({
      authenticated: true,
      userId,
      workspaceId: null,
    } as never)
    .listMulti(workspaceIds ? { workspaceIds } : {});
  return new Set(res.profiles.map((p) => p.slug));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B])
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  // Neither space has a member row for A: OWNED is A's by owner_id only.
  for (const [ws, owner] of [
    [OWNED, A],
    [STRANGE, B],
    [MEMBER, B],
  ] as const)
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
      [ws, owner]
    );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), STRANGE, B]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), MEMBER, A]
  );
  for (const [id, slug, ws, owner] of [
    [OWNED_KIND, "owned_kind", OWNED, A],
    [STRANGE_KIND, "strange_kind", STRANGE, B],
  ] as const)
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id, user_id, is_active) values ($1,$2,'K','kind','workspace',$3,$4,true)`,
      [id, slug, ws, owner]
    );
}, 120_000);

describe("profiles.listMulti — the workspace floor includes OWNED spaces", () => {
  it("an owner with no member row sees their own space's kinds, named or not", async () => {
    expect((await slugsFor(A, [OWNED, MEMBER])).has("owned_kind")).toBe(true);
    expect((await slugsFor(A)).has("owned_kind")).toBe(true);
  });

  it("a private space A neither joined nor owns never leaks, even when named", async () => {
    expect((await slugsFor(A, [STRANGE])).has("strange_kind")).toBe(false);
    expect((await slugsFor(A)).has("strange_kind")).toBe(false);
    // The fixture is live: its owner does see it.
    expect((await slugsFor(B, [STRANGE])).has("strange_kind")).toBe(true);
  });
});
