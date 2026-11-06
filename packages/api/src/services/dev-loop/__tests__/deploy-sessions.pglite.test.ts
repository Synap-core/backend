/**
 * sessionsInDeploy on PGlite (finding 8c08b138): which OPEN sessions of the
 * deploy's owner recorded a PR this build carries — the real SQL, the owner
 * floor, and the fold's own containment (`pullRequestsInDeploy`).
 *
 * Fixture rows are chosen where a naive answer disagrees with the right one:
 *   - a session whose PR merged AFTER the build's commit was made: "every
 *     merged PR" lists it;
 *   - a session whose PR is still open: "every session with a PR" lists it;
 *   - a CLOSED session whose PR the build carries: nothing can move it;
 *   - a session of the same PR NUMBER in another repo: "match the number"
 *     lists it;
 *   - another person's session pointing at the carried PR: no owner floor
 *     lists it.
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
import { sessionsInDeploy } from "../pr-session-resolver.js";

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

const OWNER = "owner-deploy";
const STRANGER = "stranger-deploy";
const WS = randomUUID();
const REPO = "Synap-core/backend";
const OTHER_REPO = "Synap-core/app-bases";
const MERGE_301 = "a2dd31c0d5f860ea52015459760c2a4061be5d7d";
const BUILD_SHA = "f".repeat(40);

const at = (min: number) =>
  new Date(Date.UTC(2026, 10, 6, 10, min)).toISOString();

async function event(type: string, min: number, data: Record<string, unknown>) {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id)
     values ($1, $2, $3, $4, 'pull_request', $5::jsonb, $6, $7)`,
    [randomUUID(), at(min), type, randomUUID(), JSON.stringify(data), OWNER, WS]
  );
}
const prData = (
  number: number,
  extra: Record<string, unknown> = {},
  repo = REPO
) => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  ...extra,
});

async function session(
  userId: string,
  status: string,
  prUrl: string
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, status, expected_outputs) values ($1, $2, $3, $4::jsonb)`,
    [
      id,
      userId,
      status,
      JSON.stringify([
        {
          key: "pr",
          kind: "pull_request",
          label: "the PR",
          status: "pending",
          ref: { url: prUrl },
        },
      ]),
    ]
  );
  return id;
}

const ids: Record<string, string> = {};

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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );

  // #301 merged at :05, its merge commit is the build's ancestor (builtAt :13).
  await event(T.prMerged, 5, prData(301, { sha: MERGE_301 }));
  // #305 merged at :10, before the build's commit (:13): carried.
  await event(T.prMerged, 10, prData(305, { sha: "d".repeat(40) }));
  // #302 merged at :20, after the build's commit: not carried.
  await event(T.prMerged, 20, prData(302, { sha: "1".repeat(40) }));
  // #303 opened only.
  await event(T.prOpened, 2, prData(303, { sha: "b".repeat(40) }));
  // #301 of ANOTHER repo, merged early: a build of backend never carries it.
  await event(T.prMerged, 1, prData(301, { sha: "e".repeat(40) }, OTHER_REPO));

  const url = (n: number, repo = REPO) =>
    `https://github.com/${repo}/pull/${n}`;
  ids.carried = await session(OWNER, "active", url(301));
  ids.carriedPaused = await session(OWNER, "paused", url(305));
  ids.closed = await session(OWNER, "closed", url(301));
  ids.mergedLater = await session(OWNER, "active", url(302));
  ids.open = await session(OWNER, "active", url(303));
  ids.otherRepo = await session(OWNER, "active", url(301, OTHER_REPO));
  ids.stranger = await session(STRANGER, "active", url(301));
});

const deploy = {
  target: "pod.example",
  sha: BUILD_SHA,
  repo: "synap-core/BACKEND",
  builtAt: at(13),
};

describe("sessionsInDeploy — the open sessions whose recorded PR this build carries", () => {
  it("names exactly the owner's open sessions with a carried PR, sorted", async () => {
    const got = await sessionsInDeploy({ userId: OWNER, data: deploy });
    expect(got).toEqual([ids.carried, ids.carriedPaused].sort());
  });

  it("a build naming the merge commit itself carries it even with no builtAt", async () => {
    const got = await sessionsInDeploy({
      userId: OWNER,
      data: { target: "pod.example", sha: MERGE_301 },
    });
    expect(got).toEqual([ids.carried]);
  });

  it("a build made before every merge carries nothing", async () => {
    const got = await sessionsInDeploy({
      userId: OWNER,
      data: { ...deploy, builtAt: at(0) },
    });
    expect(got).toEqual([]);
  });

  it("another person's deploy reaches only their own sessions", async () => {
    const got = await sessionsInDeploy({ userId: STRANGER, data: deploy });
    // The stranger recorded no PR facts: nothing they can see was merged.
    expect(got).toEqual([]);
  });
});
