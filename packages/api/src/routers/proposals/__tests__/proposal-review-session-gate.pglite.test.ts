/**
 * FOUNDER DECISIONS 2026-09-27 — who may DECIDE, and who may COMMENT on, a
 * proposal about a session.
 *
 *   (2) Nobody decides what they cannot read. Approve / reject / revise (and
 *       the doors that share their ladder: batch approve/reject, reopen,
 *       revert) need BOTH the review right (workspace role × policy) AND the
 *       ability to read the subject session, through THE session read rule
 *       (`sessionReadableWhere`) with the door's roster semantics: a human
 *       tRPC door honours the room roster, an agent door (Hub REST, MCP — both
 *       re-enter tRPC with `isHubProtocol` / an agent key) is owner-only.
 *   (3) A human who can read the session may COMMENT on its proposals even as
 *       a workspace viewer. Approval is unchanged by this.
 *
 * Cast (all in W, policy `any_editor` so every editor holds the review right):
 *   OWNER      editor, owns session T, seated in T's minted room
 *   MEMBER     editor, seated in T's room (roster)
 *   COLLEAGUE  editor, NOT on the roster
 *   VIEWER_IN  viewer, seated in T's room
 *   VIEWER_OUT viewer, NOT on the roster
 *
 * Real: PGlite, the tRPC proposals router, the review ladder, the session read
 * predicate, the revise core, the MCP reject handler, the anchor gate.
 * Stubbed: `applyProposalApproval` (the executor dispatch AFTER the gate — the
 * gate is what this file tests, and the session-close executor is not), and
 * `db.transaction` runs its body on the one PGlite connection (see the mock).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  applied: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  // PGlite is ONE connection: the revise core reads authority facts through
  // the global `db` while its own transaction holds that connection, which
  // deadlocks here (a pool gives production a second connection). Run the
  // transaction body on the same handle — the row lock is not under test.
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

// The executor dispatch AFTER the authority gate. Recording the id proves the
// gate let the call through; the gate itself stays real.
vi.mock("../apply-approval.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyProposalApproval: async (args: { proposal: { id: string } }) => {
      h.applied.push(args.proposal.id);
      return { success: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { proposalsRouter } from "../../proposals.js";
import { mergeProposalRevision } from "../../../services/proposals/proposals-service.js";
import { assertMessageAnchorAllowed } from "../../../utils/message-anchor.js";
import { buildHandlers } from "../../mcp/handlers/build.js";

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
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const MEMBER = randomUUID();
const COLLEAGUE = randomUUID();
const VIEWER_IN = randomUUID();
const VIEWER_OUT = randomUUID();
const WS = randomUUID();
const T = randomUUID();
const ROOM = randomUUID();

const human = (userId: string) => ({ authenticated: true, userId }) as never;
/** The Hub REST / MCP shape: a tRPC re-entry with the agent-door flags. */
const hubDoor = (userId: string) =>
  ({
    authenticated: true,
    userId,
    isHubProtocol: true,
    agentUserId: null,
  }) as never;

async function fileCloseProposal(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, session_id, data, revision_history, created_at, updated_at)
     values ($1, 'pending', 'update', 'focus_session', $2, $3, $4, $5::jsonb, '[]'::jsonb, now(), now())`,
    [
      id,
      T,
      WS,
      T,
      JSON.stringify({
        targetType: "focus_session",
        targetId: T,
        changeType: "update",
        sourceId: OWNER,
        source: "agent",
        data: { id: T, goal: "Close the Acme deal", status: "completed" },
      }),
    ]
  );
  return id;
}
/** A proposal about an ENTITY, filed in session T (`session_id` only). */
async function fileInSessionProposal(): Promise<string> {
  const id = randomUUID();
  const entityId = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, session_id, data, revision_history, created_at, updated_at)
     values ($1, 'pending', 'create', 'entity', $2, $3, $4, $5::jsonb, '[]'::jsonb, now(), now())`,
    [
      id,
      entityId,
      WS,
      T,
      JSON.stringify({
        targetType: "entity",
        targetId: entityId,
        changeType: "create",
        sourceId: OWNER,
        source: "agent",
        data: { id: entityId, title: "Acme follow-up" },
      }),
    ]
  );
  return id;
}
const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  const roles: Array<[string, string]> = [
    [OWNER, "editor"],
    [MEMBER, "editor"],
    [COLLEAGUE, "editor"],
    [VIEWER_IN, "viewer"],
    [VIEWER_OUT, "viewer"],
  ];
  for (const [u, role] of roles) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), WS, u, role]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'W', $2, $3::jsonb)`,
    [
      WS,
      randomUUID(), // nobody in the cast owns W — no pod-admin shortcut
      JSON.stringify({
        aiGovernance: { proposalApprovalPolicy: "any_editor" },
      }),
    ]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Close the Acme deal', 'active', '{}'::jsonb, '[]'::jsonb, $4, now(), now(), now())`,
    [T, OWNER, WS, ROOM]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [ROOM, OWNER, WS, T]
  );
  for (const m of [OWNER, MEMBER, VIEWER_IN]) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
      [randomUUID(), ROOM, m]
    );
  }
});

beforeEach(() => {
  h.applied = [];
});

const caller = (ctx: never) => proposalsRouter.createCaller(ctx);

// ── (2) the decide gate, door by door ──────────────────────────────────────
describe("(2) a workspace editor NOT in the session cannot decide it", () => {
  it("tRPC approve refuses, naming the session rule", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(COLLEAGUE)).approve({ proposalId: id })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Only people in this session"),
    });
    expect(h.applied).toEqual([]);
  });

  it("tRPC reject refuses and the row stays pending", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(COLLEAGUE)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("tRPC batchApprove records a FORBIDDEN item and applies nothing", async () => {
    const id = await fileCloseProposal();
    const { results } = await caller(human(COLLEAGUE)).batchApprove({
      proposalIds: [id],
    });
    expect(results).toEqual([
      expect.objectContaining({
        proposalId: id,
        success: false,
        errorCode: "FORBIDDEN",
      }),
    ]);
    expect(h.applied).toEqual([]);
  });

  it("tRPC batchReject refuses", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(COLLEAGUE)).batchReject({ proposalIds: [id] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("tRPC revise refuses", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(COLLEAGUE)).revise({
        proposalId: id,
        data: { data: { id: T, status: "cancelled" } },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the Hub door (tRPC re-entry with isHubProtocol) refuses approve and reject", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(hubDoor(COLLEAGUE)).approve({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(hubDoor(COLLEAGUE)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("the MCP reject tool refuses", async () => {
    const id = await fileCloseProposal();
    await expect(
      buildHandlers.synap_reject_proposal!({
        toolName: "synap_reject_proposal",
        args: { proposalId: id },
        userId: COLLEAGUE,
        apiKeyScopes: ["mcp.write", "mcp.read"],
        agentUserId: null,
      } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("the shared revise core (MCP + Hub revise doors) refuses", async () => {
    const id = await fileCloseProposal();
    await expect(
      mergeProposalRevision({
        proposalId: id,
        actorId: COLLEAGUE,
        summary: "rewritten by someone who cannot read it",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("list and get say so: viewerCanReview false, reason session-only", async () => {
    const id = await fileCloseProposal();
    const got = (await caller(human(COLLEAGUE)).get({ proposalId: id })) as {
      viewerCanReview: boolean;
      viewerCanReviewReason: string;
    };
    expect(got.viewerCanReview).toBe(false);
    expect(got.viewerCanReviewReason).toBe("session-only");
    const listed = (await caller(human(COLLEAGUE)).list({
      workspaceId: WS,
      limit: 50,
      offset: 0,
    } as never)) as {
      items: Array<{
        id: string;
        viewerCanReview: boolean;
        viewerCanReviewReason: string;
      }>;
    };
    const row = listed.items.find((r) => r.id === id);
    expect(row).toMatchObject({
      viewerCanReview: false,
      viewerCanReviewReason: "session-only",
    });
  });
});

describe("(2) the owner and a roster editor CAN decide", () => {
  it("the owner approves (tRPC) and the executor runs", async () => {
    const id = await fileCloseProposal();
    await caller(human(OWNER)).approve({ proposalId: id });
    expect(h.applied).toEqual([id]);
  });

  it("a roster editor approves (tRPC) and the executor runs", async () => {
    const id = await fileCloseProposal();
    await caller(human(MEMBER)).approve({ proposalId: id });
    expect(h.applied).toEqual([id]);
  });

  it("a roster editor rejects (tRPC)", async () => {
    const id = await fileCloseProposal();
    await caller(human(MEMBER)).reject({ proposalId: id });
    expect(await statusOf(id)).toBe("rejected");
  });

  it("a roster editor revises (tRPC)", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(MEMBER)).revise({
        proposalId: id,
        data: { data: { id: T, status: "completed" } },
      })
    ).resolves.toEqual({ success: true });
  });

  it("list/get stamp viewerCanReview true for the roster editor", async () => {
    const id = await fileCloseProposal();
    const got = (await caller(human(MEMBER)).get({ proposalId: id })) as {
      viewerCanReview: boolean;
    };
    expect(got.viewerCanReview).toBe(true);
  });

  it("door semantics: the owner decides on the Hub door, the roster editor does not (agent doors are owner-only)", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(hubDoor(MEMBER)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller(hubDoor(OWNER)).reject({ proposalId: id });
    expect(await statusOf(id)).toBe("rejected");
  });
});

// ── (3) comments ────────────────────────────────────────────────────────────
describe("(3) a viewer in the session may comment, not decide", () => {
  const anchorGate = (userId: string, proposalId: string, roster = true) =>
    assertMessageAnchorAllowed({
      anchor: { proposalId, contentVersion: 0 },
      channelId: ROOM,
      userId,
      roster,
    });

  it("a roster VIEWER passes the comment gate", async () => {
    const id = await fileCloseProposal();
    await expect(anchorGate(VIEWER_IN, id)).resolves.toBeUndefined();
  });

  it("…but cannot approve or reject (review right unchanged)", async () => {
    const id = await fileCloseProposal();
    await expect(
      caller(human(VIEWER_IN)).approve({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(human(VIEWER_IN)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.applied).toEqual([]);
  });

  it("the same viewer through an agent door (no roster) is refused a comment", async () => {
    const id = await fileCloseProposal();
    await expect(anchorGate(VIEWER_IN, id, false)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a NON-roster viewer can neither comment nor decide", async () => {
    const id = await fileCloseProposal();
    await expect(anchorGate(VIEWER_OUT, id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller(human(VIEWER_OUT)).approve({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(human(VIEWER_OUT)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an editor keeps commenting through the visibility gate (no widening needed)", async () => {
    const id = await fileCloseProposal();
    await expect(anchorGate(COLLEAGUE, id)).resolves.toBeUndefined();
  });
});

// ── (2) a proposal FILED in the session (session_id), not about it ─────────
describe("(2) a proposal filed in a session is decided only by its readers", () => {
  it("a non-roster editor is refused on approve and reject, and list/get say session-only", async () => {
    const id = await fileInSessionProposal();
    await expect(
      caller(human(COLLEAGUE)).approve({ proposalId: id })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Only people in this session"),
    });
    await expect(
      caller(human(COLLEAGUE)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.applied).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    const got = (await caller(human(COLLEAGUE)).get({ proposalId: id })) as {
      viewerCanReview: boolean;
      viewerCanReviewReason: string;
    };
    expect(got).toMatchObject({
      viewerCanReview: false,
      viewerCanReviewReason: "session-only",
    });
    const listed = (await caller(human(COLLEAGUE)).list({
      workspaceId: WS,
      limit: 50,
      offset: 0,
    } as never)) as {
      items: Array<{ id: string; viewerCanReviewReason: string }>;
    };
    expect(listed.items.find((r) => r.id === id)).toMatchObject({
      viewerCanReviewReason: "session-only",
    });
  });

  it("the same editor through the Hub door is refused", async () => {
    const id = await fileInSessionProposal();
    await expect(
      caller(hubDoor(COLLEAGUE)).reject({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the owner and a roster editor approve it", async () => {
    const a = await fileInSessionProposal();
    await caller(human(OWNER)).approve({ proposalId: a });
    const b = await fileInSessionProposal();
    await caller(human(MEMBER)).approve({ proposalId: b });
    expect(h.applied).toEqual([a, b]);
  });

  it("its content is NOT redacted for the non-reader (only a session target is)", async () => {
    const id = await fileInSessionProposal();
    const got = (await caller(human(COLLEAGUE)).get({ proposalId: id })) as {
      data: { data?: { title?: string } };
    };
    expect(got.data.data?.title).toBe("Acme follow-up");
  });
});
