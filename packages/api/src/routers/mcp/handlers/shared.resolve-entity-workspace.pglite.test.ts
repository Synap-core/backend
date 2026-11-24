/**
 * `resolveEntityWorkspaceId` — the lens `synap_match_playbooks` falls back to
 * when the caller names no space — never picks an ARCHIVED space (finding
 * 63198108): every workspace-scoped read refuses one ("This workspace has
 * been archived."), so a call that named no space failed on the live pod.
 *
 * Real: the membership read (`getUserMemberWorkspaceIds`), the entity's home
 * read and the archived check, on PGlite with the schema-derived DDL.
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { resolveEntityWorkspaceId } from "./shared.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const ARCHIVED = randomUUID();
const ACTIVE = randomUUID();

async function space(id: string, archived: boolean): Promise<void> {
  await q(
    `insert into workspaces (id, name, owner_id, archived_at) values ($1, $2, $3, $4)`,
    [id, `Space ${id.slice(0, 4)}`, USER, archived ? new Date().toISOString() : null]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), id, USER]
  );
}

async function entityIn(workspaceId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1, $2, $3, 'note', 'A note')`,
    [id, USER, workspaceId]
  );
  return id;
}

beforeAll(async () => {
  // Wait for the mocked module to have opened its client.
  await import("@synap/database");
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  // The archived space first: the old fallback took the first membership.
  await space(ARCHIVED, true);
  await space(ACTIVE, false);
}, 120_000);

describe("the match lens never picks an archived space (finding 63198108)", () => {
  it("no entity: the first ACTIVE member space, disclosed as a pick", async () => {
    expect(await resolveEntityWorkspaceId(USER, undefined)).toEqual({
      workspaceId: ACTIVE,
      autoPicked: true,
      memberCount: 1,
    });
  });

  it("an entity homed in an archived space: falls back to an active one", async () => {
    const entity = await entityIn(ARCHIVED);
    expect(await resolveEntityWorkspaceId(USER, entity)).toEqual({
      workspaceId: ACTIVE,
      autoPicked: true,
      memberCount: 1,
    });
  });

  it("CONTROL: an entity homed in an active space is matched there", async () => {
    const entity = await entityIn(ACTIVE);
    expect(await resolveEntityWorkspaceId(USER, entity)).toEqual({
      workspaceId: ACTIVE,
      autoPicked: false,
      memberCount: 0,
    });
  });
});
