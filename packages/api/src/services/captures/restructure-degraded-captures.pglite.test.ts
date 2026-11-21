/**
 * The degraded-capture sweep on PGlite (founder answer 8, ticket 1fed22a3):
 * text captures saved raw because the AI was unavailable or over quota are
 * structured once it answers again.
 *
 * Real: the sweep's selection, caps and bookkeeping; its DEFAULT redo path
 * (`restructureAsActor` → the real `structureCaptureAgain` → the real
 * `rerunSession`: refusals, adoption, child mint as the actor, body loading);
 * `stageIntakeSource`, both writing a degraded marker and clearing it on the
 * reuse a successful structure does.
 *
 * Stubbed, and why (the boundaries `structure-capture-again.pglite.test.ts`
 * uses): `openRunSession` (its own connection; the stub inserts the row and
 * records who it was opened for); the rerun REPLAYERS (the IS boundary: the stub
 * answers what the structurer would, and a success re-stages the raw exactly as
 * `capture.structure` does, which is what clears the marker); the parent lock
 * (PGlite is one connection); `@synap/storage`; the event fan-out; the AI probe.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  opened: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    buildPath: () => "unused",
    upload: async () => ({ url: "mem://x", path: "x", size: 0 }),
    downloadBuffer: async () => Buffer.from(""),
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      documents: actual.documents as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      workspaceId?: string | null;
      source: string;
      extraMetadata?: Record<string, unknown>;
    }) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (id, user_id, goal, status, workspace_id, metadata, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'active', $3, $4::jsonb, now(), now()) returning id`,
        [
          input.userId,
          input.goal,
          input.workspaceId ?? null,
          JSON.stringify({
            source: input.source,
            ...(input.extraMetadata ?? {}),
          }),
        ]
      );
      h.opened.push({ ...(input as object), id: rows[0]!.id });
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  artifacts,
  channelMembers,
  channels,
  chatTurns,
  documents,
  documentVersions,
  entities,
  entityFacets,
  focusSessions,
  links,
  messages,
  podMembers,
  profiles,
  profileWorkspaceAccess,
  projectMembers,
  proposals,
  relations,
  workspaceMembers,
  workspaces,
  users,
} from "@synap/database";
import {
  rerunSession,
  type ParentLock,
  type RerunItemResult,
  type RerunReplayers,
  type RerunSource,
} from "../focus-sessions/rerun-session.js";
import { stageIntakeSource } from "../intake/stage-intake-source.js";
import { sweepDegradedCaptures } from "./restructure-degraded-captures.js";

const A = "user-a";
const B = "user-b";
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

type ReplayAnswer = Omit<RerunItemResult, "sourceDocumentIds" | "door">;
/** What the structurer answers, per replay, in order; default: a proposal. */
const answers: ReplayAnswer[] = [];
// Only the capture replayer records: its arm of the union.
const replayed: Array<Extract<RerunSource, { door: "capture" }>> = [];
const replayers: RerunReplayers = {
  capture: async (source, a) => {
    replayed.push(source);
    const answer = answers.shift() ?? {
      outcome: "proposed",
      proposalId: randomUUID(),
    };
    if (answer.outcome === "proposed") {
      // What `capture.structure` does on a structure that ran: it stages the
      // same raw again, NOT degraded, onto the stored row.
      const [{ user_id }] = (
        await q<{ user_id: string }>(
          `select user_id from documents where id = $1`,
          [source.sourceDocumentId]
        )
      ).rows;
      await stageIntakeSource({
        database: db,
        userId: user_id!,
        sessionId: a.childSessionId,
        door: "capture",
        kind: "text",
        text: source.input.text,
        reuseDocumentId: source.sourceDocumentId,
      });
    }
    return answer;
  },
  import: async () => ({ outcome: "failed", reason: "not in this test" }),
};
const lock: ParentLock = (_id, fn) => fn();
const rerun: typeof rerunSession = (a) =>
  rerunSession({ ...a, replayers, withParentLock: lock });

const probed: string[] = [];
let aiAnswers = true;
const sweep = (over: Parameters<typeof sweepDegradedCaptures>[0] = {}) =>
  sweepDegradedCaptures({
    rerun,
    probe: async (userId) => {
      probed.push(userId);
      return aiAnswers;
    },
    ...over,
  });

let clock = Date.parse("2026-11-21T10:00:00Z");
/** A capture saved raw: an intake source with a `degraded` marker. */
async function degradedCapture(
  opts: {
    userId?: string;
    kind?: string;
    reason?: string | null;
    agentUserId?: string | null;
    /** Leave the marker's actor out (a capture saved before it was recorded). */
    legacy?: boolean;
    sessionId?: string | null;
    text?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  clock += 60_000;
  const reason =
    opts.reason === undefined ? "is_invalid_response" : opts.reason;
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, mime_type, metadata, created_at, updated_at)
     values ($1, $2, null, 'src', 'markdown', 'text/markdown', $3::jsonb, now(), now())`,
    [
      id,
      opts.userId ?? A,
      JSON.stringify({
        intakeSource: {
          version: 1,
          kind: opts.kind ?? "text",
          contentHash: randomUUID(),
          sessionId: opts.sessionId ?? null,
          door: "capture",
          ...(reason
            ? {
                degraded: {
                  reason,
                  failureClass: "account_quota",
                  ...(opts.legacy
                    ? {}
                    : { agentUserId: opts.agentUserId ?? null }),
                  at: new Date(clock).toISOString(),
                },
              }
            : {}),
        },
      }),
    ]
  );
  await q(
    `insert into document_versions (id, document_id, version, content) values ($1, $2, 1, $3)`,
    [
      randomUUID(),
      id,
      opts.text ?? "met Dana about the lease, follow up Friday",
    ]
  );
  return id;
}

const sourceMeta = async (documentId: string) =>
  (
    await q<{ metadata: { intakeSource: Record<string, any> } }>(
      `select metadata from documents where id = $1`,
      [documentId]
    )
  ).rows[0]!.metadata.intakeSource;

/** Rerun children are minted with the parent they spawn from. */
const childMints = () => h.opened.filter((o) => o.parentSessionId);

/** Close every rerun child: the next run is a new rerun, not "the same click". */
const closeChildren = () =>
  q(
    `update focus_sessions set status = 'completed' where id = any($1::uuid[])`,
    [childMints().map((o) => o.id as string)]
  );

describe("the degraded-capture sweep", () => {
  beforeAll(async () => {
    for (const t of [
      documents,
      documentVersions,
      entities,
      entityFacets,
      relations,
      projectMembers,
      workspaces,
      workspaceMembers,
      podMembers,
      focusSessions,
      links,
      messages,
      profiles,
      profileWorkspaceAccess,
      proposals,
      chatTurns,
      users,
      artifacts,
      channels,
      channelMembers,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text not null, state text not null, data jsonb not null);`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from documents; delete from document_versions; delete from focus_sessions; delete from proposals;"
    );
    h.opened.length = 0;
    replayed.length = 0;
    answers.length = 0;
    probed.length = 0;
    aiAnswers = true;
  });

  it("an agent's capture saved raw is structured again AS THAT AGENT, once, and its raw is kept", async () => {
    const doc = await degradedCapture({ agentUserId: AGENT });

    const out = await sweep();
    expect(out).toMatchObject({ status: "ran", attempted: 1, restructured: 1 });
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual([doc]);
    expect(replayed[0]!.input.text).toBe(
      "met Dana about the lease, follow up Friday"
    );
    // The redo ran as the agent: its rerun room was opened for the agent, so
    // the structured graph is filed under the agent's governance.
    expect(childMints()).toHaveLength(1);
    expect(childMints()[0]!.agentUserId).toBe(AGENT);

    const meta = await sourceMeta(doc);
    expect(meta.degraded).toBeUndefined();
    expect(meta.restructuredAt).toEqual(expect.any(String));
    expect(meta.restructureSweep).toMatchObject({
      failures: 0,
      lastOutcome: "proposed",
    });
    // The raw is kept: the source row is still there, not deleted.
    expect(
      (
        await q(
          `select id from documents where id = $1 and deleted_at is null`,
          [doc]
        )
      ).rows
    ).toHaveLength(1);

    // Never twice: the marker is gone, so the next run has nothing to do.
    await closeChildren();
    expect(await sweep()).toMatchObject({ status: "idle", attempted: 0 });
    expect(replayed).toHaveLength(1);
  });

  it("a person's capture is structured as the person", async () => {
    await degradedCapture({ agentUserId: null });
    await sweep();
    expect(childMints()).toHaveLength(1);
    expect(childMints()[0]!.agentUserId ?? null).toBeNull();
  });

  it("a capture saved before the marker named its actor, in an agent's run room, is structured as that agent", async () => {
    const run = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, origin, agent_ids, metadata, created_at, updated_at)
       values ($1, $2, 'Capture', 'completed', 'agent', $3, '{}'::jsonb, now(), now())`,
      [run, A, [AGENT]]
    );
    const doc = await degradedCapture({ legacy: true, sessionId: run });
    await q(`update focus_sessions set metadata = $1::jsonb where id = $2`, [
      JSON.stringify({ run: { sourceDocumentIds: [doc] } }),
      run,
    ]);
    await sweep();
    expect(childMints()).toHaveLength(1);
    expect(childMints()[0]!.agentUserId).toBe(AGENT);
  });

  it("a quota answer stops that owner's sweep and marks NOTHING; another owner goes on", async () => {
    const a1 = await degradedCapture({ userId: A });
    const a2 = await degradedCapture({ userId: A });
    const b1 = await degradedCapture({ userId: B });
    answers.push({
      outcome: "not_structured",
      reason: "is_invalid_response",
      failureClass: "account_quota",
    });

    const out = await sweep();
    expect(out.stopped).toEqual([{ userId: A, reason: "account_quota" }]);
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual([a1, b1]);
    expect(out).toMatchObject({ attempted: 1, restructured: 1, failed: 0 });
    for (const id of [a1, a2]) {
      const meta = await sourceMeta(id);
      expect(meta.degraded).toMatchObject({ reason: "is_invalid_response" });
      expect(meta.restructureSweep).toBeUndefined();
    }
  });

  it("an AI that does not answer its probe: nothing is structured, nothing is marked", async () => {
    const doc = await degradedCapture();
    aiAnswers = false;
    const out = await sweep();
    expect(out).toMatchObject({ attempted: 0, stopped: [{ userId: A }] });
    expect(replayed).toEqual([]);
    expect(childMints()).toEqual([]);
    expect((await sourceMeta(doc)).restructureSweep).toBeUndefined();
  });

  it("a capture that fails three times for another reason is left alone, with its reason", async () => {
    const doc = await degradedCapture();
    for (let run = 1; run <= 3; run++) {
      answers.push({
        outcome: "not_structured",
        reason: "is_empty_result",
        failureClass: "invalid_response",
      });
      expect(await sweep()).toMatchObject({ attempted: 1, failed: 1 });
      await closeChildren();
    }
    expect((await sourceMeta(doc)).restructureSweep).toMatchObject({
      failures: 3,
      lastOutcome: "failed",
      lastReason: expect.stringContaining("is_empty_result"),
    });
    expect(await sweep()).toMatchObject({ status: "idle", attempted: 0 });
    expect(replayed).toHaveLength(3);
  });

  it("oldest first, at most the per-run cap; the daily cap holds across runs", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await degradedCapture());
    const now = new Date("2026-11-21T12:00:00Z");

    expect(await sweep({ now, perRun: 3, perDay: 4 })).toMatchObject({
      attempted: 3,
    });
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual(ids.slice(0, 3));
    expect(await sweep({ now, perRun: 3, perDay: 4 })).toMatchObject({
      attempted: 1,
    });
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual(ids.slice(0, 4));
    expect(await sweep({ now, perRun: 3, perDay: 4 })).toMatchObject({
      status: "daily_cap",
      attempted: 0,
    });
    // A new day, a new allowance.
    expect(
      await sweep({
        now: new Date("2026-11-22T00:30:00Z"),
        perRun: 3,
        perDay: 4,
      })
    ).toMatchObject({ attempted: 3 });
  });

  it("only text captures saved because the AI did not answer are swept", async () => {
    await degradedCapture({ reason: "is_empty_result" });
    await degradedCapture({ reason: "pdf_scanned_needs_ocr" });
    await degradedCapture({ reason: "vision_provider_not_configured" });
    await degradedCapture({ kind: "file" });
    await degradedCapture({ reason: null });
    expect(await sweep()).toMatchObject({ status: "idle", attempted: 0 });
    expect(probed).toEqual([]);

    const budget = await degradedCapture({ reason: "llm_budget_exceeded" });
    const auth = await degradedCapture({ reason: "is_auth_error" });
    await sweep();
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual([budget, auth]);
  });

  it("stageIntakeSource keeps the failure class and the actor on the marker", async () => {
    const staged = await stageIntakeSource({
      database: db,
      userId: A,
      sessionId: null,
      door: "capture",
      kind: "text",
      text: "a raw capture",
      degraded: {
        reason: "is_invalid_response",
        failureClass: "account_quota",
        agentUserId: AGENT,
      },
    });
    expect((await sourceMeta(staged.documentId)).degraded).toMatchObject({
      reason: "is_invalid_response",
      failureClass: "account_quota",
      agentUserId: AGENT,
      at: expect.any(String),
    });
  });
});
