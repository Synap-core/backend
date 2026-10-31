/**
 * GET /agent-users/assignments + PUT /agent-users/:agentUserId/assignment —
 * the Hub door of `agentUsers.setAssignment`, so an app a person signed in to
 * (Content Studio: an `app_person` key, a PERSON principal bounded by its
 * grant) can say which agent takes a playbook's work.
 *
 * Through the REAL routes, the REAL service (`setAgentAssignment`,
 * `readAgentAssignment`), the REAL target-visibility floor, the REAL grant
 * check and the 0329 unique index, on PGlite. Stubbed: the pod-admin check
 * (false) and the audit log.
 *
 * Rows rule out:
 *  - an agent key (or the IS key) that could staff itself: PERSON_ONLY, and
 *    nothing written (a door with no person-only refusal);
 *  - a scoped key with no `agent.update`: GRANT_DENIED (a door that skips the
 *    grant because the caller is not an agent);
 *  - a key holding `agent.update` only in ANOTHER space: GRANT_DENIED, while
 *    the same permission in the playbook's space passes (a check against no
 *    space refuses every app, whose writes are always pinned; a check against
 *    "any scope" lets one space's permission act in another);
 *  - a teammate's assignment on the same playbook is never read as yours
 *    (a read that drops the per-owner filter).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => false,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: async () => undefined,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import * as schema from "@synap/database/schema";
import { registerAgentUsersRoutes } from "./agent-users.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = randomUUID();
const TEAMMATE = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
/** The teammate's own agent. */
const THEIRS = randomUUID();
const WS = randomUUID();
const OTHER_WS = randomUUID();
const PLAYBOOK = randomUUID();

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
    const def =
      c.name === "created_at"
        ? " default now()"
        : c.name === "metadata"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = unknown>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** An app signed in as the person: one scope, pinned to `workspaceIds`. */
const appGrant = (permissions: string[], workspaceIds = [WS]): KeyGrant => ({
  scopes: [{ permissions, workspaceIds }],
  clientId: "content-studio",
});

interface Caller {
  userId?: string;
  agentUserId?: string;
  keyType?: string;
  grant?: KeyGrant;
}

function hub(caller: Caller = {}): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  // What the hub auth door sets for a key (auth.ts): the person owns the
  // request, an agent key also names the acting agent, a key's grant bounds it.
  app.use("*", async (c, next) => {
    c.set("userId", caller.userId ?? OWNER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (caller.agentUserId) c.set("agentUserId", caller.agentUserId);
    if (caller.keyType) c.set("keyType" as never, caller.keyType as never);
    await runWithActingAgent(caller.agentUserId, () =>
      caller.grant ? runWithGrant(caller.grant, () => next()) : next()
    );
  });
  registerAgentUsersRoutes(app);
  return app;
}

const put = (
  agentUserId: string,
  body: unknown,
  caller: Caller = {}
): Promise<Response> =>
  Promise.resolve(
    hub(caller).request(`/agent-users/${agentUserId}/assignment`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const assign = (agentUserId: string, assigned = true, caller: Caller = {}) =>
  put(
    agentUserId,
    { target: { type: "playbook", id: PLAYBOOK }, assigned },
    caller
  );

const read = (
  target: { type: string; id: string } = { type: "playbook", id: PLAYBOOK },
  caller: Caller = {}
): Promise<Response> =>
  Promise.resolve(
    hub(caller).request(
      `/agent-users/assignments?targetType=${target.type}&targetId=${target.id}`
    )
  );

/** Every assigned_to row on the playbook: [agent, ownerId]. */
const rows = async () =>
  (
    await q<{ from_id: string; owner: string }>(
      `select from_id, metadata->>'ownerId' as owner from links where link_type = 'assigned_to' and to_type = 'playbook' and to_id = $1 order by from_id`,
      [PLAYBOOK]
    )
  ).rows.map((r) => [r.from_id, r.owner]);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // The edge's own uniqueness (createLink's ON CONFLICT target) and the 0329
  // index: one agent per target per owner.
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type);
     create unique index on links (to_type, to_id, (coalesce(metadata->>'ownerId', ''))) where link_type = 'assigned_to';`
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x', 'human'), ($2, 't@x', 'human')`,
    [OWNER, TEAMMATE]
  );
  for (const [id, name, owner] of [
    [AGENT_A, "Claude on the Mac", OWNER],
    [AGENT_B, "Hermes", OWNER],
    [THEIRS, "Teammate bot", TEAMMATE],
  ]) {
    await q(
      `insert into users (id, email, name, user_type, created_by_user_id) values ($1, $2, $3, 'agent', $4)`,
      [id, `${id}@x`, name, owner]
    );
  }
  for (const ws of [WS, OTHER_WS]) {
    await q(
      `insert into workspaces (id, owner_id, name, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [ws, OWNER, ws]
    );
    for (const member of [OWNER, TEAMMATE]) {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
        [randomUUID(), ws, member]
      );
    }
  }
  await q(
    `insert into playbooks (id, workspace_id, created_by, name) values ($1, $2, $3, 'Produce Content')`,
    [PLAYBOOK, WS, OWNER]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from links where link_type = 'assigned_to'`);
});

describe("a person assigns their agent to a playbook through the Hub", () => {
  it("assign → the read returns that agent, by name", async () => {
    const res = await assign(AGENT_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      assigned: true,
      agentUserId: AGENT_A,
      target: { type: "playbook", id: PLAYBOOK },
      replaced: null,
    });
    const got = await read();
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      assignment: {
        agentUserId: string;
        agentName: string;
        assignedAt: string;
      };
    };
    expect(body.assignment.agentUserId).toBe(AGENT_A);
    expect(body.assignment.agentName).toBe("Claude on the Mac");
    expect(Number.isNaN(Date.parse(body.assignment.assignedAt))).toBe(false);
  });

  it("a second assign replaces the first and names it", async () => {
    await assign(AGENT_A);
    const res = await assign(AGENT_B);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replaced: string | null }).replaced).toBe(
      AGENT_A
    );
    expect(await rows()).toEqual([[AGENT_B, OWNER]]);
    const body = (await (await read()).json()) as {
      assignment: { agentUserId: string };
    };
    expect(body.assignment.agentUserId).toBe(AGENT_B);
  });

  it("assigned:false clears it → the read answers null", async () => {
    await assign(AGENT_A);
    const res = await assign(AGENT_A, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assigned: boolean }).assigned).toBe(false);
    expect(await rows()).toEqual([]);
    expect(await (await read()).json()).toEqual({ assignment: null });
  });

  it("the read is the caller's own: a teammate's agent on the same playbook is not yours", async () => {
    await assign(THEIRS, true, { userId: TEAMMATE });
    expect(await rows()).toEqual([[THEIRS, TEAMMATE]]);
    expect(await (await read()).json()).toEqual({ assignment: null });
    await assign(AGENT_A);
    const mine = (await (await read()).json()) as {
      assignment: { agentUserId: string };
    };
    expect(mine.assignment.agentUserId).toBe(AGENT_A);
    // Assigning mine left the teammate's in place.
    expect((await rows()).map(([a]) => a).sort()).toEqual(
      [AGENT_A, THEIRS].sort()
    );
  });
});

describe("who may assign", () => {
  it("an agent key is refused PERSON_ONLY and writes nothing", async () => {
    const res = await assign(AGENT_A, true, { agentUserId: AGENT_A });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "PERSON_ONLY"
    );
    expect(await rows()).toEqual([]);
  });

  it("the AI service's internal key is refused PERSON_ONLY too", async () => {
    const res = await assign(AGENT_A, true, { keyType: "is_internal" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "PERSON_ONLY"
    );
    expect(await rows()).toEqual([]);
  });

  it("an app signed in as the person, holding agent.update in the playbook's space, assigns", async () => {
    const res = await assign(AGENT_A, true, {
      grant: appGrant(["entity.post.read", "agent.update"]),
    });
    expect(res.status).toBe(200);
    expect(await rows()).toEqual([[AGENT_A, OWNER]]);
  });

  it("an app without agent.update is refused GRANT_DENIED and writes nothing", async () => {
    const res = await assign(AGENT_A, true, {
      grant: appGrant(["entity.post.update", "agent.read"]),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reasonCode: string; error: string };
    expect(body.reasonCode).toBe("GRANT_DENIED");
    expect(body.error).toMatch(/agent\.update/);
    expect(await rows()).toEqual([]);
  });

  it("agent.update in ANOTHER space does not reach this playbook", async () => {
    const res = await assign(AGENT_A, true, {
      grant: appGrant(["agent.update"], [OTHER_WS]),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "GRANT_DENIED"
    );
    expect(await rows()).toEqual([]);
  });

  it("an unknown agent → 404 NOT_FOUND", async () => {
    const res = await assign(randomUUID());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "NOT_FOUND"
    );
  });

  it("someone else's agent → 403 NOT_OWNER", async () => {
    const res = await assign(THEIRS);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "NOT_OWNER"
    );
    expect(await rows()).toEqual([]);
  });

  it("an unknown playbook → 404 TARGET_NOT_FOUND, on the write and the read", async () => {
    const target = { type: "playbook", id: randomUUID() };
    const res = await put(AGENT_A, { target, assigned: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reasonCode: string }).reasonCode).toBe(
      "TARGET_NOT_FOUND"
    );
    const got = await read(target);
    expect(got.status).toBe(404);
    expect(((await got.json()) as { reasonCode: string }).reasonCode).toBe(
      "TARGET_NOT_FOUND"
    );
  });

  it("a malformed body or query → 400", async () => {
    expect(
      (await put(AGENT_A, { target: { type: "deal", id: PLAYBOOK } })).status
    ).toBe(400);
    expect((await read({ type: "playbook", id: "nope" })).status).toBe(400);
  });
});
