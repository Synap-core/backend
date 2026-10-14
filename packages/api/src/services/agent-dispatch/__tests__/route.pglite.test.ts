/**
 * THE ROUTE — the route table, read back out of PGlite.
 *
 * One row per rung (`RouteVia`, the set is derived from the type: a new rung
 * without a row fails the build) and per refusal, plus the rows where a
 * looser rule would answer differently:
 *   - a roster entry of the wrong reach FALLS THROUGH to the next one;
 *   - a pod agent and a dispatch agent under a dispatch run route to the
 *     single dispatch one, not "choose";
 *   - a named agent that cannot take the work is REFUSED, never swapped;
 *   - a room never routes to its first member: 2+ eligible ⇒ the person chooses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { users, apiKeys, links } from "@synap/database";
import { route, type RouteResult, type RouteVia } from "../route.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const TEAMMATE = randomUUID();
/** Owner's agents bound for dispatch. */
const D1 = randomUUID();
const D2 = randomUUID();
/** A teammate's agent bound for dispatch. */
const D_THEIRS = randomUUID();
/** Owner's pulling agent (own key linked to the owner). */
const P_MINE = randomUUID();
/** A pulling agent that acts for the teammate. */
const P_THEIRS = randomUUID();
/** Owner's house agents (agentType, no key, no binding). */
const H1 = randomUUID();
const H2 = randomUUID();
/** The teammate's house agent. */
const H_THEIRS = randomUUID();
/** Owner's bound agents used only by the assignment rows. */
const D_PB = randomUUID();
const D_WS = randomUUID();
/** Owner's bound agent a person paused. */
const D_PAUSED = randomUUID();
/** Assignment targets. */
const PLAYBOOK = randomUUID();
const PROFILE = randomUUID();
const PROJECT = randomUUID();
const WORKSPACE = randomUUID();
/** A second owner with several bound agents, for the assignment rows. */
const OWNER2 = randomUUID();

beforeAll(async () => {
  for (const t of [users, apiKeys, links]) {
    await h.client!.exec(ddlFor(t as PgTable));
  }
  const agent = (id: string, owner: string, agentType: string | null) =>
    q(
      `insert into users (id, email, user_type, agent_type, created_by_user_id) values ($1, $2, 'agent', $3, $4)`,
      [id, `${id}@x.test`, agentType, owner]
    );
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x.test', 'human'), ($2, 't@x.test', 'human')`,
    [OWNER, TEAMMATE]
  );
  await agent(D1, OWNER, "claude-code");
  await agent(D2, OWNER, "codex");
  await agent(D_THEIRS, TEAMMATE, "claude-code");
  await agent(P_MINE, OWNER, "cursor");
  await agent(P_THEIRS, TEAMMATE, "cursor");
  await agent(H1, OWNER, "meta");
  await agent(H2, OWNER, "researcher");
  await agent(H_THEIRS, TEAMMATE, "meta");
  await q(`insert into users (id, email, user_type) values ($1, 'o2@x.test', 'human')`, [OWNER2]);
  await agent(D_PB, OWNER2, "claude-code");
  await agent(D_WS, OWNER2, "codex");
  await agent(D_PAUSED, OWNER2, "devin");
  await q(`update users set agent_paused_at = now(), agent_paused_by = $2 where id = $1`, [D_PAUSED, OWNER2]);
  for (const [id, at] of [
    [D1, "2026-10-01T00:00:00Z"],
    [D2, "2026-10-02T00:00:00Z"],
    [D_THEIRS, "2026-10-03T00:00:00Z"],
    [D_PB, "2026-10-04T00:00:00Z"],
    [D_WS, "2026-10-05T00:00:00Z"],
    [D_PAUSED, "2026-10-06T00:00:00Z"],
  ] as const) {
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_at) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', $4)`,
      [randomUUID(), id, randomUUID(), at]
    );
  }
  const assign = (agentId: string, toType: string, toId: string) =>
    q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1, 'participant', $2, $3, $4, 'assigned_to')`,
      [randomUUID(), agentId, toType, toId]
    );
  await assign(D_PB, "playbook", PLAYBOOK);
  await assign(D_WS, "workspace", WORKSPACE);
  await assign(D_PAUSED, "profile", PROFILE);
  await assign(P_MINE, "project", PROJECT);
  await q(
    `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3), ($4, $5, 'hub_inbound', $6)`,
    [randomUUID(), P_MINE, OWNER, randomUUID(), P_THEIRS, TEAMMATE]
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

const routedTo = (r: RouteResult) =>
  r.kind === "routed" ? { id: r.agentUserId, via: r.via, reach: r.reach } : r;

describe("route — one row per rung", () => {
  // Derived from the type: adding a rung to `RouteVia` without a row here
  // fails the build.
  const rows: Record<RouteVia, () => Promise<void>> = {
    selector: async () => {
      const r = await route({
        ownerId: OWNER,
        accept: ["dispatch"],
        selector: { agentUserId: D2 },
        roster: [D1],
        pool: "owned",
      });
      // Named beats the roster.
      expect(routedTo(r)).toEqual({ id: D2, via: "selector", reach: "dispatch" });
    },
    roster: async () => {
      const r = await route({
        ownerId: OWNER,
        accept: ["dispatch"],
        roster: [D2],
        pool: "owned",
      });
      expect(routedTo(r)).toEqual({ id: D2, via: "roster", reach: "dispatch" });
    },
    assigned: async () => {
      const r = await route({
        ownerId: OWNER2,
        accept: ["dispatch"],
        targets: { workspace: WORKSPACE },
        pool: "owned",
      });
      expect(routedTo(r)).toEqual({ id: D_WS, via: "assigned", reach: "dispatch" });
    },
    single: async () => {
      const r = await route({
        ownerId: OWNER,
        accept: ["pod"],
        roster: [H1, P_MINE],
        pool: "roster",
      });
      expect(routedTo(r)).toEqual({ id: H1, via: "single", reach: "pod" });
    },
  };
  for (const [via, run] of Object.entries(rows)) {
    it(`via ${via}`, run);
  }
});

describe("route — refusals never fall through", () => {
  it("a named agent of the wrong reach is refused, not swapped", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["dispatch"],
      selector: { agentUserId: P_MINE },
      roster: [D1],
      pool: "owned",
    });
    expect(r).toMatchObject({ kind: "refused", reason: "wrong_reach", agentUserId: P_MINE });
  });

  it("a teammate's bound agent is not the owner's to hand work", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["dispatch"],
      selector: { agentUserId: D_THEIRS },
      pool: "owned",
    });
    expect(r).toMatchObject({ kind: "refused", reason: "not_owned" });
  });

  it("a pulling agent must act for the owner", async () => {
    const mine = await route({
      ownerId: OWNER,
      accept: ["dispatch", "pull"],
      selector: { agentUserId: P_MINE },
      pool: "owned",
    });
    expect(routedTo(mine)).toEqual({ id: P_MINE, via: "selector", reach: "pull" });
    const theirs = await route({
      ownerId: OWNER,
      accept: ["dispatch", "pull"],
      selector: { agentUserId: P_THEIRS },
      pool: "owned",
    });
    expect(theirs).toMatchObject({ kind: "refused", reason: "not_owned" });
  });

  it("an external agent named in a room never gets an IS turn", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["pod"],
      selector: { agentUserId: P_MINE },
      roster: [H1, P_MINE],
      pool: "roster",
    });
    expect(r).toMatchObject({ kind: "refused", reason: "wrong_reach", reach: "pull" });
  });

  it("a room answers only from its own members", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["pod"],
      selector: { agentUserId: H2 },
      roster: [H1],
      pool: "roster",
    });
    expect(r).toMatchObject({ kind: "refused", reason: "not_member" });
  });
});

describe("route — discriminating rows", () => {
  it("a wrong-reach roster entry falls through to the next eligible one", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["dispatch"],
      roster: [P_MINE, D_THEIRS, D2],
      pool: "owned",
    });
    expect(routedTo(r)).toEqual({ id: D2, via: "roster", reach: "dispatch" });
  });

  it("pod + dispatch on the roster under a dispatch run: the dispatch one", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["dispatch"],
      roster: [H1, D1],
      pool: "owned",
    });
    expect(routedTo(r)).toEqual({ id: D1, via: "roster", reach: "dispatch" });
  });

  it("two bound agents and nothing named: the person chooses (oldest first)", async () => {
    const r = await route({ ownerId: OWNER, accept: ["dispatch"], pool: "owned" });
    expect(r).toEqual({ kind: "choose", candidates: [D1, D2] });
  });

  it("the teammate's single bound agent is never 'the single one'", async () => {
    const r = await route({ ownerId: TEAMMATE, accept: ["dispatch"], pool: "owned" });
    expect(routedTo(r)).toEqual({ id: D_THEIRS, via: "single", reach: "dispatch" });
    const none = await route({ ownerId: randomUUID(), accept: ["dispatch"], pool: "owned" });
    expect(none).toEqual({ kind: "choose", candidates: [] });
  });

  it("a room with two house agents and no mention asks the person", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["pod"],
      roster: [H1, H2, P_MINE],
      pool: "roster",
    });
    expect(r).toEqual({ kind: "choose", candidates: [H1, H2] });
  });

  it("a teammate's house agent in the room answers there (the room is the grant)", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["pod"],
      selector: { agentUserId: H_THEIRS },
      roster: [H1, H_THEIRS],
      pool: "roster",
    });
    expect(routedTo(r)).toEqual({ id: H_THEIRS, via: "selector", reach: "pod" });
  });

  it("outside a room a teammate's house agent is not the owner's", async () => {
    const r = await route({
      ownerId: OWNER,
      accept: ["pod"],
      selector: { agentUserId: H_THEIRS },
      pool: "owned",
    });
    expect(r).toMatchObject({ kind: "refused", reason: "not_owned" });
  });
});

describe("route — assignment and pause (W1b)", () => {
  it("the most specific target wins: playbook over workspace", async () => {
    const r = await route({
      ownerId: OWNER2,
      accept: ["dispatch"],
      targets: { playbook: PLAYBOOK, workspace: WORKSPACE },
      pool: "owned",
    });
    expect(routedTo(r)).toEqual({ id: D_PB, via: "assigned", reach: "dispatch" });
  });

  it("the roster outranks an assignment", async () => {
    const r = await route({
      ownerId: OWNER2,
      accept: ["dispatch"],
      roster: [D_WS],
      targets: { playbook: PLAYBOOK },
      pool: "owned",
    });
    expect(routedTo(r)).toEqual({ id: D_WS, via: "roster", reach: "dispatch" });
  });

  it("a paused assignee is skipped — the next target's agent takes it", async () => {
    const r = await route({
      ownerId: OWNER2,
      accept: ["dispatch"],
      targets: { profile: PROFILE, workspace: WORKSPACE },
      pool: "owned",
    });
    expect(routedTo(r)).toEqual({ id: D_WS, via: "assigned", reach: "dispatch" });
  });

  it("an assignee of the wrong reach is skipped", async () => {
    // P_MINE (pull) is assigned to the project; a dispatch run passes it by.
    const r = await route({
      ownerId: OWNER,
      accept: ["dispatch"],
      targets: { project: PROJECT },
      pool: "owned",
    });
    expect(r).toEqual({ kind: "choose", candidates: [D1, D2] });
  });

  it("a paused agent is never 'the single one', and is refused by name", async () => {
    const pool = await route({ ownerId: OWNER2, accept: ["dispatch"], pool: "owned" });
    expect(pool).toEqual({ kind: "choose", candidates: [D_PB, D_WS] });
    const named = await route({
      ownerId: OWNER2,
      accept: ["dispatch"],
      selector: { agentUserId: D_PAUSED },
      pool: "owned",
    });
    expect(named).toMatchObject({ kind: "refused", reason: "paused" });
  });
});
