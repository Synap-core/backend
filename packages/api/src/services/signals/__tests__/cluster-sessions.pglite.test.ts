/**
 * A CLUSTER'S SESSION IS NAMED ONLY THROUGH THE READ FLOOR — on PGlite, through
 * the REAL `readClusterSessions` (`sessionReadableWhere`) and the REAL union.
 * The viewer's own session: the cluster joins its block, titled and railed. A
 * session the viewer cannot read: absent from the map, so its cluster stays a
 * plain `proposal-cluster:` row — no session key, no title, nothing leaks.
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
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { readClusterSessions } from "../cluster-sessions.js";
import { unionNeedsYou } from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

const USER = "user-1";
const STRANGER = "user-2";
const MINE = randomUUID();
const THEIRS = randomUUID();
const PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "started_at" || c.name === "created_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

function cluster(fp: string, sessionId: string): ProposalCluster {
  return {
    fingerprint: fp,
    proposalType: "create",
    targetType: "entity",
    targetLabel: fp,
    class: "objectWork",
    lifetimeHours: null,
    count: 1,
    sampleProposalIds: [`p-${fp}`],
    sources: [],
    latestAt: new Date("2026-09-28T10:00:00.000Z"),
    workspaceIds: [],
    sessionId,
    reasonCounts: {},
    attentionFloorCount: 0,
  } as ProposalCluster;
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  await h.client!.query(
    `insert into focus_sessions (id, user_id, title, goal, project_id, status, origin, expected_outputs, agent_ids, metadata) values
      ($1, $3, 'Tracks-first', 'Move the project experience', $5, 'active', 'human', '[]'::jsonb, '{}', '{}'::jsonb),
      ($2, $4, 'Stranger secret plan', 'Private', null, 'active', 'human', '[]'::jsonb, '{}', '{}'::jsonb)`,
    [MINE, THEIRS, USER, STRANGER, PROJECT]
  );
}, 120_000);

describe("cluster sessions are named through the session read floor", () => {
  const clusters = [cluster("mine", MINE), cluster("theirs", THEIRS)];

  it("reads only the sessions the viewer may read", async () => {
    const map = await readClusterSessions(clusters, { userId: USER });
    expect([...map.keys()]).toEqual([MINE]);
    expect(map.get(MINE)).toEqual({
      title: "Tracks-first",
      projectId: PROJECT,
    });
  });

  it("the readable cluster joins its session; the unreadable one stays a plain row", async () => {
    const clusterSessions = await readClusterSessions(clusters, {
      userId: USER,
    });
    const signals = unionNeedsYou({
      clusters,
      clusterSessions,
      notifications: [],
      owedSlots: [],
      now: new Date("2026-09-28T12:00:00.000Z"),
    });
    const mine = signals.find((s) => s.id === "cluster:mine@p-mine")!;
    const theirs = signals.find((s) => s.id === "cluster:theirs@p-theirs")!;
    expect(mine.groupKey).toBe(`session:${MINE}`);
    expect(mine.sessionTitle).toBe("Tracks-first");
    expect(theirs.groupKey).toBe("proposal-cluster:theirs");
    expect(JSON.stringify(theirs)).not.toContain(THEIRS);
    expect(JSON.stringify(theirs)).not.toContain("Stranger secret plan");
  });
});
