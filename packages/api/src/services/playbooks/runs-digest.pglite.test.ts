/**
 * The runs digest through the MCP door, against real SQL (PGlite, every
 * table): `synap_list_playbooks({ playbookId, runs: 'digest' })` reads the
 * playbook's run sessions on the session floor, grades the ended ones with
 * their evaluation rows, and projects the digest. Reachability: the VALUES
 * arrive through the door (counts, median, stall, verdict), not only the keys.
 *
 * Rows rule out:
 *  - another person's run counted (the owner floor);
 *  - another playbook's run counted (the flow filter);
 *  - a verdict read off the session row instead of its evaluation rows;
 *  - a key that does not read sessions served a digest (or a digest of zero
 *    runs) instead of `runsDigestWithheld`;
 *  - a failed read folded into a digest of zero runs.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  grant: undefined as unknown,
  playbookId: "" as string,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    getRequestGrant: () => h.grant,
  };
});
// The playbook's visibility is the get door's (tested with it); here it
// answers the one playbook the runs belong to.
vi.mock(
  "../../routers/hub-protocol/playbook-doors.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getPlaybookDoor: async (_i: unknown, id: string) => ({
      kind: "result",
      result: {
        id,
        name: "Ship a change",
        stages: [{ key: "shape" }, { key: "build" }, { key: "review" }],
      },
    }),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { buildHandlers } from "../../routers/mcp/handlers/build.js";
import type { McpToolContext } from "../../routers/mcp/handlers/shared.js";
import { runsDigestReadableByGrant } from "../../access/grant-door-fence.js";
import { RUNS_DIGEST_STALL_DAYS } from "./runs-digest.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

const ME = "user-1";
const NOW = Date.now();
const H = 60 * 60 * 1000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const CRITERIA = [
  { key: "works", statement: "It works", check: { kind: "human" } },
];

async function session(o: {
  userId?: string;
  playbookId?: string;
  status: string;
  stage: string | null;
  history?: Array<[string | null, string, number]>;
  startedAt: number;
  closedAt?: number;
  criteria?: unknown[];
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, playbook_id, current_stage, stage_history,
       started_at, closed_at, updated_at, created_at, criteria, metadata)
     values ($1,$2,'g',$3,$4,$5,$6::jsonb,$7,$8,$9,$7,$10::jsonb,'{}'::jsonb)`,
    [
      id,
      o.userId ?? ME,
      o.status,
      o.playbookId ?? h.playbookId,
      o.stage,
      JSON.stringify(
        (o.history ?? []).map(([fromStage, stageKey, t]) => ({
          stageKey,
          fromStage,
          enteredAt: iso(t),
          actor: ME,
          userId: ME,
          via: "advance",
        }))
      ),
      iso(o.startedAt),
      o.closedAt ? iso(o.closedAt) : null,
      iso(o.closedAt ?? o.startedAt),
      JSON.stringify(o.criteria ?? []),
    ]
  );
  return id;
}

async function evaluation(sessionId: string, verdict: string) {
  await h.client!.query(
    `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, created_at)
     values ($1,$2,$3,'works',1,$4,'human',now())`,
    [randomUUID(), sessionId, ME, verdict]
  );
}

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_list_playbooks",
    args,
    userId: ME,
    apiKeyScopes: ["mcp.read"],
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

async function call(args: Record<string, unknown>) {
  const res = (await buildHandlers.synap_list_playbooks!(ctx(args))) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  const text = res.content[0]!.text;
  return { isError: res.isError === true, text, body: () => JSON.parse(text) };
}

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  h.playbookId = randomUUID();
  const t0 = NOW - 20 * D;
  // closed: shape 2h → build 4h → review 1h, graded pass
  const a = await session({
    status: "closed",
    stage: "review",
    history: [
      ["shape", "build", t0 + 2 * H],
      ["build", "review", t0 + 6 * H],
    ],
    startedAt: t0,
    closedAt: t0 + 7 * H,
    criteria: CRITERIA,
  });
  await evaluation(a, "pass");
  // cancelled in build: shape 4h → build 2h, graded fail
  const b = await session({
    status: "cancelled",
    stage: "build",
    history: [["shape", "build", t0 + 4 * H]],
    startedAt: t0,
    closedAt: t0 + 6 * H,
    criteria: CRITERIA,
  });
  await evaluation(b, "fail");
  // open, in build for 9 days: stalled
  await session({
    status: "active",
    stage: "build",
    history: [["shape", "build", NOW - 9 * D]],
    startedAt: NOW - 10 * D,
  });
  // open, in shape since 2 days: not stalled
  await session({ status: "active", stage: "shape", startedAt: NOW - 2 * D });
  // someone else's run, and my run of another playbook: never counted
  await session({
    userId: "user-2",
    status: "active",
    stage: "shape",
    startedAt: NOW - 30 * D,
  });
  await session({
    playbookId: randomUUID(),
    status: "active",
    stage: "shape",
    startedAt: NOW - 30 * D,
  });
});

beforeEach(() => {
  h.grant = undefined;
});

describe("synap_list_playbooks runs:'digest' (MCP door, real SQL)", () => {
  it("counts my runs of this playbook per stage, with median, stall and verdicts", async () => {
    const r = await call({ playbookId: h.playbookId, runs: "digest" });
    expect(r.isError).toBe(false);
    const d = r.body();
    expect(d.playbookId).toBe(h.playbookId);
    expect(d.runs).toEqual({
      total: 4,
      scanned: 4,
      byStatus: { closed: 1, cancelled: 1, active: 2 },
      attached: 0,
    });
    expect(d.endings).toEqual({ passing: 1, failing: 1 });
    expect(d.stages).toEqual([
      {
        key: "shape",
        reached: 4,
        medianHours: 4,
        timed: 3,
        now: 1,
        stalled: 0,
        skipped: 0,
        endedHere: 0,
      },
      {
        key: "build",
        reached: 3,
        medianHours: 3,
        timed: 2,
        now: 1,
        stalled: 1,
        skipped: 0,
        endedHere: 1,
      },
      {
        key: "review",
        reached: 1,
        medianHours: 1,
        timed: 1,
        now: 0,
        stalled: 0,
        skipped: 0,
        endedHere: 1,
      },
    ]);
    expect(d.recent).toHaveLength(4);
    expect(d.rules).toContain(`${RUNS_DIGEST_STALL_DAYS}+ days`);
    // The point of it: one small read.
    expect(r.text.length).toBeLessThan(2_500);
  });

  it("a key that does not read sessions is told the digest is withheld", async () => {
    h.grant = { scopes: [{ permissions: ["playbook.read"] }], clientId: null };
    const d = (await call({ playbookId: h.playbookId, runs: "digest" })).body();
    expect(d.runsDigest).toBeNull();
    expect(d.runsDigestWithheld).toMatch(/sessions/);
    expect(d.stages).toBeUndefined();
  });

  it("runs without a playbookId, or another value, is refused", async () => {
    expect((await call({ runs: "digest" })).isError).toBe(true);
    expect(
      (await call({ playbookId: h.playbookId, runs: "all" })).isError
    ).toBe(true);
  });

  it("a failed read is an error, never a digest of zero runs", async () => {
    await h.client!.exec(
      `alter table focus_sessions rename to focus_sessions_gone;`
    );
    try {
      const d = (
        await call({ playbookId: h.playbookId, runs: "digest" })
      ).body();
      expect(d.runsDigest).toBeNull();
      expect(d.runsDigestError).toBeTruthy();
      expect(d.runs).toBeUndefined();
    } finally {
      await h.client!.exec(
        `alter table focus_sessions_gone rename to focus_sessions;`
      );
    }
  });
});

describe("runsDigestReadableByGrant", () => {
  const key = (...scopes: Array<Record<string, unknown>>) =>
    ({ scopes, clientId: null }) as never;
  it("a person, a full key, or a key reading playbooks AND sessions", () => {
    expect(runsDigestReadableByGrant(null)).toBe(true);
    expect(runsDigestReadableByGrant(key({ permissions: ["*"] }))).toBe(true);
    expect(
      runsDigestReadableByGrant(
        key({ permissions: ["playbook.read", "session.read"] })
      )
    ).toBe(true);
  });
  it("not a key reading playbooks only, nor a deny-all one", () => {
    expect(
      runsDigestReadableByGrant(key({ permissions: ["playbook.read"] }))
    ).toBe(false);
    expect(runsDigestReadableByGrant(key({ permissions: [] }))).toBe(false);
  });
});
