/**
 * RERUN = A NEW SESSION spawned from the previous one — driven on a real
 * Postgres (PGlite).
 *
 * Real: `rerunSession` (parent load + owner floor, manifest read, source rows
 * and bodies back out of `documents` / `document_versions`, proposal counts,
 * cap, refusals, import grouping), `assessRerunAvailability` (the real
 * `pgboss.job` + `chat_turns` reads shared with the cancel door),
 * `ensureIntakeSession`, `recordSessionRunManifest` (real SQL + row lock).
 * Every assertion reads rows back.
 *
 * Stubbed, and why:
 *  - `openRunSession` — lives in `@synap/database` on that package's own
 *    connection (same stub as `intake-run.pglite.test.ts`). It records the
 *    `parentSessionId` it was handed; the `spawned_from` edge insert itself is
 *    openRunSession's and is NOT proven here.
 *  - the REPLAYERS (capture.structure → submitCaptureGraph, import analyze) —
 *    they need the IS, profiles and search. The stub is the IS boundary.
 *  - `revertSession` / withdraw — their own suites; injected so ORDER and the
 *    failure shapes are observable.
 *  - the PARENT LOCK — PGlite is one connection: a real `FOR UPDATE`
 *    transaction blocks every other query (measured), so the mint inside it
 *    would deadlock. Tests inject a recording lock; that two real connections
 *    serialize is NEEDS-DOGFOOD.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  opened: [] as Array<Record<string, unknown>>,
  /** When set, the stub mints the child under this user (forces a lineage miss). */
  mintUser: null as string | null,
}));

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    buildPath: () => "unused",
    upload: async () => ({ url: "mem://x", path: "x", size: 0 }),
    downloadBuffer: async () => {
      throw new Error("no object storage in this test");
    },
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
    db: drizzle(client),
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      workspaceId?: string | null;
      source: string;
      parentSessionId?: string | null;
      extraMetadata?: Record<string, unknown>;
    }) => {
      h.opened.push(input as unknown as Record<string, unknown>);
      const metadata = { source: input.source, ...(input.extraMetadata ?? {}) };
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (user_id, goal, status, workspace_id, origin, metadata)
         values ($1, $2, 'active', $3, 'agent', $4::jsonb) returning id`,
        [
          h.mintUser ?? input.userId,
          input.goal,
          input.workspaceId ?? null,
          JSON.stringify(metadata),
        ]
      );
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

import { db } from "@synap/database";
import {
  rerunSession,
  assessRerunAvailability,
  RERUN_MAX_SOURCES,
  type ParentLock,
  type RerunReplayers,
} from "../rerun-session.js";
import {
  readSessionRunManifest,
  recordSessionRunManifest,
} from "../../intake/record-session-run-manifest.js";
import type { revertSession } from "../revert-session.js";
import { listRunSources } from "../run-sources.js";

const USER = "user-1";
const OTHER = "user-2";

const DDL = `
  create table focus_sessions (
    id uuid primary key default gen_random_uuid(), user_id text not null,
    goal text not null default '', status text not null default 'active',
    workspace_id text, project_id uuid, channel_id uuid, origin text, playbook_id uuid,
    metadata jsonb not null default '{}'::jsonb
  );
  create table documents (
    id uuid primary key default gen_random_uuid(), user_id text not null,
    workspace_id uuid, title text not null, type text not null default 'markdown',
    storage_key text, mime_type text, metadata jsonb,
    created_at timestamptz not null default now(), deleted_at timestamptz
  );
  create table document_versions (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references documents(id) on delete cascade,
    version integer not null, content text not null
  );
  create table proposals (
    id uuid primary key default gen_random_uuid(), session_id uuid,
    status text not null, proposal_type text not null default 'capture.graph',
    created_at timestamptz not null default now()
  );
  create schema pgboss;
  create table pgboss.job (
    id uuid primary key default gen_random_uuid(), name text not null,
    state text not null, data jsonb not null
  );
  create table chat_turns (
    id uuid primary key default gen_random_uuid(), channel_id uuid,
    user_id text, status text
  );
`;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Runs the mint directly, recording that it happened inside the lock. */
const lockLog: string[] = [];
const recordingLock: ParentLock = async (parentId, fn) => {
  lockLog.push(`lock:${parentId}`);
  const out = await fn();
  lockLog.push(`unlock:opened=${h.opened.length}`);
  return out;
};

type RunArgs = Parameters<typeof rerunSession>[0];
const run = (
  a: Omit<RunArgs, "database" | "withParentLock"> & Partial<RunArgs>
) => rerunSession({ database: db, withParentLock: recordingLock, ...a });

/** Counts body reads: every stored object read goes through here. */
function countingRead(bodies: Record<string, string> = {}) {
  const keys: string[] = [];
  const readBytes = async (key: string) => {
    keys.push(key);
    return Buffer.from(bodies[key] ?? `body of ${key}`);
  };
  return { keys, readBytes };
}

async function source(opts: {
  kind: "text" | "url" | "import_item";
  body: string;
  url?: string;
  path?: string;
  degraded?: boolean;
  userId?: string;
  storageKey?: string;
}): Promise<string> {
  const meta = {
    intakeSource: {
      version: 1,
      kind: opts.kind,
      contentHash: randomUUID(),
      sessionId: null,
      door: opts.kind === "import_item" ? "import" : "capture",
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.path ? { path: opts.path } : {}),
      ...(opts.degraded
        ? { degraded: { reason: "is_invalid_response", at: "t" } }
        : {}),
    },
  };
  const { rows } = await q<{ id: string }>(
    `insert into documents (user_id, title, mime_type, storage_key, metadata)
     values ($1, $2, 'text/markdown', $3, $4::jsonb) returning id`,
    [
      opts.userId ?? USER,
      opts.path ?? "src",
      opts.storageKey ?? null,
      JSON.stringify(meta),
    ]
  );
  await q(
    `insert into document_versions (document_id, version, content) values ($1, 1, $2)`,
    [rows[0]!.id, opts.body]
  );
  return rows[0]!.id;
}

async function parentSession(opts: {
  sourceDocumentIds: string[];
  status?: string;
  userId?: string;
  channelId?: string;
}): Promise<string> {
  const run = {
    version: 1,
    sourceDocumentIds: opts.sourceDocumentIds,
    guidelines: [{ id: "g", version: 1 }],
    engine: "structure",
    model: "m",
    promptVersion: "p1",
    idempotencyNamespace: "user-1:content-hash",
    updatedAt: "t",
  };
  const { rows } = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal, status, channel_id, metadata)
     values ($1, 'Capture · notes', $2, $3, $4::jsonb) returning id`,
    [
      opts.userId ?? USER,
      opts.status ?? "closed",
      opts.channelId ?? null,
      JSON.stringify({ intake: { door: "capture" }, run }),
    ]
  );
  return rows[0]!.id;
}

async function proposal(sessionId: string, status: string) {
  await q(`insert into proposals (session_id, status) values ($1, $2)`, [
    sessionId,
    status,
  ]);
}

async function sessionCount(): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from focus_sessions`
  );
  return rows[0]!.n;
}

const okRevert = (counts: Partial<Record<string, number>> = {}) =>
  vi.fn(async (a: { sessionId: string }) => ({
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
      ...counts,
    },
  }));

/** The IS boundary: records what it was asked to structure, writes a v2 manifest patch. */
function recordingReplayers() {
  const calls: Array<{
    door: string;
    payload: unknown;
    child: string;
    ns: string;
  }> = [];
  const replayers: RerunReplayers = {
    capture: async (s, a) => {
      calls.push({
        door: "capture",
        payload: s.input,
        child: a.childSessionId,
        ns: a.idempotencyNamespace,
      });
      await recordSessionRunManifest({
        database: db,
        sessionId: a.childSessionId,
        userId: USER,
        patch: {
          sourceDocumentIds: [randomUUID()],
          guidelines: [{ id: "g", version: 2 }],
          engine: "structure",
          model: "m2",
          promptVersion: "p2",
        },
      });
      return { outcome: "proposed", proposalId: randomUUID() };
    },
    import: async (items, a) => {
      calls.push({
        door: "import",
        payload: items.map((i) => i.item),
        child: a.childSessionId,
        ns: a.idempotencyNamespace,
      });
      return { outcome: "proposed", proposalId: randomUUID() };
    },
  };
  return { calls, replayers };
}

describe("rerunSession — a rerun is a new session spawned from the previous one", () => {
  beforeAll(async () => {
    await h.client!.exec(DDL);
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from proposals; delete from document_versions; delete from documents; delete from focus_sessions; delete from pgboss.job; delete from chat_turns;"
    );
    h.opened.length = 0;
    h.mintUser = null;
    lockLog.length = 0;
  });

  it("dry-run counts sources, what replace would revert, the cap and availability — and reads NO bodies", async () => {
    const text = await source({
      kind: "text",
      body: "Met Ada",
      degraded: true,
      storageKey: "k-text",
    });
    const url = await source({
      kind: "url",
      body: "<p>page</p>",
      url: "https://ex.com/a",
      storageKey: "k-url",
    });
    const item = await source({
      kind: "import_item",
      body: "# Note",
      path: "vault/a.md",
      storageKey: "k-item",
    });
    const gone = randomUUID();
    const parent = await parentSession({
      sourceDocumentIds: [text, url, item, gone],
    });
    await proposal(parent, "approved");
    await proposal(parent, "auto_approved");
    await proposal(parent, "pending");
    await proposal(parent, "rejected");
    const { keys, readBytes } = countingRead();

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "replace",
      dryRun: true,
      readBytes,
    });

    expect(res).toMatchObject({
      ok: true,
      status: "dry_run",
      availability: { available: true },
      plan: {
        sources: {
          selected: 4,
          capture: 2,
          import: 1,
          degraded: 1,
          missing: [gone],
          notInRun: [],
        },
        replaceWouldRevert: 2,
        parentPending: 1,
        estimatedStructureCalls: 3,
        cap: { max: RERUN_MAX_SOURCES, withinCap: true },
      },
    });
    expect(keys).toEqual([]);
    expect(await sessionCount()).toBe(1);
    expect(h.opened).toHaveLength(0);

    // Positive control: a real run of the same sources DOES read their bodies.
    await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      readBytes,
      replayers: recordingReplayers().replayers,
    });
    expect(keys.sort()).toEqual(["k-item", "k-text", "k-url"]);
  });

  it("over the cap: refused with the count, nothing minted, and NO body read (dry run or real)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < RERUN_MAX_SOURCES + 1; i++) {
      ids.push(
        await source({ kind: "text", body: `b${i}`, storageKey: `k${i}` })
      );
    }
    const parent = await parentSession({ sourceDocumentIds: ids });
    const { keys, readBytes } = countingRead();

    const dry = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      dryRun: true,
      readBytes,
    });
    expect(dry).toMatchObject({
      ok: true,
      plan: { cap: { withinCap: false } },
    });

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      readBytes,
    });
    expect(res).toMatchObject({ ok: false, reason: "over_cap" });
    expect((res as { message: string }).message).toContain(
      String(RERUN_MAX_SOURCES + 1)
    );
    expect(keys).toEqual([]);
    expect(await sessionCount()).toBe(1);
  });

  it("add: mints a spawned session with a NEW namespace, records lineage, and re-structures the STORED sources", async () => {
    const text = await source({
      kind: "text",
      body: "Met Ada about the Q3 deal",
      degraded: true,
    });
    const item = await source({
      kind: "import_item",
      body: "# Imported note",
      path: "vault/a.md",
    });
    const parent = await parentSession({ sourceDocumentIds: [text, item] });
    const { calls, replayers } = recordingReplayers();
    const revert = vi.fn();

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      reason: "guideline changed",
      replayers,
      revert: revert as unknown as typeof revertSession,
    });

    expect(res).toMatchObject({
      ok: true,
      status: "rerun",
      parentSessionId: parent,
      mode: "add",
      lineageRecorded: true,
    });
    const child = (res as { sessionId: string }).sessionId;
    expect(child).not.toBe(parent);
    expect(revert).not.toHaveBeenCalled();
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({
      parentSessionId: parent,
      source: "intake:capture",
    });

    expect(calls).toEqual([
      {
        door: "capture",
        payload: { text: "Met Ada about the Q3 deal" },
        child,
        ns: `rerun:${child}`,
      },
      {
        door: "import",
        payload: [{ path: "vault/a.md", content: "# Imported note" }],
        child,
        ns: `rerun:${child}`,
      },
    ]);

    const [childRow] = (
      await q<{ metadata: unknown }>(
        `select metadata from focus_sessions where id = $1`,
        [child]
      )
    ).rows;
    const childManifest = readSessionRunManifest(childRow!.metadata)!;
    expect(childManifest.idempotencyNamespace).toBe(`rerun:${child}`);
    expect(childManifest.rerun).toMatchObject({
      parentSessionId: parent,
      mode: "add",
      reason: "guideline changed",
    });
    expect(childManifest.guidelines).toEqual([{ id: "g", version: 2 }]);

    const [parentRow] = (
      await q<{ metadata: unknown }>(
        `select metadata from focus_sessions where id = $1`,
        [parent]
      )
    ).rows;
    const parentManifest = readSessionRunManifest(parentRow!.metadata)!;
    expect(parentManifest.idempotencyNamespace).toBe("user-1:content-hash");
    expect(parentManifest.rerun).toBeUndefined();
  });

  it("decision C: the child is minted INSIDE the parent lock, before any revert or replay", async () => {
    const text = await source({ kind: "text", body: "Call Bob" });
    const parent = await parentSession({ sourceDocumentIds: [text] });
    const order: string[] = [];
    const { replayers: inner } = recordingReplayers();
    const replayers: RerunReplayers = {
      capture: async (s, a) => {
        order.push("replay");
        return inner.capture(s, a);
      },
      import: inner.import,
    };
    const revert = vi.fn(async (a: { sessionId: string }) => {
      order.push(
        `revert:${a.sessionId === parent ? "parent" : "other"}:sessions=${await sessionCount()}`
      );
      return {
        ok: true as const,
        sessionId: a.sessionId,
        proposals: [
          {
            proposalId: "p1",
            proposalType: "capture.graph",
            outcome: "reverted" as const,
          },
          {
            proposalId: "p2",
            proposalType: "capture.graph",
            outcome: "skipped" as const,
            skipped: [],
            stillThere: ["e1"],
          },
        ],
        counts: {
          reverted: 1,
          partial: 0,
          skipped: 1,
          permanent: 0,
          unsupported: 0,
          failed: 0,
          not_applicable: 0,
        },
      };
    });

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "replace",
      replayers,
      revert: revert as unknown as typeof revertSession,
    });

    expect(lockLog).toEqual([`lock:${parent}`, "unlock:opened=1"]);
    expect(order).toEqual(["revert:parent:sessions=2", "replay"]);
    expect(res).toMatchObject({
      ok: true,
      status: "rerun",
      mode: "replace",
      revert: {
        counts: { reverted: 1, skipped: 1 },
        notClean: [
          { proposalId: "p2", outcome: "skipped", stillThere: ["e1"] },
        ],
      },
    });
  });

  it("a non-owner cannot rerun; an agent cannot replace", async () => {
    const text = await source({ kind: "text", body: "x" });
    const parent = await parentSession({ sourceDocumentIds: [text] });
    const { calls, replayers } = recordingReplayers();

    expect(
      await run({ sessionId: parent, userId: OTHER, mode: "add", replayers })
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await run({
        sessionId: parent,
        userId: USER,
        mode: "replace",
        agentUserId: "agent-1",
        replayers,
      })
    ).toMatchObject({ ok: false, reason: "replace_is_a_human_decision" });
    // The DRY RUN refuses too — a confirm is never shown for a refused action.
    expect(
      await run({
        sessionId: parent,
        userId: USER,
        mode: "replace",
        agentUserId: "agent-1",
        dryRun: true,
        replayers,
      })
    ).toMatchObject({ ok: false, reason: "replace_is_a_human_decision" });
    // …while an agent's ADD dry run is still a normal plan.
    expect(
      await run({
        sessionId: parent,
        userId: USER,
        mode: "add",
        agentUserId: "agent-1",
        dryRun: true,
        replayers,
      })
    ).toMatchObject({ ok: true, status: "dry_run" });
    expect(calls).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  it("decision B: an ACTIVE intake session with no in-flight work is rerunnable; a queued job or a running turn blocks it; the session is never closed", async () => {
    const text = await source({ kind: "text", body: "Call Bob" });
    const channel = randomUUID();
    const parent = await parentSession({
      sourceDocumentIds: [text],
      status: "active",
      channelId: channel,
    });
    const { replayers } = recordingReplayers();

    // A finished job and another session's job are not this session's work.
    await q(
      `insert into pgboss.job (name, state, data) values ('capture', 'completed', $1::jsonb)`,
      [JSON.stringify({ userId: USER, sessionId: parent })]
    );
    await q(
      `insert into pgboss.job (name, state, data) values ('capture', 'created', $1::jsonb)`,
      [JSON.stringify({ userId: USER, sessionId: randomUUID() })]
    );
    expect(
      await run({ sessionId: parent, userId: USER, mode: "add", dryRun: true })
    ).toMatchObject({
      availability: { available: true },
    });

    // A queued job bound to the session → in flight, nothing minted.
    await q(
      `insert into pgboss.job (name, state, data) values ('capture', 'created', $1::jsonb)`,
      [JSON.stringify({ userId: USER, sessionId: parent })]
    );
    const queued = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      replayers,
    });
    expect(queued).toMatchObject({ ok: false, reason: "in_flight" });
    expect((queued as { message: string }).message).toContain("work in flight");
    expect(h.opened).toHaveLength(0);

    // A running reply in the session's channel → in flight too.
    await q(`delete from pgboss.job`);
    await q(
      `insert into chat_turns (channel_id, user_id, status) values ($1, $2, 'running')`,
      [channel, USER]
    );
    expect(
      await run({ sessionId: parent, userId: USER, mode: "add", replayers })
    ).toMatchObject({ ok: false, reason: "in_flight" });

    // Nothing in flight → the rerun runs, and the parent stays active.
    await q(`update chat_turns set status = 'completed'`);
    expect(
      await run({ sessionId: parent, userId: USER, mode: "add", replayers })
    ).toMatchObject({ ok: true, status: "rerun" });
    const [row] = (
      await q<{ status: string }>(
        `select status from focus_sessions where id = $1`,
        [parent]
      )
    ).rows;
    expect(row!.status).toBe("active");
  });

  it("availability: no stored sources → no_manifest; a failed in-flight read → availability_unknown, never available", async () => {
    const bare = {
      id: randomUUID(),
      userId: USER,
      status: "closed",
      channelId: null,
      metadata: {},
    };
    expect(await assessRerunAvailability(db, bare)).toEqual({
      available: false,
      reason: "no_manifest",
    });

    const withRun = {
      ...bare,
      status: "active",
      metadata: {
        run: {
          version: 1,
          sourceDocumentIds: [randomUUID()],
          guidelines: [],
          engine: "structure",
          model: "m",
          promptVersion: "p",
          updatedAt: "t",
        },
      },
    };
    const broken = {
      execute: async () => {
        throw new Error("pgboss unreachable");
      },
      select: db.select.bind(db),
    } as unknown as typeof db;
    expect(await assessRerunAvailability(broken, withRun)).toEqual({
      available: false,
      reason: "availability_unknown",
    });
    // A terminal session never needs the in-flight read.
    expect(
      await assessRerunAvailability(broken, { ...withRun, status: "closed" })
    ).toEqual({ available: true });
  });

  it("a mixed import replays once PER ADAPTER (md and csv never share one)", async () => {
    const md = await source({
      kind: "import_item",
      body: "# Note",
      path: "vault/a.md",
    });
    const csv = await source({
      kind: "import_item",
      body: "name\nAda",
      path: "people.csv",
    });
    const md2 = await source({
      kind: "import_item",
      body: "# Two",
      path: "vault/b.md",
    });
    const parent = await parentSession({ sourceDocumentIds: [md, csv, md2] });
    const { calls, replayers } = recordingReplayers();

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      replayers,
    });

    const importCalls = calls
      .filter((c) => c.door === "import")
      .map((c) => (c.payload as Array<{ path: string }>).map((i) => i.path));
    expect(importCalls).toEqual([["vault/a.md", "vault/b.md"], ["people.csv"]]);
    expect(res).toMatchObject({
      ok: true,
      items: [
        { door: "import", sourceDocumentIds: [md, md2] },
        { door: "import", sourceDocumentIds: [csv] },
      ],
    });
  });

  it("honest failures: an unrecorded lineage says so; an unreadable import item stays door:import", async () => {
    const item = await source({
      kind: "import_item",
      body: "   ",
      path: "vault/empty.md",
    });
    const text = await source({ kind: "text", body: "Call Bob" });
    const parent = await parentSession({ sourceDocumentIds: [item, text] });
    const { replayers } = recordingReplayers();
    h.mintUser = "someone-else";

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      replayers,
    });

    expect(res).toMatchObject({
      ok: true,
      status: "partial",
      lineageRecorded: false,
      items: [
        { sourceDocumentIds: [text], door: "capture", outcome: "proposed" },
        {
          sourceDocumentIds: [item],
          door: "import",
          outcome: "failed",
          reason: "source document has no readable body",
        },
      ],
    });
  });

  it("honest failures: a revert that did not run (refused or thrown) names the child and replays NOTHING", async () => {
    const text = await source({ kind: "text", body: "Call Bob" });
    const parent = await parentSession({ sourceDocumentIds: [text] });
    const { calls, replayers } = recordingReplayers();

    const refused = await run({
      sessionId: parent,
      userId: USER,
      mode: "replace",
      replayers,
      revert: (async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })) as unknown as typeof revertSession,
    });
    expect(refused).toMatchObject({
      ok: true,
      status: "failed",
      revert: {
        notRun: true,
        reason: "the parent could not be reverted: not_found",
      },
      items: [],
    });
    expect((refused as { sessionId: string }).sessionId).toBeTruthy();

    const thrown = await run({
      sessionId: parent,
      userId: USER,
      mode: "replace",
      now: new Date(Date.now() + 5 * 60_000),
      replayers,
      revert: (async () => {
        throw new Error("pool exhausted");
      }) as unknown as typeof revertSession,
    });
    expect(thrown).toMatchObject({
      ok: true,
      status: "failed",
      revert: {
        notRun: true,
        reason: "the parent could not be reverted: pool exhausted",
      },
    });
    expect((thrown as { sessionId: string }).sessionId).not.toBe(
      (refused as { sessionId: string }).sessionId
    );
    expect(calls).toHaveLength(0);
  });

  it("a replay that throws is a named failed item, and the rest still run", async () => {
    const a = await source({ kind: "text", body: "one" });
    const b = await source({ kind: "text", body: "two" });
    const parent = await parentSession({ sourceDocumentIds: [a, b] });
    const { replayers: inner } = recordingReplayers();
    const replayers: RerunReplayers = {
      capture: async (s, args) => {
        if ((s.input.text ?? "") === "one") throw new Error("IS down");
        return inner.capture(s, args);
      },
      import: inner.import,
    };

    const res = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      replayers,
    });
    expect(res).toMatchObject({
      ok: true,
      status: "partial",
      counts: { failed: 1, proposed: 1 },
      items: [
        { sourceDocumentIds: [a], outcome: "failed", reason: "IS down" },
        { sourceDocumentIds: [b], outcome: "proposed" },
      ],
    });
  });

  it("a double-click reuses ONE child (reused:true, nothing replayed twice); another mode is a separate child", async () => {
    const text = await source({ kind: "text", body: "Call Bob" });
    const parent = await parentSession({ sourceDocumentIds: [text] });
    const { calls, replayers } = recordingReplayers();
    const now = new Date("2026-09-13T10:00:05Z");
    const base = {
      sessionId: parent,
      userId: USER,
      replayers,
      revert: okRevert() as unknown as typeof revertSession,
      now,
    };

    const first = await run({ ...base, mode: "add" });
    const second = await run({
      ...base,
      mode: "add",
      now: new Date("2026-09-13T10:00:40Z"),
    });

    expect(first).toMatchObject({ ok: true, status: "rerun", reused: false });
    expect(second).toMatchObject({ ok: true, status: "reused", reused: true });
    expect((second as { sessionId: string }).sessionId).toBe(
      (first as { sessionId: string }).sessionId
    );
    expect(h.opened).toHaveLength(1);
    expect(calls).toHaveLength(1);

    const replace = await run({ ...base, mode: "replace" });
    expect(replace).toMatchObject({ ok: true, reused: false });
    expect((replace as { sessionId: string }).sessionId).not.toBe(
      (first as { sessionId: string }).sessionId
    );
    expect(h.opened).toHaveLength(2);
  });

  it("W2 scope is part of the dedupe key: 'only the degraded' right after a full rerun is its OWN child; the same scope in any order reuses", async () => {
    const good = await source({ kind: "text", body: "Call Bob" });
    const bad = await source({
      kind: "text",
      body: "Email Ann",
      degraded: true,
    });
    const other = await source({ kind: "text", body: "Book flight" });
    const parent = await parentSession({
      sourceDocumentIds: [good, bad, other],
    });
    const { calls, replayers } = recordingReplayers();
    const base = {
      sessionId: parent,
      userId: USER,
      mode: "add" as const,
      replayers,
      now: new Date("2026-09-13T10:00:05Z"),
    };

    const full = await run(base);
    const degradedOnly = await run({
      ...base,
      scope: { sourceDocumentIds: [bad] },
    });
    expect(full).toMatchObject({ ok: true, status: "rerun", reused: false });
    expect(degradedOnly).toMatchObject({ ok: true, reused: false });
    expect((degradedOnly as { sessionId: string }).sessionId).not.toBe(
      (full as { sessionId: string }).sessionId
    );
    // The scoped child replayed ONLY the selected source.
    expect(calls.slice(3).map((c) => c.payload)).toEqual([
      { text: "Email Ann" },
    ]);

    const pair = await run({
      ...base,
      scope: { sourceDocumentIds: [other, good] },
    });
    const pairAgain = await run({
      ...base,
      scope: { sourceDocumentIds: [good, other] },
    });
    expect(pairAgain).toMatchObject({ ok: true, status: "reused" });
    expect((pairAgain as { sessionId: string }).sessionId).toBe(
      (pair as { sessionId: string }).sessionId
    );
    expect(h.opened).toHaveLength(3);
  });

  it("W2 listRunSources lists the rows the plan counts: degraded marked, a deleted source missing, another user's session null", async () => {
    const good = await source({ kind: "text", body: "Call Bob", path: "a" });
    const bad = await source({
      kind: "url",
      body: "<p>x</p>",
      url: "https://x.test",
      path: "b",
      degraded: true,
    });
    const gone = await source({ kind: "text", body: "Old", path: "c" });
    await q(`update documents set deleted_at = now() where id = $1`, [gone]);
    const parent = await parentSession({
      sourceDocumentIds: [good, bad, gone],
      status: "active",
    });

    const listed = await listRunSources({
      sessionId: parent,
      userId: USER,
      database: db,
    });
    expect(listed).toMatchObject({
      sessionId: parent,
      total: 3,
      missing: [gone],
      rerunCap: RERUN_MAX_SOURCES,
    });
    expect(
      listed!.sources.map((s) => [s.sourceDocumentId, s.kind, s.degraded])
    ).toEqual([
      [good, "text", null],
      [bad, "url", { reason: "is_invalid_response", at: "t" }],
    ]);
    const plan = await run({
      sessionId: parent,
      userId: USER,
      mode: "add",
      dryRun: true,
    });
    expect(plan).toMatchObject({
      plan: { sources: { degraded: 1, missing: [gone] } },
    });

    expect(
      await listRunSources({ sessionId: parent, userId: OTHER, database: db })
    ).toBeNull();
  });

  it("replace withdraws the parent's PENDING proposals through the withdraw door and lists refusals; add leaves them", async () => {
    const text = await source({ kind: "text", body: "Call Bob" });
    const parent = await parentSession({ sourceDocumentIds: [text] });
    await proposal(parent, "approved");
    await proposal(parent, "pending");
    await proposal(parent, "pending");
    const pendingIds = (
      await q<{ id: string }>(
        `select id from proposals where session_id = $1 and status = 'pending' order by id`,
        [parent]
      )
    ).rows.map((r) => r.id);
    const { replayers } = recordingReplayers();
    const withdrawPending = vi.fn(async (id: string) => {
      if (id === pendingIds[1])
        throw new Error("Only the proposer can withdraw this proposal.");
    });
    const base = {
      sessionId: parent,
      userId: USER,
      replayers,
      withdrawPending,
      revert: okRevert({ reverted: 1 }) as unknown as typeof revertSession,
    };

    const added = await run({ ...base, mode: "add" });
    expect(added).toMatchObject({ ok: true, status: "rerun" });
    expect((added as { revert?: unknown }).revert).toBeUndefined();
    expect(withdrawPending).not.toHaveBeenCalled();

    const replaced = await run({ ...base, mode: "replace" });
    expect(withdrawPending.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...pendingIds].sort()
    );
    expect(replaced).toMatchObject({
      ok: true,
      revert: {
        withdrawnPending: [pendingIds[0]],
        pendingNotWithdrawn: [
          {
            proposalId: pendingIds[1],
            reason: "Only the proposer can withdraw this proposal.",
          },
        ],
      },
    });
  });
});
