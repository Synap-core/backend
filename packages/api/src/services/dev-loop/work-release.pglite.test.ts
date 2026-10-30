/**
 * The release read on PGlite — the REAL `readWorkRelease`: the snapshot read
 * under the event floor, the session read under the session floor, the real
 * liveness read, then the fold. Every table is generated from the Drizzle
 * definitions, so no hand-kept list of "the tables this read touches" can
 * fall behind it.
 *
 * Fixture rows sit where the candidate rules DISAGREE:
 *   - two snapshots of one repo — "the first row" or "any row" reads the
 *     older one;
 *   - another person's PERSONAL snapshot — a read without the event floor
 *     shows a repo this reader cannot see;
 *   - a snapshot 8 days old — outside the lookback, so its repo is gone;
 *   - a session joined ONLY through its outcome's `ref.url` (no body line) —
 *     a read that only follows `podSessionId` leaves the PR unheld;
 *   - a session named by a body line with no title — the title is the goal's
 *     first line, never null;
 *   - another person's session named by a body line — readable by nobody
 *     here, so its title stays unknown;
 *   - session activity 2 min ago vs 40 min ago — `holder.live` true vs false.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { RepoSnapshotFact } from "@synap-core/types/work-release";
import { readWorkRelease } from "./work-release.js";

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-ship";
const OTHER = "user-other";
const AGENT = "agent-claude-code";
const BE = "Synap-core/backend";
const BR = "Synap-core/browser";
const S = {
  byOutcome: randomUUID(), // declares backend#363 as an outcome; agent on it
  byBody: randomUUID(), // named by #278's body; no title; quiet
  others: randomUUID(), // OTHER's session, named by browser#60's body
};
const NOW = new Date();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const SHA = (n: number) => n.toString(16).padStart(40, "a");

function pr(repo: string, number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headSha: SHA(number),
    draft: false,
    author: "Antoinesrvt",
    updatedAt: ago(20).toISOString(),
    mergeable: "blocked",
    checks: "red",
    redInheritedFromMain: true,
    autoMerge: true,
    ...over,
  };
}

function snapshot(
  repo: string,
  observedMinAgo: number,
  prs: unknown[],
  over: Record<string, unknown> = {}
): RepoSnapshotFact {
  return {
    repo,
    observedAt: ago(observedMinAgo).toISOString(),
    visibility: "public",
    main: {
      sha: SHA(1),
      health: "red",
      source: "github-checks",
      reason: "typecheck",
    },
    prs,
    mergedToday: [],
    ...over,
  } as RepoSnapshotFact;
}

async function fact(user: string, minAgo: number, data: unknown) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
     values ($1, 'dev.repo_snapshot', $2, $3, 'observation', $4::jsonb, $5)`,
    [randomUUID(), user, randomUUID(), JSON.stringify(data), ago(minAgo)]
  );
}

/** A dev-loop fact (`dev.pr_*`, `ci.finished`) recorded by the reader. */
async function devFact(type: string, minAgo: number, data: unknown) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
     values ($1, $2, $3, $4, 'observation', $5::jsonb, $6)`,
    [randomUUID(), type, USER, randomUUID(), JSON.stringify(data), ago(minAgo)]
  );
}

async function session(
  id: string,
  user: string,
  opts: { title?: string; goal: string; agentIds?: string[]; outputs?: unknown }
) {
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'active', $5::jsonb, $6::text[], '{}'::jsonb, now() - interval '3 hours', now(), now())`,
    [
      id,
      user,
      opts.title ?? null,
      opts.goal,
      JSON.stringify(opts.outputs ?? []),
      `{${(opts.agentIds ?? []).join(",")}}`,
    ]
  );
}

/** Session activity: a governed write recorded inside the session. */
async function activity(sessionId: string, user: string, minAgo: number) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, session_id, data, timestamp)
     values ($1, 'entity.create.completed', $2, $3, 'entity', $4, '{}'::jsonb, $5)`,
    [randomUUID(), user, randomUUID(), sessionId, ago(minAgo)]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  // Non-vacuity: the schema walk saw the tables this read joins.
  const names = tables.map((t) => getTableConfig(t).name);
  expect(names).toEqual(
    expect.arrayContaining(["events", "focus_sessions", "users", "proposals"])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Antoine', 'human'), ($3, $4, 'Claude Code', 'agent')`,
    [USER, `${USER}@test`, AGENT, `${AGENT}@test`]
  );

  await session(S.byOutcome, USER, {
    title: "Fix main",
    goal: "g",
    agentIds: [AGENT],
    outputs: [
      {
        key: "pr-backend-363",
        kind: "pull_request",
        label: "backend#363",
        ref: { url: `https://github.com/${BE}/pull/363` },
      },
    ],
  });
  await session(S.byBody, USER, { goal: "Types for browser\nand more" });
  await session(S.others, OTHER, { title: "Not yours", goal: "g" });
  await activity(S.byOutcome, USER, 2);
  await activity(S.byBody, USER, 40);

  // backend: an OLDER snapshot that must lose, then the newest.
  await fact(USER, 30, snapshot(BE, 30, [pr(BE, 999, { checks: "green" })]));
  await fact(
    USER,
    1,
    snapshot(
      BE,
      1,
      [
        pr(BE, 363, { checks: "queued", redInheritedFromMain: false }),
        pr(BE, 278, { podSessionId: S.byBody }),
      ],
      {
        main: {
          sha: SHA(1),
          health: "red",
          source: "github-checks",
          reason: "typecheck: proposalType on review rows",
          fixedBy: { repo: BE, number: 363 },
        },
      }
    )
  );
  await fact(
    USER,
    3,
    snapshot(BR, 3, [pr(BR, 60, { podSessionId: S.others })], {
      main: {
        sha: SHA(2),
        health: "red",
        source: "devbox-baseline",
        fixedBy: { repo: BE, number: 278 },
      },
      visibility: "private",
    })
  );
  // OTHER's personal snapshot of a repo; and a repo last seen 8 days ago.
  await fact(
    OTHER,
    2,
    snapshot("Synap-core/secret", 2, [pr("Synap-core/secret", 1)])
  );
  await fact(USER, 8 * 24 * 60, snapshot("Synap-core/old", 8 * 24 * 60, []));
});

const read = () => readWorkRelease({ userId: USER, roster: false, now: NOW });

describe("readWorkRelease on PGlite", () => {
  it("reads the newest snapshot per visible repo, inside the lookback", async () => {
    const r = await read();
    expect(r.repos.map((x) => x.repo)).toEqual([BE, BR]);
    expect(r.prs.map((p) => p.number).sort()).toEqual([278, 363, 60].sort());
    expect(r.sources).toEqual({
      snapshots: "ok",
      sessions: "ok",
      holders: "ok",
      pullRequests: "ok",
    });
  });

  it("joins a session through its outcome ref, with its agent and liveness", async () => {
    const r = await read();
    const p363 = r.prs.find((p) => p.number === 363)!;
    expect(p363.sessionId).toBe(S.byOutcome);
    expect(p363.sessionTitle).toBe("Fix main");
    expect(p363.holder).toMatchObject({ live: true, label: "Claude Code" });
  });

  it("joins a body-named session: goal's first line, owner's name, quiet", async () => {
    const r = await read();
    const p278 = r.prs.find((p) => p.number === 278)!;
    expect(p278.sessionId).toBe(S.byBody);
    expect(p278.sessionTitle).toBe("Types for browser");
    expect(p278.holder).toMatchObject({ live: false, label: "Antoine" });
    expect(p278.holder?.lastActiveAt).toBe(ago(40).toISOString());
  });

  it("never reads another person's session: its title stays unknown", async () => {
    const r = await read();
    const p60 = r.prs.find((p) => p.number === 60)!;
    expect(p60.sessionTitle).toBeNull();
    expect(p60.holder).toBeNull();
  });

  it("ranks #363 first: backend main, #278, browser main and its PR wait on it", async () => {
    const r = await read();
    expect(r.blockers[0]).toMatchObject({
      ref: { kind: "pr", repo: BE, number: 363 },
      waitingPrs: 2,
      waitingMains: 2,
    });
  });

  it("one PR fact model: a recorded pass on the head settles queued checks; a recorded merge takes the PR off the open list", async () => {
    const url = `https://github.com/${BE}/pull/363`;
    await devFact("dev.pr_opened", 10, {
      repo: BE,
      number: 363,
      url,
      sha: SHA(363),
    });
    await devFact("ci.finished", 0.5, {
      repo: BE,
      sha: SHA(363),
      pr: 363,
      status: "success",
      workflow: "CI",
    });
    let p363 = (await read()).prs.find((p) => p.number === 363)!;
    // The snapshot (1 min old) still says queued; the fact is newer.
    expect(p363).toMatchObject({ verdict: "green", stage: "checks" });

    await devFact("dev.pr_merged", 0.2, {
      repo: BE,
      number: 363,
      url,
      sha: SHA(3630),
      intoDefault: true,
    });
    const r = await read();
    p363 = r.prs.find((p) => p.number === 363)!;
    expect(p363).toMatchObject({
      stage: "on_main",
      mergedAt: ago(0.2).toISOString(),
      blockedBy: [],
    });
    // Merged, it fixes backend main no more as an OPEN blocker.
    expect(r.blockers.map((b) => b.ref)).not.toContainEqual({
      kind: "pr",
      repo: BE,
      number: 363,
    });
  });

  it("another person reads only their own snapshot", async () => {
    const r = await readWorkRelease({ userId: OTHER, roster: false, now: NOW });
    expect(r.repos.map((x) => x.repo)).toEqual(["Synap-core/secret"]);
  });
});
