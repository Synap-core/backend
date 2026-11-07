/**
 * An agent's work belongs to the person it works for (finding 50fd3e65).
 *
 * The founder could not switch on two pod-wide automations their own agent
 * proposed and they approved: the rows are `workspaceId: null`, `createdBy` =
 * the agent user, and the pod-wide write gate admitted only `createdBy`.
 *
 *   - the person behind the owning agent activates, pauses, edits and archives
 *     the agent's pod-wide automation (the real router doors, the real gate);
 *   - every other refusal holds: another person, another person's agent's row,
 *     an agent on its person's row, a sibling agent, an agent nobody owns.
 *
 * Real: `assertWorkspaceWrite`, `personOfOwner`, the automations router doors.
 * Tables: `users` and `automations` (derived DDL).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: {
      automations: actual.automations as never,
      users: actual.users as never,
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import {
  getTableConfig,
  type PgTable,
  PgTable as PgTableClass,
} from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as database from "@synap/database";
import { TRPCError } from "@trpc/server";
import { automationsRouter } from "./automations.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import type { Context } from "../types/context.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER_PERSON = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333"; // PERSON's agent
const SIBLING_AGENT = "44444444-4444-4444-8444-444444444444"; // PERSON's too
const OTHER_AGENT = "55555555-5555-4555-8555-555555555555"; // OTHER_PERSON's
const ORPHAN_AGENT = "66666666-6666-4666-8666-666666666666"; // nobody's
const AUTOMATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "id" && type === "uuid"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

function caller(userId: string) {
  return automationsRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as unknown as Context);
}

async function automationRow(): Promise<{ status: string; name: string }> {
  const { rows } = await h.client!.query<{ status: string; name: string }>(
    `select status, name from automations where id = $1`,
    [AUTOMATION]
  );
  return rows[0]!;
}

beforeAll(async () => {
  for (const table of [database.users, database.automations]) {
    if (is(table, PgTableClass)) await h.client!.exec(ddlFor(table));
  }
  const user = (id: string, type: string, createdBy: string | null) =>
    h.client!.query(
      `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, $3, $4)`,
      [id, `${id}@pod.test`, type, createdBy]
    );
  await user(PERSON, "human", null);
  await user(OTHER_PERSON, "human", null);
  await user(AGENT, "agent", PERSON);
  await user(SIBLING_AGENT, "agent", PERSON);
  await user(OTHER_AGENT, "agent", OTHER_PERSON);
  await user(ORPHAN_AGENT, "agent", null);
});

beforeEach(async () => {
  await h.client!.exec(`delete from automations;`);
  // Pod-wide (no space), authored by the person's agent, approved: a draft.
  await h.client!.query(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, state, metadata)
     values ($1, null, $2, 'Weekly digest', 'manual', '{}', '{"nodes":[],"edges":[]}', 'draft', '{}', '{}')`,
    [AUTOMATION, AGENT]
  );
});

describe("the person behind an agent works the agent's pod-wide automation", () => {
  it("activates it", async () => {
    const out = await caller(PERSON).activate({ id: AUTOMATION });
    expect(out.status).toBe("activated");
    expect((await automationRow()).status).toBe("active");
  });

  it("pauses it", async () => {
    await h.client!.query(
      `update automations set status = 'active' where id = $1`,
      [AUTOMATION]
    );
    const out = await caller(PERSON).pause({ id: AUTOMATION });
    expect(out.status).toBe("paused");
    expect((await automationRow()).status).toBe("paused");
  });

  it("archives it", async () => {
    const out = await caller(PERSON).archive({ id: AUTOMATION });
    expect(out.status).toBe("archived");
    expect((await automationRow()).status).toBe("archived");
  });

  it("another person is still refused, and nothing moves", async () => {
    await expect(
      caller(OTHER_PERSON).activate({ id: AUTOMATION })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the owner can modify this pod-wide resource.",
    });
    await expect(
      caller(OTHER_PERSON).pause({ id: AUTOMATION })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await automationRow()).status).toBe("draft");
  });
});

describe("assertWorkspaceWrite: the pod-wide rung", () => {
  const gate = (userId: string, ownerId: string | null) =>
    assertWorkspaceWrite(h.db, userId, { workspaceId: null, ownerId });

  it("admits the owner and the person behind the owning agent", async () => {
    await expect(gate(PERSON, PERSON)).resolves.toBeUndefined();
    await expect(gate(PERSON, AGENT)).resolves.toBeUndefined();
  });

  it("refuses everyone else", async () => {
    const refused = async (userId: string, ownerId: string | null) => {
      const err = await gate(userId, ownerId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    };
    // another person on my agent's row
    await refused(OTHER_PERSON, AGENT);
    // me on another person's agent's row
    await refused(PERSON, OTHER_AGENT);
    // an agent on its person's row (the rung never runs upward)
    await refused(AGENT, PERSON);
    // a sibling agent on my other agent's row
    await refused(SIBLING_AGENT, AGENT);
    // an agent nobody owns
    await refused(PERSON, ORPHAN_AGENT);
    // an owner with no users row (system)
    await refused(PERSON, "77777777-7777-4777-8777-777777777777");
    // an explicit null owner
    await refused(PERSON, null);
  });
});

describe("personOfOwner", () => {
  it("reads a human as itself, an agent as its creator, a stranger as undefined", async () => {
    await expect(database.personOfOwner(h.db, PERSON)).resolves.toBe(PERSON);
    await expect(database.personOfOwner(h.db, AGENT)).resolves.toBe(PERSON);
    await expect(
      database.personOfOwner(h.db, ORPHAN_AGENT)
    ).resolves.toBeNull();
    await expect(
      database.personOfOwner(h.db, "77777777-7777-4777-8777-777777777777")
    ).resolves.toBeUndefined();
  });
});
