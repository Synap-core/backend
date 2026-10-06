/**
 * W1d — the write gate enforces the calling key's grant.
 *
 * Driven through the REAL `checkPermissionOrPropose` inside `runWithGrant`
 * (what the three key-auth doors enter), on PGlite with every @synap/database
 * table, so the kind of an EXISTING entity is read from the database — the
 * request key is never taken from the caller.
 *
 * Each row rules out one wrong implementation:
 *  - the kind ignored          → "update a task with a knowledge-only grant" passes;
 *  - the action ignored        → "delete with a read+update grant" passes;
 *  - the workspace set ignored → "write in another workspace" passes;
 *  - denial turned into a proposal → result carries proposalId, not denied.
 *
 * NOT COVERED: what happens AFTER the grant permits (RBAC, governance ladder) —
 * pinned by the permission-check suites. This file only asserts the grant rung.
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
import { runWithGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { checkPermissionOrPropose } from "./permission-check.js";
import { grantRequestForWrite } from "./grant-write-check.js";

const WS = randomUUID();
const OTHER_WS = randomUUID();
const KNOWLEDGE = randomUUID();
const TASK = randomUUID();
const KNOWLEDGE_PROFILE = randomUUID();

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

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into profiles (id, slug) values ($1, 'knowledge')`,
    [KNOWLEDGE_PROFILE]
  );
  await h.client!.query(
    `insert into entities (id, type, profile_id, user_id, workspace_id)
     values ($1, 'note', $2, 'human-1', $3), ($4, 'task', null, 'human-1', $3)`,
    [KNOWLEDGE, KNOWLEDGE_PROFILE, WS, TASK]
  );
});

const write = (
  grant: GrantScope,
  over: Partial<Parameters<typeof checkPermissionOrPropose>[0]>
) =>
  runWithGrant(grant, () =>
    checkPermissionOrPropose({
      userId: "human-1",
      workspaceId: WS,
      subjectType: "entity",
      action: "update",
      data: { id: KNOWLEDGE },
      ...over,
    } as Parameters<typeof checkPermissionOrPropose>[0])
  );

const denial = async (p: Promise<unknown>) => {
  const r = (await p) as { denied?: boolean; reason?: string };
  return r.denied === true && /grant does not allow/.test(r.reason ?? "")
    ? r.reason
    : null;
};

describe("the write gate enforces the key's grant (W1d)", () => {
  it("derives the kind of an existing entity from the database (profile slug first)", async () => {
    expect(
      await grantRequestForWrite({
        subjectType: "entity",
        action: "update",
        workspaceId: WS,
        data: { id: KNOWLEDGE },
      })
    ).toMatchObject({
      subject: "entity",
      qualifier: "knowledge",
      entityId: KNOWLEDGE,
    });
    expect(
      (
        await grantRequestForWrite({
          subjectType: "entity",
          action: "update",
          data: { entityId: TASK },
        })
      ).qualifier
    ).toBe("task");
  });

  it("denies a write on a kind the grant does not cover", async () => {
    const reason = await denial(
      write({ permissions: ["entity.knowledge"] }, { data: { id: TASK } })
    );
    expect(reason).toContain("entity.task.update");
  });

  it("denies an action the grant does not cover", async () => {
    expect(
      await denial(
        write(
          { permissions: ["entity.knowledge.read", "entity.knowledge.update"] },
          { action: "delete" }
        )
      )
    ).not.toBeNull();
  });

  it("denies a write outside the grant's workspaces", async () => {
    expect(
      await denial(
        write(
          { permissions: ["entity"], workspaceIds: [WS] },
          { workspaceId: OTHER_WS }
        )
      )
    ).not.toBeNull();
  });

  it("denies everything for a revoked/expired grant (deny-all)", async () => {
    expect(await denial(write({ permissions: [] }, {}))).not.toBeNull();
  });

  it("does NOT deny on the grant rung when the grant permits the write", async () => {
    const r = await write(
      { permissions: ["entity.knowledge.update"], workspaceIds: [WS] },
      {}
    ).catch(() => ({}));
    expect(await denial(Promise.resolve(r))).toBeNull();
  });
});
