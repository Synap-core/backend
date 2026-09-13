/**
 * WITHDRAW — the human-creator rung + the recorded reason, driven through the
 * REAL `proposals.withdraw` door on PGlite, and the rerun `replace` path that
 * reaches it with no injected withdraw.
 *
 * Real: the procedure (authority rungs, pending-only check, status + reason
 * write), `rerunSession` (parent load, pending set, the default withdraw caller),
 * `ensureIntakeSession`, `recordSessionRunManifest`. Tables are generated from
 * the Drizzle definitions, so every column the door selects exists.
 *
 * Stubbed, and why:
 *  - `discardProposalSourceBlob` / `emitProposalReviewed` — storage + realtime
 *    fan-out with their own suites (importOriginal + spread, never a total mock).
 *  - `openRunSession` — lives on `@synap/database`'s own connection (same stub
 *    as the intake / rerun suites).
 *  - the rerun's revert + replay — their own suites; injected.
 *  - `isPodReadOnly` — the split-brain guard every mutation passes; not
 *    modelled here (it reads the sync-generation table), pinned to "writable".
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
    db: drizzle(client, { schema: { proposals: actual.proposals as never } }),
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      source: string;
      extraMetadata?: Record<string, unknown>;
    }) => {
      const id = randomUUID();
      await client.query(
        `insert into focus_sessions (id, user_id, goal, status, metadata) values ($1, $2, $3, 'active', $4::jsonb)`,
        [
          id,
          input.userId,
          input.goal,
          JSON.stringify({
            source: input.source,
            ...(input.extraMetadata ?? {}),
          }),
        ]
      );
      return { sessionId: id, reused: false };
    },
  };
});
vi.mock(
  "../../../utils/store-entity-source-blob.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    discardProposalSourceBlob: vi.fn(async () => undefined),
  })
);
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitProposalReviewed: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  proposals,
  focusSessions,
  documents,
  documentVersions,
} from "@synap/database";
import { proposalsRouter } from "../../proposals.js";
import { proposalReasonBucket } from "../../../services/proposals/reason-bucket.js";
import {
  rerunSession,
  type RerunReplayers,
} from "../../../services/focus-sessions/rerun-session.js";
import type { revertSession } from "../../../services/focus-sessions/revert-session.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-1";
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

async function pending(opts: {
  createdBy: string;
  agentUserId?: string | null;
  proposedByUserId?: string | null;
  sessionId?: string | null;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, proposed_by_user_id, session_id, created_at, updated_at)
     values ($1, $2, 'capture.graph', 'entity', $3, '{}'::jsonb, $4, $5, $6, $7, now(), now())`,
    [
      id,
      opts.status ?? "pending",
      randomUUID(),
      opts.createdBy,
      opts.agentUserId ?? null,
      opts.proposedByUserId ?? null,
      opts.sessionId ?? null,
    ]
  );
  return id;
}

async function row(id: string) {
  const { rows } = await q<{
    status: string;
    withdraw_reason: string | null;
    rejection_reason: string | null;
    reason_code: string | null;
  }>(
    `select status, data->>'withdrawReason' as withdraw_reason, rejection_reason, reason_code
     from proposals where id = $1`,
    [id]
  );
  return rows[0]!;
}

const callerFor = (userId: string) =>
  proposalsRouter.createCaller({ db, authenticated: true, userId } as never);

describe("proposals.withdraw — the human creator of an agent-less proposal", () => {
  beforeAll(async () => {
    for (const t of [proposals, focusSessions, documents, documentVersions]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from proposals; delete from document_versions; delete from documents; delete from focus_sessions;"
    );
  });

  it("a human-captured pending proposal (no proposedByUserId, no agent) is withdrawable by its creator, with the reason kept", async () => {
    const id = await pending({ createdBy: USER });
    await expect(
      callerFor(USER).withdraw({
        proposalId: id,
        reason: "captured the wrong thing",
      })
    ).resolves.toEqual({ success: true });
    const withdrawn = await row(id);
    expect(withdrawn).toEqual({
      status: "withdrawn",
      withdraw_reason: "captured the wrong thing",
      rejection_reason: null,
      reason_code: null,
    });
    // The agent scorecard buckets `proposalReasonBucket(reasonCode, rejectionReason)`
    // for EVERY row: a withdrawal must not become a "top rejection reason".
    expect(
      proposalReasonBucket(withdrawn.reason_code, withdrawn.rejection_reason)
    ).toBeUndefined();

    const noReason = await pending({ createdBy: USER });
    await callerFor(USER).withdraw({ proposalId: noReason });
    expect(await row(noReason)).toMatchObject({
      status: "withdrawn",
      withdraw_reason: null,
      rejection_reason: null,
    });
  });

  it("a different user is refused, and the proposal stays pending", async () => {
    const id = await pending({ createdBy: USER });
    await expect(
      callerFor(OTHER).withdraw({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("pending");
  });

  it("an agent-created proposal still follows the old rungs only", async () => {
    // Agent authored as itself: the agent's human owner is NOT its creator here.
    const agentRow = await pending({ createdBy: AGENT, agentUserId: AGENT });
    await expect(
      callerFor(USER).withdraw({ proposalId: agentRow })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(agentRow)).status).toBe("pending");

    // The unchanged acting-agent rung (agentUserId set AND createdBy === caller).
    const acting = await pending({ createdBy: USER, agentUserId: AGENT });
    await expect(
      callerFor(USER).withdraw({ proposalId: acting })
    ).resolves.toEqual({ success: true });

    // The unchanged human-proposer rung.
    const proposed = await pending({
      createdBy: AGENT,
      agentUserId: AGENT,
      proposedByUserId: USER,
    });
    await expect(
      callerFor(USER).withdraw({ proposalId: proposed })
    ).resolves.toEqual({ success: true });
  });

  it("rerun replace now withdraws the parent's pending INTAKE rows through the real door, with the reason", async () => {
    const parent = randomUUID();
    const docId = randomUUID();
    await q(
      `insert into documents (id, user_id, title, type, mime_type, metadata, created_at, updated_at)
       values ($1, $2, 'src', 'markdown', 'text/markdown', $3::jsonb, now(), now())`,
      [
        docId,
        USER,
        JSON.stringify({
          intakeSource: {
            version: 1,
            kind: "text",
            contentHash: "h",
            sessionId: parent,
            door: "capture",
          },
        }),
      ]
    );
    await q(
      `insert into document_versions (id, document_id, version, content, author, author_id, created_at)
       values ($1, $2, 1, 'Call Bob', 'u', $3, now())`,
      [randomUUID(), docId, USER]
    );
    await q(
      `insert into focus_sessions (id, user_id, goal, status, metadata) values ($1, $2, 'Capture · Call Bob', 'closed', $3::jsonb)`,
      [
        parent,
        USER,
        JSON.stringify({
          intake: { door: "capture" },
          run: {
            version: 1,
            sourceDocumentIds: [docId],
            guidelines: [],
            engine: "structure",
            model: "m",
            promptVersion: "p",
            updatedAt: "t",
          },
        }),
      ]
    );
    const intakePending = await pending({ createdBy: USER, sessionId: parent });
    const replayers: RerunReplayers = {
      capture: async () => ({ outcome: "proposed", proposalId: randomUUID() }),
      import: async () => ({ outcome: "proposed", proposalId: randomUUID() }),
    };
    const revert = vi.fn(async (a: { sessionId: string }) => ({
      ok: true as const,
      sessionId: a.sessionId,
      proposals: [],
      counts: {
        reverted: 0,
        partial: 0,
        skipped: 0,
        permanent: 0,
        unsupported: 0,
        failed: 0,
        not_applicable: 0,
      },
    }));

    const res = await rerunSession({
      sessionId: parent,
      userId: USER,
      mode: "replace",
      replayers,
      revert: revert as unknown as typeof revertSession,
      callerContext: { db, authenticated: true, userId: USER } as never,
      database: db,
      // PGlite is one connection: the real FOR UPDATE transaction would block
      // the mint's own queries. Locking is the rerun suite's concern.
      withParentLock: (_parentId, fn) => fn(),
    });

    expect(res).toMatchObject({
      ok: true,
      revert: { withdrawnPending: [intakePending], pendingNotWithdrawn: [] },
    });
    const child = (res as { sessionId: string }).sessionId;
    expect(await row(intakePending)).toMatchObject({
      status: "withdrawn",
      withdraw_reason: `Replaced by rerun ${child}`,
      rejection_reason: null,
    });
  });
});
