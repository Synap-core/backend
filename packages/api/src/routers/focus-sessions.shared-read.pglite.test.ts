/**
 * SHARED SESSIONS (founder decision C, 2026-09-25): a session is READABLE by its
 * owner + the HUMAN seats on its own room's roster; every WRITE stays
 * owner-only. Driven through the REAL `focusSessions` tRPC procedures on PGlite
 * — the predicate is `access/session-visibility.ts` `sessionReadableWhere`.
 *
 * The cast, all in one workspace W:
 *   OWNER      — owns session S.
 *   MEMBER     — human, workspace member, human seat on S's minted room.
 *   COLLEAGUE  — human, workspace member, NOT on the roster      (leak test).
 *   AGENT      — agent user, `ai_agent` seat on the roster        (gains nothing).
 *   IMPOSTOR   — agent user enrolled with `member_kind = 'human'` (belt+braces).
 *   BORROWED   — human seat on a NON-minted channel session B borrows (FK ≠ grant).
 *   FORGER     — human, workspace member, who minted a channel STAMPED
 *                `focus_session/<S>` (the `channel.ensure` capability takes the
 *                type as a free string) and seated themselves on it: the stamp
 *                without the FK grants nothing (stamp ≠ grant).
 *
 * Stubbed, and why:
 *  - `getParentSessionId(s)` — lineage lives on `@synap/database`'s own
 *    connection; pinned to "no parent" (same as get-continuation test).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        playbookRuns: actual.playbookRuns as never,
      },
    }),
    getDb: async () =>
      drizzle(client, {
        schema: {
          focusSessions: actual.focusSessions as never,
          playbookRuns: actual.playbookRuns as never,
        },
      }),
    getParentSessionId: async () => null,
    getParentSessionIds: async () => new Map(),
  };
});

// Every tRPC mutation passes the read-only (split-brain) guard, which reads the
// sync-generation table on its own schema key — not what these doors decide.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";
import { playbookRunsRouter } from "./playbook-runs.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { sessionReaderIds } from "../access/session-visibility.js";
import { focusSessions } from "@synap/database/schema";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = "owner-1";
const MEMBER = "member-1";
const COLLEAGUE = "colleague-1";
const AGENT = "agent-1";
const IMPOSTOR = "impostor-1";
const BORROWED = "borrowed-1";
const FORGER = "forger-1";
const WS = randomUUID();

const OWED = {
  kind: "credential",
  label: "Stripe key",
  owner: "human",
  blockedReason: "credential",
  why: "the live restricted key",
  owedSince: "2026-09-01T00:00:00.000Z",
};

const caller = (userId: string, agentUserId?: string) =>
  focusSessionsRouter.createCaller({
    db,
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

let S: string;
let OTHER: string;
let B: string;
let C: string;

async function seed() {
  for (const [id, type] of [
    [OWNER, "human"],
    [MEMBER, "human"],
    [COLLEAGUE, "human"],
    [BORROWED, "human"],
    [FORGER, "human"],
    [AGENT, "agent"],
    [IMPOSTOR, "agent"],
  ] as const) {
    await q(`insert into users (id, user_type) values ($1, $2)`, [id, type]);
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  // The agents are workspace members too, so the ONLY thing refusing them is
  // the predicate's human-kind check — not a missing workspace seat.
  for (const u of [
    OWNER,
    MEMBER,
    COLLEAGUE,
    BORROWED,
    FORGER,
    AGENT,
    IMPOSTOR,
  ]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, u]
    );
  }
  S = randomUUID();
  OTHER = randomUUID();
  B = randomUUID();
  C = randomUUID();
  const room = randomUUID();
  const borrowed = randomUUID();
  const forged = randomUUID();
  // S's `channel_id` is its minted room — what `ensureSessionChannel` writes.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Launch billing', 'active', $4::jsonb, '{}'::jsonb, $5, now(), now(), now())`,
    [S, OWNER, WS, JSON.stringify([OWED]), room]
  );
  // B BORROWS a plain channel as its `channel_id` (the FK) — NOT a minted room.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Client sync', 'active', '[]'::jsonb, '{}'::jsonb, $4, now(), now(), now())`,
    [B, OWNER, WS, borrowed]
  );
  // C (a child) runs IN S's room — its `channel_id` is S's minted room, whose
  // stamp names S, not C. Sharing S does not share C.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Child task', 'active', '[]'::jsonb, '{}'::jsonb, $4, now(), now(), now())`,
    [C, OWNER, WS, room]
  );
  // A second session of the owner's, with NO room: nobody but the owner reads it.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Private plan', 'active', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [OTHER, OWNER, WS]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [room, OWNER, WS, S]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, created_at, updated_at)
     values ($1, $2, $3, 'group', now(), now())`,
    [borrowed, OWNER, WS]
  );
  // The forgery: FORGER's own thread, stamped as S's room — not S's channel_id.
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'thread', 'focus_session', $4, now(), now())`,
    [forged, FORGER, WS, S]
  );
  for (const [channel, member, kind] of [
    [room, OWNER, "human"],
    [room, MEMBER, "human"],
    [room, AGENT, "ai_agent"],
    [room, IMPOSTOR, "human"],
    [borrowed, BORROWED, "human"],
    [forged, FORGER, "human"],
  ] as const) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, $4, 'member')`,
      [randomUUID(), channel, member, kind]
    );
  }
  await q(
    `insert into artifacts (id, user_id, workspace_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, $3, 'document', $4, 'Pricing notes', 'agent', $5, 'kept', '{}'::jsonb, now(), now())`,
    [randomUUID(), OWNER, WS, randomUUID(), S]
  );
}

async function expectNotFound(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "NOT_FOUND" });
}

describe("shared sessions — owner + human roster read, owner-only write", () => {
  beforeAll(async () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (v): v is PgTable =>
        !!v &&
        typeof v === "object" &&
        Symbol.for("drizzle:IsDrizzleTable") in (v as object)
    );
    // Non-vacuity: the tables this suite reads MUST be among what we created.
    const names = tables.map((t) => getTableConfig(t).name);
    for (const n of [
      "focus_sessions",
      "channels",
      "channel_members",
      "users",
      "workspaces",
      "workspace_members",
      "artifacts",
      "session_evaluations",
    ]) {
      expect(names).toContain(n);
    }
    for (const t of tables) await h.client!.exec(ddlFor(t));
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from channels; delete from channel_members; delete from users; delete from workspaces; delete from workspace_members; delete from artifacts;"
    );
    await seed();
  });

  // ── READ: the member sees it ─────────────────────────────────────────────
  it("a human roster member can GET the session, marked viewerRole=member", async () => {
    const row = await caller(MEMBER).get({ id: S });
    expect(row.id).toBe(S);
    expect(row.viewerRole).toBe("member");
    // The owner still reads it, as the owner.
    expect((await caller(OWNER).get({ id: S })).viewerRole).toBe("owner");
  });

  it("a member LISTS and BROWSES the shared session — never the owner's unshared one", async () => {
    const listed = await caller(MEMBER).list({ status: "all" } as never);
    expect(listed.map((r) => r.id)).toEqual([S]);
    expect(listed[0]!.viewerRole).toBe("member");
    const browsed = await caller(MEMBER).browse({ status: "all" } as never);
    expect(browsed.items.map((r) => r.id)).toEqual([S]);
    expect(browsed.items[0]!.viewerRole).toBe("member");
    // The owner's list is unchanged: both of theirs, both `owner`.
    const own = await caller(OWNER).list({ status: "all" } as never);
    expect(own.map((r) => r.id).sort()).toEqual([S, OTHER, B, C].sort());
    expect(new Set(own.map((r) => r.viewerRole))).toEqual(new Set(["owner"]));
  });

  it("a shared session never counts toward the MEMBER's needs-you (owed slots are the owner's)", async () => {
    const [mine] = await caller(OWNER)
      .list({
        status: "all",
        nextMove: true,
      } as never)
      .then((rows) => rows.filter((r) => r.id === S));
    // The owner owes the Stripe key: this is on THEM.
    expect(mine!.unitFacts!.owedFromYou).toBe(1);
    const [shared] = await caller(MEMBER).list({
      status: "all",
      nextMove: true,
    } as never);
    expect(shared!.id).toBe(S);
    expect(shared!.unitFacts).toMatchObject({
      owedFromYou: 0,
      awaitingReview: false,
      pendingDecisions: 0,
    });
  });

  it("a member reads the session's OUTPUTS and EVALUATIONS and runs", async () => {
    const outputs = await caller(MEMBER).outputs({ sessionId: S });
    expect(outputs.outputs.map((o) => o.title)).toEqual(["Pricing notes"]);
    const evals = await caller(MEMBER).evaluations({ sessionId: S });
    expect(evals.history).toEqual([]);
    const runs = await playbookRunsRouter
      .createCaller({ db, authenticated: true, userId: MEMBER } as never)
      .listBySession({ sessionId: S });
    expect(runs).toEqual([]);
  });

  // ── READ: everyone else does not ─────────────────────────────────────────
  it("LEAK: a workspace colleague NOT on the roster cannot get/list/outputs the session", async () => {
    await expectNotFound(caller(COLLEAGUE).get({ id: S }));
    await expectNotFound(caller(COLLEAGUE).outputs({ sessionId: S }));
    await expectNotFound(caller(COLLEAGUE).evaluations({ sessionId: S }));
    expect(await caller(COLLEAGUE).list({ status: "all" } as never)).toEqual(
      []
    );
  });

  it("a seat on a BORROWED channel (the session's channel_id, not its minted room) grants nothing", async () => {
    await expectNotFound(caller(BORROWED).get({ id: B }));
    expect(await caller(BORROWED).list({ status: "all" } as never)).toEqual([]);
  });

  it("a session that merely RUNS IN S's room (channel_id = S's room) is not shared by S's roster", async () => {
    await expectNotFound(caller(MEMBER).get({ id: C }));
  });

  it("FORGERY: a channel stamped focus_session/<S> that is not S's channel_id grants nothing", async () => {
    await expectNotFound(caller(FORGER).get({ id: S }));
    await expectNotFound(caller(FORGER).outputs({ sessionId: S }));
    expect(await caller(FORGER).list({ status: "all" } as never)).toEqual([]);
  });

  it("an AGENT on the roster gains nothing — nor an agent enrolled with member_kind 'human'", async () => {
    await expectNotFound(caller(AGENT).get({ id: S }));
    await expectNotFound(caller(IMPOSTOR).get({ id: S }));
    expect(await caller(AGENT).list({ status: "all" } as never)).toEqual([]);
  });

  it("an AGENT KEY acting for the member reads owner-only (v1: human doors only)", async () => {
    await expectNotFound(caller(MEMBER, AGENT).get({ id: S }));
    await expectNotFound(caller(MEMBER, AGENT).outputs({ sessionId: S }));
    expect(
      await caller(MEMBER, AGENT).list({ status: "all" } as never)
    ).toEqual([]);
  });

  it("removing the member from the workspace revokes the read even if the seat lingers", async () => {
    await q(`delete from workspace_members where user_id = $1`, [MEMBER]);
    await expectNotFound(caller(MEMBER).get({ id: S }));
  });

  it("the registry rule (scopedDb) admits the member on a human door and not on an agent one", async () => {
    const human = await scopedDb(
      AccessContext.operator({ userId: MEMBER })
    ).findMany(focusSessions, {});
    expect((human as Array<{ id: string }>).map((r) => r.id)).toEqual([S]);
    const agent = await scopedDb(
      AccessContext.agent({ userId: MEMBER, agentUserId: AGENT } as never)
    ).findMany(focusSessions, {});
    expect(agent).toEqual([]);
    const colleague = await scopedDb(
      AccessContext.operator({ userId: COLLEAGUE })
    ).findMany(focusSessions, {});
    expect(colleague).toEqual([]);
  });

  it("the fan-out audience is exactly the readers: owner + the readable human seat", async () => {
    expect((await sessionReaderIds(S)).sort()).toEqual([MEMBER, OWNER].sort());
    // A session that only runs in S's room, and a borrowing one: owner only.
    expect(await sessionReaderIds(C)).toEqual([OWNER]);
    expect(await sessionReaderIds(B)).toEqual([OWNER]);
    // A seat outliving the workspace membership is not an audience.
    await q(`delete from workspace_members where user_id = $1`, [MEMBER]);
    expect(await sessionReaderIds(S)).toEqual([OWNER]);
  });

  // ── WRITE: every write door refuses the member ───────────────────────────
  // Each write door is asked by the MEMBER and by the OWNER. The member's
  // refusal must be the owner floor (NOT_FOUND, before anything else runs);
  // the owner must get PAST that floor — to success, or to an unrelated error
  // of this minimal harness — so the NOT_FOUND is proven to be the floor
  // refusing the member, not the door failing for everyone.
  it("every write door refuses a member at the owner floor — and lets the owner through", async () => {
    const doors: Array<
      [string, (c: ReturnType<typeof caller>) => Promise<unknown>]
    > = [
      ["update", (c) => c.update({ id: S, goal: "Hijacked" } as never)],
      ["close", (c) => c.close({ id: S } as never)],
      [
        "answerOutput",
        (c) =>
          c.answerOutput({
            sessionId: S,
            expectedLabel: "Stripe key",
            text: "sk_live_member",
          }),
      ],
      [
        "attachOutput",
        (c) =>
          c.attachOutput({
            sessionId: S,
            kind: "document",
            refId: randomUUID(),
          } as never),
      ],
      ["ensureChannel", (c) => c.ensureChannel({ sessionId: S })],
    ];
    for (const [name, call] of doors) {
      const member = await call(caller(MEMBER)).then(
        () => "OK",
        (e: { code?: string }) => e.code
      );
      expect({ name, member }).toEqual({ name, member: "NOT_FOUND" });
    }
    // Nothing the member attempted landed.
    const [row] = (
      await q<{ goal: string; status: string; expected_outputs: unknown }>(
        `select goal, status, expected_outputs from focus_sessions where id = $1`,
        [S]
      )
    ).rows;
    expect(row).toMatchObject({ goal: "Launch billing", status: "active" });
    expect(JSON.stringify(row!.expected_outputs)).not.toContain("sk_live");
    // The owner is unchanged: past the floor on every door.
    for (const [name, call] of doors) {
      const owner = await call(caller(OWNER)).then(
        () => "OK",
        (e: { code?: string }) => e.code
      );
      expect({ name, owner }).not.toEqual({ name, owner: "NOT_FOUND" });
    }
    expect((await caller(OWNER).get({ id: S })).goal).toBe("Hijacked");
  });

  it("a member SEES the owner's answers (the page is the owner's, never empty for them)", async () => {
    await caller(OWNER).answerOutput({
      sessionId: S,
      expectedLabel: "Stripe key",
      text: "in 1Password, vault Billing",
    });
    const own = await caller(OWNER).answers({ sessionId: S });
    expect(own.answers.map((a) => a.text)).toEqual([
      "in 1Password, vault Billing",
    ]);
    const shared = await caller(MEMBER).answers({ sessionId: S });
    expect(shared.answers).toEqual(own.answers);
    // Nobody else — and not the member through an agent key (v1).
    await expectNotFound(caller(COLLEAGUE).answers({ sessionId: S }));
    await expectNotFound(caller(AGENT).answers({ sessionId: S }));
    await expectNotFound(caller(MEMBER, AGENT).answers({ sessionId: S }));
  });
});
