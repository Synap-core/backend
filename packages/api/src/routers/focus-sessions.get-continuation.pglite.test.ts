/**
 * `continuation` (the continuation packet) ARRIVES on the session read, driven
 * through the REAL `focusSessions.get` procedure and the REAL MCP
 * `synap_get_session` handler on PGlite — reachability, not shape.
 *
 * Real: both doors, `projectContinuationPacket`, `projectOwedSlots`,
 * `listSessionOutputs` (artifacts + produced links + titles),
 * `assessRerunAvailability`, the pending-proposal read and its vocabulary title.
 * Tables are generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `getParentSessionId(s)` — lineage lives on `@synap/database`'s own
 *    connection (the `links` walk); pinned to "no parent".
 *
 * NOT covered: the Hub `GET /focus-sessions/:id` door (same function, attached
 * in one line; typecheck only).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  failRerun: false,
}));

// Wrapped (importOriginal), not replaced: a toggle makes the rerun read throw,
// to prove it marks `rerun` instead of failing the whole session read.
vi.mock(
  "../services/focus-sessions/rerun-session.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/focus-sessions/rerun-session.js")
      >();
    return {
      ...actual,
      assessRerunAvailability: async (
        ...args: Parameters<typeof actual.assessRerunAvailability>
      ) => {
        if (h.failRerun) {
          throw new Error('relation "pgboss.job" does not exist');
        }
        return actual.assessRerunAvailability(...args);
      },
    };
  }
);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
    getParentSessionId: async () => null,
    getParentSessionIds: async () => new Map(),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  proposals,
  users,
  chatTurns,
  workspaces,
  workspaceMembers,
  artifacts,
  links,
  entities,
  documents,
  views,
  automations,
  playbooks,
} from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";
import { sessionHandlers } from "./mcp/handlers/session.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWED = {
  kind: "credential",
  label: "Stripe key",
  owner: "human",
  blockedReason: "credential",
  why: "the live restricted key",
  owedSince: "2026-09-01T00:00:00.000Z",
};
const AGENT_SLOT = { kind: "document", label: "Draft brief" };

async function seed(opts: { owed: boolean }): Promise<string> {
  const id = randomUUID();
  const slots = opts.owed ? [OWED, AGENT_SLOT] : [AGENT_SLOT];
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, current_stage, progress, created_at, updated_at, started_at)
     values ($1, $2, 'Launch billing', 'active', $3::jsonb, '{}'::jsonb, 'draft', 40, now(), now(), now())`,
    [id, USER, JSON.stringify(slots)]
  );
  await q(
    `insert into proposals (id, session_id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
     values ($1, $2, 'pending', 'create', 'company', $3, $4::jsonb, now(), now())`,
    [randomUUID(), id, randomUUID(), JSON.stringify({ targetName: "Acme" })]
  );
  await q(
    `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, 'document', $3, 'Pricing notes', 'agent', $4, 'kept', '{}'::jsonb, now(), now())`,
    [randomUUID(), USER, randomUUID(), id]
  );
  return id;
}

const get = (id: string) =>
  focusSessionsRouter
    .createCaller({ db, authenticated: true, userId: USER } as never)
    .get({ id });

async function mcpGet(id: string): Promise<Record<string, unknown>> {
  const res = await sessionHandlers.synap_get_session!({
    toolName: "synap_get_session",
    args: { sessionId: id },
    userId: USER,
    apiKeyScopes: ["mcp.read"],
    workspaceAccessible: false,
    caller: null as never,
    lensCaller: null as never,
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("focusSessions.get returns the continuation packet", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      proposals,
      users,
      chatTurns,
      workspaces,
      workspaceMembers,
      artifacts,
      links,
      entities,
      documents,
      views,
      automations,
      playbooks,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from proposals; delete from artifacts;"
    );
  });

  it("an owed human slot, a pending proposal, an open agent slot and an output land in the right sections", async () => {
    const id = await seed({ owed: true });
    const { continuation: c, rerun } = await get(id);

    expect(c.session).toMatchObject({
      id,
      goal: "Launch billing",
      status: "active",
      currentStage: "draft",
      progress: 40,
    });
    expect(c.userMustDecide.owedSlots).toMatchObject({
      status: "ok",
      total: 1,
      items: [{ label: "Stripe key", blockedReason: "credential" }],
    });
    expect(c.userMustDecide.pendingProposals).toMatchObject({
      status: "ok",
      total: 1,
      items: [{ title: 'Create Company "Acme"', proposalType: "create" }],
    });
    expect(c.aiCanDo).toEqual({
      status: "ok",
      total: 1,
      items: [{ label: "Draft brief", kind: "document" }],
    });
    expect(c.blockers).toMatchObject({
      status: "ok",
      total: 1,
      items: [{ label: "Stripe key", why: "the live restricted key" }],
    });
    expect(c.outputs).toMatchObject({
      status: "ok",
      total: 1,
      items: [{ kind: "document", title: "Pricing notes", state: "kept" }],
    });
    expect(c.run).toBeNull();
    expect(c.nextMove).toMatchObject({ kind: "owed_slot", actor: "user" });
    // `rerun` is the packet's own value, never a second computation.
    expect(rerun).toEqual(c.rerun);
  });

  it("with nothing owed, the oldest pending proposal is the next move", async () => {
    const id = await seed({ owed: false });
    const { continuation: c } = await get(id);
    const first = c.userMustDecide.pendingProposals;
    expect(first.status).toBe("ok");
    expect(c.nextMove).toMatchObject({
      kind: "pending_proposal",
      proposalId: first.status === "ok" ? first.items[0]!.id : "",
    });
  });

  it("an empty session reads undeclared, never ready to close", async () => {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
       values ($1, $2, 'Blocked by another session', 'active', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
      [id, USER]
    );
    const { continuation: c } = await get(id);
    expect(c.nextMove).toMatchObject({ kind: "undeclared", actor: "ai" });
  });

  it("an open blocker past PACKET_TOP_N closed ones still makes the session wait", async () => {
    const id = await seed({ owed: false });
    await q(`delete from proposals where session_id = $1`, [id]);
    const blockers: Array<[string, string]> = [
      ...Array.from(
        { length: 5 },
        (_, i) => [`Old ${i}`, "closed"] as [string, string]
      ),
      ["Ship pricing", "active"],
    ];
    try {
      for (const [n, [goal, status]] of blockers.entries()) {
        const bid = randomUUID();
        await q(
          `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
           values ($1, $2, $3, $4, '[]'::jsonb, '{}'::jsonb, now() - make_interval(mins => $5::int), now(), now())`,
          [bid, USER, goal, status, 60 - n]
        );
        await q(
          `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
           values ($1, 'session', $2, 'session', $3, 'blocked_by', '{}'::jsonb, now())`,
          [randomUUID(), id, bid]
        );
      }
      const { continuation: c } = await get(id);
      expect(c.blockedBy).toMatchObject({ status: "ok", total: 6 });
      expect(c.nextMove).toMatchObject({
        kind: "waiting_on_session",
        label: 'Waiting on "Ship pricing"',
      });
    } finally {
      await q(`delete from links where link_type = 'blocked_by'`);
    }
  });

  it("declared work done but an open sub-session past PACKET_TOP_N closed ones makes the parent wait", async () => {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
       values ($1, $2, 'Parent', 'active', $3::jsonb, '{}'::jsonb, now(), now(), now())`,
      [
        id,
        USER,
        JSON.stringify([{ kind: "document", label: "Brief", status: "done" }]),
      ]
    );
    const children: Array<[string, string]> = [
      ...Array.from(
        { length: 5 },
        (_, i) => [`Old ${i}`, "closed"] as [string, string]
      ),
      ["Pricing detour", "active"],
    ];
    try {
      for (const [n, [goal, status]] of children.entries()) {
        const cid = randomUUID();
        await q(
          `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
           values ($1, $2, $3, $4, '[]'::jsonb, '{}'::jsonb, now() - make_interval(mins => $5::int), now(), now())`,
          [cid, USER, goal, status, 60 - n]
        );
        await q(
          `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
           values ($1, 'session', $2, 'session', $3, 'spawned_from', '{}'::jsonb, now())`,
          [randomUUID(), cid, id]
        );
      }
      const { continuation: c } = await get(id);
      expect(c.children).toMatchObject({ status: "ok", total: 6 });
      expect(c.nextMove).toMatchObject({
        kind: "waiting_on_session",
        label: 'Waiting on "Pricing detour"',
      });
    } finally {
      await q(`delete from links where link_type = 'spawned_from'`);
    }
  });

  it("a failed outputs read is marked unavailable, not empty", async () => {
    const id = await seed({ owed: true });
    await h.client!.exec(`drop table "links";`);
    try {
      const { continuation: c } = await get(id);
      expect(c.outputs.status).toBe("unavailable");
      expect(c.outputs).not.toHaveProperty("items");
      // A fixed sentence — never the driver's text (`relation "links" …`),
      // which would reach MCP, Hub and the IS prompt verbatim.
      expect(c.outputs).toEqual({
        status: "unavailable",
        reason: "This session's outputs could not be read.",
      });
      expect(JSON.stringify(c.outputs)).not.toMatch(/links|relation/);
      // The other sections still read.
      expect(c.userMustDecide.pendingProposals.status).toBe("ok");
    } finally {
      await h.client!.exec(ddlFor(links as unknown as PgTable));
    }
  });

  it("a failed rerun read marks rerun availability_unknown on both doors, not a failed get", async () => {
    const id = await seed({ owed: true });
    h.failRerun = true;
    try {
      const { continuation: c, rerun } = await get(id);
      // Its own state: never folded into `no_manifest`.
      expect(c.rerun).toEqual({
        available: false,
        reason: "availability_unknown",
      });
      expect(rerun).toEqual(c.rerun);
      expect(c.outputs.status).toBe("ok");
      const mcp = await mcpGet(id);
      expect(mcp.continuation).toMatchObject({
        rerun: { available: false, reason: "availability_unknown" },
      });
    } finally {
      h.failRerun = false;
    }
  });

  it("MCP synap_get_session carries the same packet as tRPC get", async () => {
    const id = await seed({ owed: true });
    const trpc = (await get(id)).continuation;
    const mcp = await mcpGet(id);
    // Non-vacuity: the packet is populated, not two matching absences.
    expect(trpc.userMustDecide.owedSlots).toMatchObject({ total: 1 });
    expect(mcp.continuation).toEqual(JSON.parse(JSON.stringify(trpc)));
  });

  it("title, displayTitle and children arrive — the same on both doors", async () => {
    await h.client!.exec("delete from links;");
    const parent = await seed({ owed: false });
    await q(`update focus_sessions set title = 'Billing' where id = $1`, [
      parent,
    ]);
    const child = randomUUID();
    const strangersChild = randomUUID();
    for (const [id, user] of [
      [child, USER],
      [strangersChild, "user-2"],
    ] as const) {
      await q(
        `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
         values ($1, $2, E'Wire the Stripe webhook\nthen test it', 'active', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
        [id, user]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type)
         values ($1, 'session', $2, 'session', $3, 'spawned_from')`,
        [randomUUID(), id, parent]
      );
    }

    const trpc = (await get(parent)).continuation;
    expect(trpc.session).toMatchObject({
      title: "Billing",
      displayTitle: "Billing",
    });
    // Owner floor: the stranger's child is not listed. Untitled ⇒ goal's first line.
    expect(trpc.children).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: child,
          title: "Wire the Stripe webhook",
          status: "active",
          statusLabel: expect.any(String),
        },
      ],
    });
    const untitled = (await get(child)).continuation.session;
    expect(untitled).toMatchObject({
      title: null,
      displayTitle: "Wire the Stripe webhook",
    });
    const mcp = await mcpGet(parent);
    expect(mcp.continuation).toEqual(JSON.parse(JSON.stringify(trpc)));
  });

  it("parent and blockedBy arrive from the edges, owner-floored — the same on both doors", async () => {
    await h.client!.exec("delete from links;");
    const session = await seed({ owed: false });
    const insertSession = (
      id: string,
      user: string,
      goal: string,
      status: string
    ) =>
      q(
        `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
         values ($1, $2, $3, $4, '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
        [id, user, goal, status]
      );
    const edge = (from: string, to: string, linkType: string) =>
      q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type)
         values ($1, 'session', $2, 'session', $3, $4)`,
        [randomUUID(), from, to, linkType]
      );
    const parent = randomUUID();
    const blocker = randomUUID();
    const strangersBlocker = randomUUID();
    await insertSession(parent, USER, "Root: billing\nall of it", "active");
    await insertSession(blocker, USER, "Get the Stripe key", "closed");
    await insertSession(strangersBlocker, "user-2", "Not yours", "active");
    await edge(session, parent, "spawned_from");
    await edge(session, blocker, "blocked_by");
    await edge(session, strangersBlocker, "blocked_by");
    // An inbound edge must not read as this session's own parent/blocker.
    await edge(blocker, session, "blocked_by");

    const trpc = (await get(session)).continuation;
    expect(trpc.parent).toEqual({
      status: "ok",
      session: {
        id: parent,
        title: "Root: billing",
        status: "active",
        statusLabel: expect.any(String),
      },
    });
    expect(trpc.blockedBy).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: blocker,
          title: "Get the Stripe key",
          status: "closed",
          statusLabel: expect.any(String),
        },
      ],
    });
    // A parent owned by someone else reads as no parent, never disclosed.
    const orphan = await seed({ owed: false });
    await edge(orphan, strangersBlocker, "spawned_from");
    const o = (await get(orphan)).continuation;
    expect(o.parent).toEqual({ status: "ok", session: null });
    expect(o.blockedBy).toEqual({ status: "ok", total: 0, items: [] });

    const mcp = await mcpGet(session);
    expect(mcp.continuation).toEqual(JSON.parse(JSON.stringify(trpc)));
  });

  it("a failed edge read marks parent and blockedBy unavailable, not 'no parent'", async () => {
    const id = await seed({ owed: false });
    await h.client!.exec(`drop table "links";`);
    try {
      const { continuation: c } = await get(id);
      expect(c.parent).toEqual({
        status: "unavailable",
        reason: "This session's parent session could not be read.",
      });
      expect(c.blockedBy).toEqual({
        status: "unavailable",
        reason: "The sessions this one waits on could not be read.",
      });
    } finally {
      await h.client!.exec(ddlFor(links as unknown as PgTable));
    }
  });

  it("more than PACKET_TOP_N children and outputs: totals stay exact, items stop at 5", async () => {
    await h.client!.exec("delete from links;");
    const parent = await seed({ owed: false }); // seeds 1 output artifact
    for (let i = 0; i < 6; i++) {
      await q(
        `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
         values ($1, $2, 'document', $3, $4, 'agent', $5, 'kept', '{}'::jsonb, now(), now())`,
        [randomUUID(), USER, randomUUID(), `Doc ${i}`, parent]
      );
    }
    const kids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = randomUUID();
      kids.push(id);
      await q(
        `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
         values ($1, $2, $3, 'active', '[]'::jsonb, '{}'::jsonb, now() + ($4::text || ' seconds')::interval, now(), now())`,
        [id, USER, `Child ${i}`, String(i)]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type)
         values ($1, 'session', $2, 'session', $3, 'spawned_from')`,
        [randomUUID(), id, parent]
      );
    }

    const c = (await get(parent)).continuation;
    expect(c.children).toMatchObject({ status: "ok", total: 7 });
    // The OLDEST five, in order — the LIMIT keeps the same ordering.
    expect(
      c.children.status === "ok" ? c.children.items.map((i) => i.id) : null
    ).toEqual(kids.slice(0, 5));
    expect(c.outputs).toMatchObject({ status: "ok", total: 7 });
    expect(c.outputs.status === "ok" ? c.outputs.items : null).toHaveLength(5);
  });
});
