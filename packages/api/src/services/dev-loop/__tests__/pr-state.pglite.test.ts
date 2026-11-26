/**
 * readPullRequestStates on PGlite: the REAL SQL (both queries, the reader's
 * event floor) against tables generated from the Drizzle definitions, then
 * the packet's work units (`withPullRequestStates`).
 *
 * Fixture rows are chosen where a naive read disagrees with the right one:
 *   - the same PR number in ANOTHER repo, merged: "match the number" reads it;
 *   - a merge of the PR recorded by ANOTHER person in a space the reader
 *     cannot see: "every event" reads it as merged;
 *   - a CI run that names no PR, only the PR's head sha: "match `pr`" misses it;
 *   - a deploy of a sha that is not the merge commit: "any deploy after the
 *     merge" calls it deployed;
 *   - a build of the PR's repo made from a LATER commit (`builtAt`), naming
 *     another sha: "match the merge sha" misses it; a build of another repo
 *     made later: "any later build" calls it deployed.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const db = drizzle(client);
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { DEV_LOOP_EVENT_TYPES as T } from "@synap-core/types";
import { db } from "@synap/database";
import {
  FOLLOW_UP_LEAD_MS,
  pullRequestKey,
  readPullRequestStates,
} from "../pr-state.js";
import {
  withPullRequestStates,
  type PacketWorkUnitItem,
} from "../../focus-sessions/continuation-packet.js";

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

const OWNER = "owner-pr";
const STRANGER = "stranger-pr";
const WS = randomUUID();
const WS_HIDDEN = randomUUID();
const REPO = "Synap-core/backend";
const HEAD = "d7e01700a5f860ea52015459760c2a4061be5d7d";
const MERGE = "a2dd31c0d5f860ea52015459760c2a4061be5d7d";
const reader = { userId: OWNER, roster: true };

const at = (min: number) =>
  new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();

async function event(
  type: string,
  min: number,
  data: Record<string, unknown>,
  over: { userId?: string; workspaceId?: string } = {}
) {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id)
     values ($1, $2, $3, $4, 'pull_request', $5::jsonb, $6, $7)`,
    [
      randomUUID(),
      at(min),
      type,
      randomUUID(),
      JSON.stringify(data),
      over.userId ?? OWNER,
      over.workspaceId ?? WS,
    ]
  );
}
const prData = (number: number, extra: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  ...extra,
});

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, user_type, name) values ($1,'human','Owner'),($2,'human','Stranger')`,
    [OWNER, STRANGER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb),($3,'H',$4,'{}'::jsonb)`,
    [WS, OWNER, WS_HIDDEN, STRANGER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS, OWNER, randomUUID(), WS_HIDDEN, STRANGER]
  );

  // #285: opened, CI on its head sha (one run names no PR), merged, deployed.
  await event(T.prOpened, 1, prData(285, { sha: HEAD }));
  await event(T.ciFinished, 2, {
    repo: REPO,
    sha: HEAD,
    pr: 285,
    status: "success",
    workflow: "CI",
  });
  await event(T.ciFinished, 3, {
    repo: REPO,
    sha: HEAD.slice(0, 7),
    status: "failure",
    workflow: "Reference docs",
  });
  await event(T.prMerged, 5, prData(285, { sha: MERGE, intoDefault: true }));
  await event(T.deployed, 6, { target: "pod.example", sha: MERGE });
  // #286: opened only; a deploy of an unrelated build.
  await event(T.prOpened, 1, prData(286, { sha: "b".repeat(40) }));
  await event(T.deployed, 7, { target: "pod.example", sha: "c".repeat(40) });
  // #287: merged, then a build of ANOTHER repo made later (says nothing),
  // then a build of this repo from a later commit, naming another sha.
  await event(T.prMerged, 10, prData(287, { sha: "d".repeat(40) }));
  await event(T.deployed, 12, {
    target: "app.example",
    sha: "e".repeat(40),
    repo: "Synap-core/app-bases",
    builtAt: at(11),
  });
  await event(T.deployed, 14, {
    target: "pod.example",
    sha: "f".repeat(40),
    repo: "synap-core/backend",
    builtAt: at(13),
  });
  // #288: merged after the newest build's commit was made: not deployed.
  await event(T.prMerged, 20, prData(288, { sha: "1".repeat(40) }));
  // #286 in ANOTHER repo, merged: never this PR.
  await event(T.prMerged, 4, {
    ...prData(286),
    repo: "Synap-core/app-bases",
    url: "https://github.com/Synap-core/app-bases/pull/286",
  });
  // #286 merged, recorded by someone else in a space the reader cannot see.
  await event(T.prMerged, 8, prData(286), {
    userId: STRANGER,
    workspaceId: WS_HIDDEN,
  });
});

describe("readPullRequestStates — the recorded dev facts, under the reader's floor", () => {
  it("folds each PR from its own facts: state, checks on the head sha, deployed on the merge sha", async () => {
    const states = await readPullRequestStates(
      [
        { repo: REPO, number: 285 },
        { repo: "synap-core/BACKEND", number: 286 },
      ],
      reader
    );
    expect(states.get(pullRequestKey({ repo: REPO, number: 285 }))).toEqual({
      state: "merged",
      // The sha-only run is the PR's (its head), and it failed.
      checks: "failed",
      checksOn: HEAD.slice(0, 7),
      intoDefault: true,
      deployed: true,
      at: at(5),
    });
    // Not merged: the other repo's merge and the hidden one are not read;
    // the unrelated deploy says nothing.
    expect(states.get(pullRequestKey({ repo: REPO, number: 286 }))).toEqual({
      state: "open",
      at: at(1),
    });
  });

  it("deployed when a build of the PR's repo came from a commit made after the merge (builtAt), not from another repo's", async () => {
    const states = await readPullRequestStates(
      [
        { repo: REPO, number: 287 },
        { repo: REPO, number: 288 },
      ],
      reader
    );
    expect(states.get(pullRequestKey({ repo: REPO, number: 287 }))).toEqual({
      state: "merged",
      deployed: true,
      at: at(10),
    });
    expect(states.get(pullRequestKey({ repo: REPO, number: 288 }))).toEqual({
      state: "merged",
      at: at(20),
    });
  });

  it("a PR with no recorded fact is ABSENT, never guessed", async () => {
    const states = await readPullRequestStates(
      [{ repo: REPO, number: 999 }],
      reader
    );
    expect(states.size).toBe(0);
  });

  it("another reader sees only their own facts", async () => {
    const states = await readPullRequestStates([{ repo: REPO, number: 286 }], {
      userId: STRANGER,
      roster: true,
    });
    expect(states.get(pullRequestKey({ repo: REPO, number: 286 }))).toEqual({
      state: "merged",
      at: at(8),
    });
  });
});

describe("readPullRequestStates — the load it puts on the events hypertable", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const OPENED = Date.UTC(2026, 10, 20, 12, 0);
  const BRANCH_HEAD = "9".repeat(40);
  async function eventAt(
    type: string,
    when: number,
    data: Record<string, unknown>
  ) {
    await q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id)
       values ($1, $2, $3, $4, 'pull_request', $5::jsonb, $6, $7)`,
      [
        randomUUID(),
        new Date(when).toISOString(),
        type,
        randomUUID(),
        JSON.stringify(data),
        OWNER,
        WS,
      ]
    );
  }

  it("reads CI runs from FOLLOW_UP_LEAD_MS before the PR's first fact: a branch run 6 days before counts, one 8 days before is never read", async () => {
    await eventAt(T.prOpened, OPENED, prData(290, { sha: BRANCH_HEAD }));
    // The branch's own CI on the head sha, before the PR was opened.
    await eventAt(T.ciFinished, OPENED - 6 * DAY, {
      repo: REPO,
      sha: BRANCH_HEAD,
      status: "success",
      workflow: "Branch CI",
    });
    // Older than the bound: an unbounded read would fold its failure in.
    await eventAt(T.ciFinished, OPENED - 8 * DAY, {
      repo: REPO,
      sha: BRANCH_HEAD,
      status: "failure",
      workflow: "Stale CI",
    });
    const states = await readPullRequestStates(
      [{ repo: REPO, number: 290 }],
      reader
    );
    expect(states.get(pullRequestKey({ repo: REPO, number: 290 }))).toEqual({
      state: "open",
      checks: "passed",
      checksOn: BRANCH_HEAD,
      at: new Date(OPENED).toISOString(),
    });
    // The fixture's 6 and 8 days straddle the bound.
    expect(FOLLOW_UP_LEAD_MS).toBe(7 * DAY);
  });

  it("identical reads in flight at once share ONE pair of queries; a later read queries again", async () => {
    let selects = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            selects += 1;
            return Reflect.apply(target.select, target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const [a, b] = await Promise.all([
      readPullRequestStates(
        [
          { repo: REPO, number: 285 },
          { repo: REPO, number: 286 },
        ],
        reader,
        counted
      ),
      // The same PRs, asked in another order and case.
      readPullRequestStates(
        [
          { repo: "synap-core/BACKEND", number: 286 },
          { repo: REPO, number: 285 },
        ],
        reader,
        counted
      ),
    ]);
    // One PR-facts query and one follow-up query, not two of each.
    expect(selects).toBe(2);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(a.get(pullRequestKey({ repo: REPO, number: 285 }))?.state).toBe(
      "merged"
    );

    // A different reader floor is a different read.
    await Promise.all([
      readPullRequestStates([{ repo: REPO, number: 286 }], reader, counted),
      readPullRequestStates(
        [{ repo: REPO, number: 286 }],
        { userId: STRANGER, roster: true },
        counted
      ),
    ]);
    expect(selects).toBe(6);

    // Nothing is kept once a read settles.
    await readPullRequestStates(
      [
        { repo: REPO, number: 285 },
        { repo: REPO, number: 286 },
      ],
      reader,
      counted
    );
    expect(selects).toBe(8);
  });
});

describe("withPullRequestStates — the packet's PR work units", () => {
  const unit = (
    url: string | null,
    kind = "pull_request"
  ): PacketWorkUnitItem => ({
    key: null,
    label: url ?? "a branch",
    kind,
    noun: "Pull request",
    glyph: "⑂",
    url,
    state: "open",
  });
  const units = () => ({
    status: "ok" as const,
    total: 3,
    items: [
      unit(`https://github.com/${REPO}/pull/285`),
      unit(`https://github.com/${REPO}/pull/999`),
      unit(`https://github.com/${REPO}/tree/feat/x`, "branch"),
    ],
  });

  it("a PR with facts carries prState with its word; one without, and a branch, carry none", async () => {
    const out = await withPullRequestStates(units(), reader);
    if (out.status !== "ok") throw new Error("section unavailable");
    expect(out.items[0]!.prState).toEqual({
      status: "ok",
      label: "Merged",
      state: "merged",
      checks: "failed",
      checksOn: HEAD.slice(0, 7),
      intoDefault: true,
      deployed: true,
      at: at(5),
    });
    expect(out.items[1]).not.toHaveProperty("prState");
    expect(out.items[2]).not.toHaveProperty("prState");
  });

  it("a FAILED read is 'unavailable' on each PR unit, never absent — and the units stay listed", async () => {
    await h.client!.exec(`alter table events rename to events_away;`);
    try {
      const out = await withPullRequestStates(units(), reader);
      if (out.status !== "ok") throw new Error("section unavailable");
      expect(out.items).toHaveLength(3);
      expect(out.items[0]!.prState).toMatchObject({ status: "unavailable" });
      expect(out.items[1]!.prState).toMatchObject({ status: "unavailable" });
      // Not a PR: nothing was read for it, so nothing failed for it.
      expect(out.items[2]).not.toHaveProperty("prState");
    } finally {
      await h.client!.exec(`alter table events_away rename to events;`);
    }
  });
});
