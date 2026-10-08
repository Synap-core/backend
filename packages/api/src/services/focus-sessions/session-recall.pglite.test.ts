/**
 * Session recall on PGlite — the REAL reads and the REAL metadata writes of
 * `runSessionRecall`, with the two effects that leave the pod (retrieval +
 * embedding similarity, the room post) injected.
 *
 * The fixture is the founder's own example (2026-10-08): two captured `track`
 * notes saying they would match well together; later a session "DJ set
 * tonight" starts and must recall them. Rows are chosen where naive rules
 * DISAGREE:
 *   - an unrelated capture the retrieval door still returns (its graph leg
 *     pulls neighbours with no evidence) — "keep what retrieve returns" keeps
 *     it; the relevance floor drops it;
 *   - the session's SUBJECT, which retrieval ranks first — must be excluded;
 *   - a note ALREADY linked to the session — "recall is for what the session
 *     does not already have";
 *   - a re-run that finds the same set — must REPLACE, never append, and its
 *     room post must carry the SAME idempotency key;
 *   - a failed retrieval after a good run — must be distinguishable from an
 *     empty one AND must not erase what the earlier run found.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  registered: null as null | ((d: { sessionId: string }) => Promise<unknown>),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

// The jobs-side IoC slot is filled at boot by apps/api (guarded by the
// jobs-ioc-slots-are-filled-at-boot tripwire); stubbed here so nothing real loads.
vi.mock("@synap/jobs/workers/session-recall-worker.js", () => ({
  SESSION_RECALL_QUEUE: "session-recall",
  registerSessionRecallRunner: (fn: typeof h.registered) => {
    h.registered = fn;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, playbooks, entities, links } from "@synap/database";
import {
  runSessionRecall,
  buildRecallQuery,
  RECALL_MIN_SCORE,
  type RecallDeps,
} from "./session-recall.js";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-dj";
const WS = randomUUID();
const SESSION = randomUUID();
const PLAYBOOK = randomUUID();
const SUBJECT = randomUUID(); // the gig the session is about
const TRACK_A = randomUUID();
const TRACK_B = randomUUID();
const TAXES = randomUUID(); // unrelated — returned by retrieval, no evidence
const LINKED = randomUUID(); // already an input of the session
const CHANNEL = randomUUID();

const pool = [
  {
    id: SUBJECT,
    title: "Friday gig at Le Bar",
    type: "event",
    workspaceId: WS,
    text: "Friday gig at Le Bar",
  },
  {
    id: TRACK_A,
    title: "Midnight City",
    type: "track",
    workspaceId: null,
    text: "Midnight City — could match well with Strobe",
  },
  {
    id: LINKED,
    title: "Setlist draft",
    type: "note",
    workspaceId: WS,
    text: "Setlist draft",
  },
  {
    id: TRACK_B,
    title: "Strobe",
    type: "track",
    workspaceId: null,
    text: "Strobe — goes well after Midnight City",
  },
  {
    id: TAXES,
    title: "Tax return 2025",
    type: "note",
    workspaceId: null,
    text: "Tax return 2025",
  },
];
const similarity = new Map<string, number>([
  [TRACK_A, 0.52],
  [TRACK_B, 0.47],
  [TAXES, 0.08],
  [LINKED, 0.6],
  [SUBJECT, 0.7],
]);

function deps(over: Partial<RecallDeps> = {}) {
  const posts: Array<{
    channelId: string;
    content: string;
    idempotencyKey: string;
  }> = [];
  const asked: string[] = [];
  const d: Partial<RecallDeps> = {
    retrieve: async ({ query }) => {
      asked.push(query);
      return pool;
    },
    similarity: async (_q, ids) =>
      new Map(
        ids.filter((i) => similarity.has(i)).map((i) => [i, similarity.get(i)!])
      ),
    post: async (p) => {
      posts.push(p);
      return { success: true };
    },
    now: () => new Date("2026-10-08T20:00:00Z"),
    ...over,
  };
  return { d, posts, asked };
}

async function meta(): Promise<Record<string, unknown>> {
  const { rows } = await q(
    `select metadata from focus_sessions where id = $1`,
    [SESSION]
  );
  const m = (rows[0] as { metadata: unknown }).metadata;
  return (typeof m === "string" ? JSON.parse(m) : m) as Record<string, unknown>;
}

beforeAll(async () => {
  for (const t of [focusSessions, playbooks, entities, links]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(`insert into playbooks (id, name) values ($1, 'DJ set prep')`, [
    PLAYBOOK,
  ]);
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1, $2, $3, 'event', 'Friday gig at Le Bar')`,
    [SUBJECT, USER, WS]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, playbook_id, subject_entity_id, channel_id, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, 'DJ set tonight', 'active', $4, $5, $6, '{"titleSource":"derived"}'::jsonb, now(), now(), now())`,
    [SESSION, USER, WS, PLAYBOOK, SUBJECT, CHANNEL]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'targets', '{}'::jsonb, now())`,
    [randomUUID(), SESSION, LINKED]
  );
});

describe("runSessionRecall — the DJ example", () => {
  beforeEach(async () => {
    await q(
      `update focus_sessions set metadata = '{"titleSource":"derived"}'::jsonb where id = $1`,
      [SESSION]
    );
  });

  it("recalls the two tracks — not the subject, not the linked note, not the unrelated capture", async () => {
    const { d, posts, asked } = deps();
    const out = await runSessionRecall({ sessionId: SESSION }, d);
    expect(out.status).toBe("ok");
    // The query carries the goal, the playbook's name and the subject.
    expect(asked[0]).toContain("DJ set tonight");
    expect(asked[0]).toContain("DJ set prep");
    expect(asked[0]).toContain("Friday gig at Le Bar");

    const m = await meta();
    const recalled = m.recalled as Array<Record<string, unknown>>;
    expect(recalled.map((r) => r.entityId)).toEqual([TRACK_A, TRACK_B]);
    expect(recalled[0]).toMatchObject({
      title: "Midnight City",
      kind: "track",
      score: 0.52,
      recalledAt: "2026-10-08T20:00:00.000Z",
    });
    expect(typeof recalled[0]!.reason).toBe("string");
    expect(m.recalledAt).toBe("2026-10-08T20:00:00.000Z");
    expect(m.recallError).toBeUndefined();
    // Other metadata survives the merge.
    expect(m.titleSource).toBe("derived");

    // ONE message in the session's room, naming both.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(CHANNEL);
    expect(posts[0]!.content).toContain("Midnight City");
    expect(posts[0]!.content).toContain("Strobe");
    expect(posts[0]!.content).not.toContain("Tax return");
  });

  it("is idempotent: a re-run REPLACES the list and re-posts under the SAME key", async () => {
    const first = deps();
    await runSessionRecall({ sessionId: SESSION }, first.d);
    const second = deps();
    await runSessionRecall({ sessionId: SESSION, trigger: "manual" }, second.d);
    const m = await meta();
    expect((m.recalled as unknown[]).length).toBe(2);
    expect(m.recallTrigger).toBe("manual");
    expect(second.posts[0]!.idempotencyKey).toBe(
      first.posts[0]!.idempotencyKey
    );
  });

  it("an EMPTY recall writes the marker and an empty list, and posts NOTHING", async () => {
    const { d, posts } = deps({
      similarity: async () => new Map([[TRACK_A, RECALL_MIN_SCORE - 0.01]]),
      retrieve: async () =>
        pool.filter((p) => p.id === TRACK_A || p.id === TAXES),
    });
    const out = await runSessionRecall({ sessionId: SESSION }, d);
    expect(out.status).toBe("empty");
    const m = await meta();
    expect(m.recalled).toEqual([]);
    expect(m.recalledAt).toBe("2026-10-08T20:00:00.000Z");
    expect(m.recallError).toBeUndefined();
    expect(posts).toHaveLength(0);
  });

  it("a FAILED recall never throws, is distinguishable from empty, and keeps the earlier list", async () => {
    await runSessionRecall({ sessionId: SESSION }, deps().d);
    const { d, posts } = deps({
      retrieve: async () => {
        throw new Error("typesense unreachable");
      },
    });
    const out = await runSessionRecall({ sessionId: SESSION }, d);
    expect(out.status).toBe("failed");
    const m = await meta();
    expect(m.recallError).toMatchObject({ message: "typesense unreachable" });
    expect(m.recallAttempts).toBe(1);
    expect((m.recalled as unknown[]).length).toBe(2);
    expect(posts).toHaveLength(0);
    // A later good run clears the failure.
    await runSessionRecall({ sessionId: SESSION }, deps().d);
    const after = await meta();
    expect(after.recallError).toBeUndefined();
    expect(after.recallAttempts).toBeUndefined();
  });

  it("skips a session that does not exist", async () => {
    const out = await runSessionRecall({ sessionId: randomUUID() }, deps().d);
    expect(out).toEqual({ status: "skipped", reason: "not_found" });
  });
});

describe("buildRecallQuery", () => {
  it("joins title, goal, playbook and subject once each", () => {
    expect(
      buildRecallQuery({
        title: "DJ set tonight",
        goal: "DJ set tonight",
        playbookName: "DJ set prep",
        subject: { title: "Friday gig", kind: "event" },
      })
    ).toBe("DJ set tonight. DJ set prep. Friday gig (event)");
  });
});

describe("recallSessionAgain — owner floor", () => {
  it("re-runs for the owner and reads a foreign caller as not_found", async () => {
    const { recallSessionAgain } = await import("./session-recall.js");
    const mine = await recallSessionAgain(
      { sessionId: SESSION, userId: USER },
      deps().d
    );
    expect(mine.status).toBe("ok");
    expect((await meta()).recallTrigger).toBe("manual");
    const theirs = await recallSessionAgain(
      { sessionId: SESSION, userId: "someone-else" },
      deps().d
    );
    expect(theirs).toEqual({ status: "skipped", reason: "not_found" });
  });
});

describe("projectSessionRecall — the agent's view never folds a failure into empty", () => {
  it("reads pending / ok / empty / failed from the stored metadata", async () => {
    const { projectSessionRecall } = await import("./session-recall.js");
    expect(projectSessionRecall({})).toEqual({ status: "pending" });
    expect(projectSessionRecall({ recalledAt: "t", recalled: [] })).toEqual({
      status: "empty",
      recalledAt: "t",
    });
    const item = {
      entityId: "e",
      title: "x",
      kind: "track",
      score: 0.5,
      reason: "r",
      recalledAt: "t",
    };
    expect(projectSessionRecall({ recalledAt: "t", recalled: [item] })).toEqual(
      {
        status: "ok",
        recalled: [item],
        recalledAt: "t",
      }
    );
    expect(
      projectSessionRecall({
        recalledAt: "t",
        recalled: [item],
        recallError: { message: "down" },
      })
    ).toEqual({
      status: "failed",
      error: "down",
      recalledAt: "t",
      recalled: [item],
    });
  });
});
