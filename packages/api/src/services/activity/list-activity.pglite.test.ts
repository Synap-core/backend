/**
 * W6 Activity on PGlite — real SQL through the REAL `activity.list` door,
 * nothing hand-built in between.
 *
 * Fixture (USER owns everything unless noted; AGENT is USER's agent):
 *   PROJ / OTHER   two projects of USER in W1
 *   S_OPEN   active work session, started by AGENT (metadata.agentUserId), PROJ
 *   S_DONE   closed work session, USER's own, no project
 *   S_PB     the session of a playbook run → carried by the run, not twice
 *   P_AUTO   AGENT auto-approved entity create in S_OPEN / PROJ
 *   P_APPR   AGENT proposal USER approved → proposal row + decision row
 *   P_REJ    AGENT proposal USER rejected, OTHER project
 *   P_PEND   AGENT pending proposal, PROJ
 *   P_FS     auto-approved focus_session receipt → never a row
 *   TIE_*    three AGENT receipts inside ONE millisecond (µs apart, two of
 *            them identical) — the cursor must neither skip nor repeat them
 *   R_FAIL   automation run FAILED ("boom"), W1
 *   R_PB     playbook run completed, created by USER, session S_PB (PROJ)
 *   STRANGER — a personal (NULL-workspace) session, their agent's personal
 *            proposal in it, and a personal playbook run: none of it is USER's.
 *   S_HID    the stranger's W1 session USER cannot read (no roster seat), and
 *            P_HID, an applied proposal ABOUT it carrying its goal as the
 *            target name — visible to USER as a W1 proposal, content withheld
 *   S_RUNHID AGENT's session carried by R_HID, a personal run of STRANGER's
 *            that USER cannot see — so the session must still list
 *   P_STRDEC a W1 proposal the STRANGER decided (not USER's decision)
 *   X_*      a CROSS-SOURCE tie at TIE_AT[0]: a proposal filed and decided at
 *            that instant (proposal + decision rows) and an automation run
 *            finished then — three key prefixes at one timestamp
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
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
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  activityDayRange,
  activityFilterForPreset,
  calendarDayIn,
  type ActivityRow,
} from "@synap-core/types/activity";
import { activityRouter } from "../../routers/activity.js";

const USER = "user-1";
const STRANGER = "user-2";
const AGENT = "agent-1";
const STRANGER_AGENT = "agent-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const ago = (mins: number) =>
  new Date(Date.now() - mins * 60_000).toISOString();

const W1 = randomUUID();
const PROJ = randomUUID();
const OTHER = randomUUID();
const S_OPEN = randomUUID();
const S_DONE = randomUUID();
const S_PB = randomUUID();
const S_STR = randomUUID();
// A track in PROJ: S_OPEN is filed in it, and S_TRK is a tracked RUN session
// (playbook-minted, no playbook_runs row) — the project path's population.
const TRACK = randomUUID();
// The stranger's session in W1 whose ROOM seats USER (a human roster seat),
// and a proposal ABOUT it that carries its name — readable to USER by roster.
const S_SHARED = randomUUID();
const CH_SHARED = randomUUID();
const P_SHARED = randomUUID();
const S_TRK = randomUUID();
const S_HID = randomUUID();
const P_HID = randomUUID();
const S_RUNHID = randomUUID();
const R_HID = randomUUID();
const P_STRDEC = randomUUID();
const X_PROP = randomUUID();
const X_RUN = randomUUID();
const E_ADA = randomUUID();
const P_AUTO = randomUUID();
const P_APPR = randomUUID();
const P_REJ = randomUUID();
const P_PEND = randomUUID();
const P_FS = randomUUID();
const P_STR = randomUUID();
const TIE = [randomUUID(), randomUUID(), randomUUID()];
const A1 = randomUUID();
const R_FAIL = randomUUID();
const PB = randomUUID();
const PB_STR = randomUUID();
const R_PB = randomUUID();
const R_STR = randomUUID();
// One millisecond, three rows: µs .123456 twice and .123789.
const TIE_AT = [
  "2026-09-28T06:00:00.123456Z",
  "2026-09-28T06:00:00.123456Z",
  "2026-09-28T06:00:00.123789Z",
];

async function session(
  id: string,
  o: {
    user?: string;
    ws?: string | null;
    goal: string;
    status: string;
    started: number;
    closed?: number | null;
    project?: string | null;
    origin?: string;
    metadata?: Record<string, unknown>;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at, closed_at)
     values ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$7::jsonb,$8,$9,$9,$10,$10)`,
    [
      id,
      o.user ?? USER,
      o.ws === undefined ? W1 : o.ws,
      o.project ?? null,
      o.goal,
      o.status,
      JSON.stringify(o.metadata ?? {}),
      o.origin ?? "human",
      ago(o.started),
      o.closed == null ? ago(o.started) : ago(o.closed),
    ]
  );
  if (o.closed == null) {
    await q(`update focus_sessions set closed_at = null where id = $1`, [id]);
  }
}

const proposal = (p: {
  id: string;
  status: string;
  targetType?: string;
  targetId?: string;
  proposalType?: string;
  at: string;
  agent?: string | null;
  subject?: string;
  ws?: string | null;
  project?: string | null;
  sessionId?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  data?: unknown;
}) =>
  q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_by, subject_user_id, session_id, project_id, reviewed_by, reviewed_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8,$9,$10,$11,$12,$13,$14,$14)`,
    [
      p.id,
      p.ws === undefined ? W1 : p.ws,
      p.targetType ?? "entity",
      p.targetId ?? randomUUID(),
      p.proposalType ?? "create",
      JSON.stringify(p.data ?? {}),
      p.status,
      p.agent === undefined ? AGENT : p.agent,
      p.subject ?? USER,
      p.sessionId ?? null,
      p.project ?? null,
      p.reviewedBy ?? null,
      p.reviewedAt ?? null,
      p.at,
    ]
  );

const ctx = (userId = USER) =>
  ({ db: null, authenticated: true, userId }) as never;
const list = (
  input: Parameters<ReturnType<typeof activityRouter.createCaller>["list"]>[0],
  userId = USER
) => activityRouter.createCaller(ctx(userId)).list(input);

async function readAll(
  input: Parameters<ReturnType<typeof activityRouter.createCaller>["list"]>[0],
  pageSize: number
): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await list({ ...input, limit: pageSize, cursor });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never ended");
}

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }

  await q(`insert into workspaces (id, name) values ($1,'Builder')`, [W1]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), W1, USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_metadata, created_by_user_id) values
      ($1,'Antoine','a@x.io','human',null,null),
      ($2,'Claude Code','agent@x.io','agent','{"agentType":"claude-code"}'::jsonb,$1),
      ($3,'Stranger','s@x.io','human',null,null),
      ($4,'Their Agent','sa@x.io','agent','{"agentType":"codex"}'::jsonb,$3)`,
    [USER, AGENT, STRANGER, STRANGER_AGENT]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1,$3,$4,'Launch','active'), ($2,$3,$4,'Other','active')`,
    [PROJ, OTHER, USER, W1]
  );

  await session(S_OPEN, {
    goal: "Market research brief",
    status: "active",
    started: 60,
    project: PROJ,
    origin: "agent",
    metadata: { agentUserId: AGENT },
  });
  await session(S_TRK, {
    goal: "Stage 2 — outline",
    status: "active",
    started: 15,
    origin: "playbook",
    metadata: { agentUserId: AGENT },
  });
  await q(`update focus_sessions set track_id = $1 where id in ($2, $3)`, [
    TRACK,
    S_OPEN,
    S_TRK,
  ]);
  await q(`update focus_sessions set playbook_id = $1 where id = $2`, [
    randomUUID(),
    S_TRK,
  ]);
  await session(S_SHARED, {
    user: STRANGER,
    goal: "Shared launch plan",
    status: "active",
    started: 12,
  });
  await q(`update focus_sessions set channel_id = $1 where id = $2`, [
    CH_SHARED,
    S_SHARED,
  ]);
  await q(
    `insert into channels (id, context_object_type, context_object_id) values ($1,'focus_session',$2)`,
    [CH_SHARED, S_SHARED]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind) values ($1,$2,$3,'human')`,
    [randomUUID(), CH_SHARED, USER]
  );
  await session(S_DONE, {
    goal: "Tidy inbox",
    status: "closed",
    started: 90,
    closed: 5,
  });
  await session(S_PB, {
    goal: "Weekly digest",
    status: "closed",
    started: 30,
    closed: 25,
    project: PROJ,
  });
  await q(`update focus_sessions set playbook_id = $1 where id = $2`, [
    PB,
    S_PB,
  ]);
  await session(S_STR, {
    user: STRANGER,
    ws: null,
    goal: "Private diary",
    status: "closed",
    started: 20,
    closed: 3,
  });

  await proposal({
    id: P_AUTO,
    status: "auto_approved",
    targetId: E_ADA,
    proposalType: "create",
    at: ago(50),
    project: PROJ,
    sessionId: S_OPEN,
    data: {
      name: "Ada Lovelace",
      profileSlug: "person",
      materialized: { entityIds: [E_ADA] },
    },
  });
  await proposal({
    id: P_APPR,
    status: "approved",
    at: ago(40),
    reviewedBy: USER,
    reviewedAt: ago(38),
    data: { name: "Acme" },
  });
  await proposal({
    id: P_REJ,
    status: "rejected",
    at: ago(36),
    project: OTHER,
    reviewedBy: USER,
    reviewedAt: ago(35),
    data: { name: "Spam Co" },
  });
  await proposal({
    id: P_PEND,
    status: "pending",
    at: ago(34),
    project: PROJ,
    data: { name: "Beta Corp" },
  });
  await proposal({
    id: P_FS,
    status: "auto_approved",
    targetType: "focus_session",
    targetId: S_OPEN,
    at: ago(59),
  });
  await proposal({
    id: P_SHARED,
    status: "pending",
    targetType: "focus_session",
    targetId: S_SHARED,
    proposalType: "update",
    at: ago(11),
    agent: STRANGER_AGENT,
    subject: STRANGER,
    data: { targetName: "Shared launch plan" },
  });
  for (const [i, id] of TIE.entries()) {
    await proposal({ id, status: "auto_approved", at: TIE_AT[i]! });
  }
  // The stranger's agent's PERSONAL write, in their personal session.
  await proposal({
    id: P_STR,
    status: "auto_approved",
    at: ago(4),
    ws: null,
    agent: STRANGER_AGENT,
    subject: STRANGER,
    sessionId: S_STR,
    data: { name: "Diary entry" },
  });

  await session(S_HID, {
    user: STRANGER,
    goal: "Secret merger plan",
    status: "active",
    started: 14,
  });
  await proposal({
    id: P_HID,
    status: "auto_approved",
    targetType: "session",
    targetId: S_HID,
    proposalType: "update",
    at: ago(13),
    agent: STRANGER_AGENT,
    subject: STRANGER,
    data: { targetName: "Secret merger plan" },
  });
  await session(S_RUNHID, {
    goal: "Run nobody here can see",
    status: "closed",
    started: 45,
    closed: 44,
    origin: "agent",
    metadata: { agentUserId: AGENT },
  });
  await proposal({
    id: P_STRDEC,
    status: "approved",
    at: ago(33),
    reviewedBy: STRANGER,
    reviewedAt: ago(32),
    data: { name: "Gamma Ltd" },
  });

  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, status) values ($1,$2,$3,'Contact enrichment','event','active')`,
    [A1, W1, USER]
  );
  await proposal({
    id: X_PROP,
    status: "approved",
    at: TIE_AT[0]!,
    reviewedBy: STRANGER,
    reviewedAt: TIE_AT[0]!,
    data: { name: "Tie Co" },
  });
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, status, started_at, completed_at) values ($1,$2,$3,'completed',$4,$4)`,
    [X_RUN, A1, W1, TIE_AT[0]]
  );
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, status, error_message, started_at, completed_at) values ($1,$2,$3,'failed','boom',$4,$5)`,
    [R_FAIL, A1, W1, ago(21), ago(20)]
  );
  await q(
    `insert into playbooks (id, name, workspace_id) values ($1,'Weekly digest',$2),($3,'Their playbook',null)`,
    [PB, W1, PB_STR]
  );
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, session_id, status, started_at, completed_at, created_by) values
      ($1,$2,$3,$4,'completed',$5,$6,$7),
      ($8,null,$9,null,'completed',$5,$10,$11),
      ($12,null,$9,$13,'completed',$5,$10,$11)`,
    [
      R_PB,
      W1,
      PB,
      S_PB,
      ago(30),
      ago(25),
      USER,
      R_STR,
      PB_STR,
      ago(2),
      STRANGER,
      R_HID,
      S_RUNHID,
    ]
  );
});

const ids = (rows: ActivityRow[]) => rows.map((r) => r.id);

describe("activity.list — one ledger through the real door", () => {
  it("unions every source, newest first, and leaves the session receipt out", async () => {
    const { items, nextCursor } = await list({ limit: 100 });
    expect(nextCursor).toBeNull();
    const got = ids(items);
    for (const key of [
      `proposal:${P_AUTO}`,
      `proposal:${P_APPR}`,
      `decision:${P_APPR}`,
      `proposal:${P_REJ}`,
      `decision:${P_REJ}`,
      `proposal:${P_PEND}`,
      `run:${R_FAIL}`,
      `run:${R_PB}`,
      `session:${S_OPEN}`,
      `session:${S_DONE}`,
      ...TIE.map((t) => `proposal:${t}`),
    ]) {
      expect(got).toContain(key);
    }
    expect(got).not.toContain(`proposal:${P_FS}`);
    // A session a playbook run carries is not listed twice.
    expect(got).not.toContain(`session:${S_PB}`);
    const times = items.map((r) => Date.parse(r.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("the values arrive: actor, verb, title, doors, undo", async () => {
    const { items } = await list({ limit: 100 });
    const by = new Map(items.map((r) => [r.id, r]));

    const auto = by.get(`proposal:${P_AUTO}`)!;
    expect(auto.actor).toEqual({
      kind: "agent",
      id: AGENT,
      name: "Claude Code",
    });
    expect(auto.verb).toBe("Created");
    expect(auto.outcome).toBe("succeeded");
    expect(auto.object).toMatchObject({ kind: "entity", id: E_ADA });
    expect(auto.title).toContain("Ada Lovelace");
    expect(auto.session).toEqual({
      id: S_OPEN,
      title: "Market research brief",
    });
    expect(auto.project).toEqual({ id: PROJ, name: "Launch" });
    expect(auto.undo).toEqual({ proposalId: P_AUTO, changeCount: 1 });

    const decided = by.get(`decision:${P_APPR}`)!;
    expect(decided.actor).toEqual({
      kind: "human",
      id: USER,
      name: "Antoine",
      isViewer: true,
    });
    expect(decided.verb).toBe("Approved");
    expect(decided.object).toMatchObject({ kind: "proposal", id: P_APPR });
    expect(decided.undo?.proposalId).toBe(P_APPR);
    // ONE Undo per proposal: on the decision, not on the act it decided.
    expect(by.get(`proposal:${P_APPR}`)!.undo).toBeNull();

    expect(by.get(`decision:${P_REJ}`)!.outcome).toBe("rejected");
    expect(by.get(`proposal:${P_PEND}`)!.outcome).toBe("proposed");
    expect(by.get(`proposal:${P_PEND}`)!.object.kind).toBe("proposal");

    const open = by.get(`session:${S_OPEN}`)!;
    expect(open.actor).toMatchObject({ kind: "agent", id: AGENT });
    expect(open.verb).toBe("Started");
    expect(open.outcome).toBe("running");
    expect(by.get(`session:${S_DONE}`)!.verb).toBe("Closed");
  });

  it("a failed run shows up with outcome failed, its error, and a run door", async () => {
    const { items } = await list({ outcome: "failed", limit: 100 });
    expect(ids(items)).toEqual([`run:${R_FAIL}`]);
    expect(items[0]).toMatchObject({
      outcome: "failed",
      error: "boom",
      title: "Contact enrichment",
      actor: { kind: "system", id: A1, name: "Contact enrichment" },
      object: { kind: "run", id: R_FAIL, flowType: "automation" },
    });
  });

  it("actor=agents excludes humans (and rules)", async () => {
    const { items } = await list({ actor: "agents", limit: 100 });
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.every((r) => r.actor.kind === "agent")).toBe(true);
    expect(ids(items)).toContain(`proposal:${P_AUTO}`);
    expect(ids(items)).toContain(`session:${S_OPEN}`);
    expect(ids(items)).not.toContain(`decision:${P_APPR}`);
    expect(ids(items)).not.toContain(`session:${S_DONE}`);
    expect(ids(items)).not.toContain(`run:${R_FAIL}`);
  });

  it("actor=me is only the viewer's own acts; agent:<id> is only that agent", async () => {
    const mine = await list({ actor: "me", limit: 100 });
    expect(new Set(ids(mine.items))).toEqual(
      new Set([
        `decision:${P_APPR}`,
        `decision:${P_REJ}`,
        `session:${S_DONE}`,
        `run:${R_PB}`,
      ])
    );
    const cc = await list({ actor: `agent:${AGENT}`, limit: 100 });
    expect(cc.items.length).toBeGreaterThan(0);
    expect(
      cc.items.every((r) => r.actor.kind === "agent" && r.actor.id === AGENT)
    ).toBe(true);
    await expect(list({ actor: "person:x" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("the project filter narrows every source to that project", async () => {
    const { items } = await list({ projectId: PROJ, limit: 100 });
    expect(new Set(ids(items))).toEqual(
      new Set([
        `proposal:${P_AUTO}`,
        `proposal:${P_PEND}`,
        `run:${R_PB}`,
        `session:${S_OPEN}`,
      ])
    );
    expect(items.every((r) => r.project?.id === PROJ)).toBe(true);
  });

  it("the track filter narrows to that track's sessions and what was filed in them", async () => {
    const { items } = await list({ trackId: TRACK, limit: 100 });
    expect(new Set(ids(items))).toEqual(
      new Set([`proposal:${P_AUTO}`, `session:${S_OPEN}`, `session:${S_TRK}`])
    );
    // A tracked run session is in the population even with no filter.
    expect(ids((await list({ limit: 100 })).items)).toContain(
      `session:${S_TRK}`
    );
  });

  it("a roster member reads a shared session's real name in a proposal title", async () => {
    const { items } = await list({ limit: 100 });
    const row = items.find((r) => r.id === `proposal:${P_SHARED}`)!;
    expect(row).toBeDefined();
    expect(row.title).toContain("Shared launch plan");
    // The session itself is readable through the roster too — same rule.
    expect(ids(items)).toContain(`session:${S_SHARED}`);
  });

  it("source=decision = the decisions a person made; the Decided preset = MINE", async () => {
    const { items } = await list({ source: "decision", limit: 100 });
    expect(new Set(ids(items))).toEqual(
      new Set([
        `decision:${P_APPR}`,
        `decision:${P_REJ}`,
        `decision:${P_STRDEC}`,
        `decision:${X_PROP}`,
      ])
    );
    // The preset the UI labels "Your decisions" — through the leaf, not a copy.
    const mine = await list({
      ...activityFilterForPreset("decided"),
      limit: 100,
    });
    expect(new Set(ids(mine.items))).toEqual(
      new Set([`decision:${P_APPR}`, `decision:${P_REJ}`])
    );
  });

  it("a proposal about a session I cannot read names nothing and opens the proposal", async () => {
    const { items } = await list({ limit: 100 });
    const row = items.find((r) => r.id === `proposal:${P_HID}`)!;
    // Non-vacuity: the row IS listed (a visible W1 proposal) and applied.
    expect(row).toBeDefined();
    expect(row.outcome).toBe("succeeded");
    expect(JSON.stringify(row)).not.toContain("Secret merger plan");
    expect(row.object).toEqual({
      kind: "proposal",
      id: P_HID,
      name: row.title,
    });
    // …and the session itself is not listed to USER.
    expect(ids(items)).not.toContain(`session:${S_HID}`);
    // The owner reads the real name and is sent to the session.
    const theirs = (await list({ limit: 100 }, STRANGER)).items.find(
      (r) => r.id === `proposal:${P_HID}`
    )!;
    expect(theirs.object).toMatchObject({
      kind: "session",
      id: S_HID,
      name: "Secret merger plan",
    });
  });

  it("a session is left to its run only when the viewer can SEE that run", async () => {
    const { items } = await list({ limit: 100 });
    // R_HID is the stranger's personal run: invisible, so it carries nothing.
    expect(ids(items)).not.toContain(`run:${R_HID}`);
    expect(ids(items)).toContain(`session:${S_RUNHID}`);
    // Control: a VISIBLE run still carries its session (S_PB via R_PB).
    expect(ids(items)).toContain(`run:${R_PB}`);
    expect(ids(items)).not.toContain(`session:${S_PB}`);
  });

  it("the cursor is stable: pages of 1, 2 and 3 read the exact same ledger", async () => {
    const whole = ids((await list({ limit: 100 })).items);
    expect(whole.length).toBeGreaterThanOrEqual(13);
    for (const size of [1, 2, 3]) {
      const paged = ids(await readAll({}, size));
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(paged.length);
    }
    // The three µs-apart rows inside one millisecond all arrive, once.
    const tie = whole.filter((k) => TIE.some((t) => k === `proposal:${t}`));
    expect(tie).toHaveLength(3);
    // Three sources at ONE instant, in key order (run > proposal > decision).
    const at0 = whole.filter((k) =>
      [`run:${X_RUN}`, `proposal:${X_PROP}`, `decision:${X_PROP}`].includes(k)
    );
    expect(at0).toEqual([
      `run:${X_RUN}`,
      `proposal:${X_PROP}`,
      `decision:${X_PROP}`,
    ]);
  });

  it("since narrows by the act's own clock", async () => {
    const { items } = await list({ since: ago(22), limit: 100 });
    expect(
      items.every((r) => Date.parse(r.occurredAt) >= Date.parse(ago(23)))
    ).toBe(true);
    expect(ids(items)).toContain(`run:${R_FAIL}`);
    expect(ids(items)).not.toContain(`proposal:${P_AUTO}`);
  });

  it("no leak: another user's private session activity is never returned", async () => {
    const strangerKeys = [
      `session:${S_STR}`,
      `proposal:${P_STR}`,
      `run:${R_STR}`,
    ];
    for (const input of [
      { limit: 100 },
      { actor: "agents" as const, limit: 100 },
      { workspaceId: null, limit: 100 },
      { source: "run" as const, limit: 100 },
    ]) {
      const got = ids((await list(input)).items);
      for (const k of strangerKeys) expect(got).not.toContain(k);
    }
    // Non-vacuity: the stranger DOES see all three — the rows exist.
    const theirs = ids((await list({ limit: 100 }, STRANGER)).items);
    for (const k of strangerKeys) expect(theirs).toContain(k);
    // …and none of USER's W1 activity (not a member).
    expect(theirs).not.toContain(`proposal:${P_AUTO}`);
  });

  it("a bad cursor is a caller error, never an empty page", async () => {
    await expect(list({ cursor: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

// ── activity.daily — the same ledger, counted per day ──────────────────────

const daily = (
  input: Parameters<ReturnType<typeof activityRouter.createCaller>["daily"]>[0],
  userId = USER
) => activityRouter.createCaller(ctx(userId)).daily(input);

/**
 * A zone whose local midnight fell within the last hour, so the fixture's
 * recent rows (1–90 minutes old) straddle two calendar days there. Chosen at
 * run time: some zone always sits between 00:00 and 01:00.
 */
function midnightZone(): string {
  const now = Date.now();
  for (const tz of Intl.supportedValuesOf("timeZone")) {
    const today = calendarDayIn(now, tz);
    const since = Date.parse(activityDayRange(today, tz).since);
    if (now - since >= 10 * 60_000 && now - since <= 50 * 60_000) return tz;
  }
  throw new Error("no zone has just passed midnight");
}

describe("activity.daily — parity with activity.list", () => {
  const FILTERS = [
    {},
    { actor: "agents" },
    { actor: "me" },
    { projectId: PROJ },
    { source: "run" as const },
    { source: "decision" as const },
    { workspaceId: null },
    { workspaceId: W1 },
  ];

  it("each day's count == the rows list pages through for that day, in every zone", async () => {
    const zones = [
      "UTC",
      "Pacific/Auckland",
      "America/Los_Angeles",
      midnightZone(),
    ];
    let split = 0;
    let counted = 0;
    for (const tz of zones) {
      for (const filter of FILTERS) {
        const d = await daily({ ...filter, tz, days: 30 });
        expect(d.tz).toBe(tz);
        let sum = 0;
        for (const day of d.days) {
          const range = activityDayRange(day.date, tz);
          const rows = await readAll({ ...filter, ...range }, 7);
          expect({ tz, filter, day: day.date, n: rows.length }).toEqual({
            tz,
            filter,
            day: day.date,
            n: day.count,
          });
          sum += day.count;
        }
        // …and no day is missing: the whole window holds exactly the sum.
        const all = await readAll(
          {
            ...filter,
            since: activityDayRange(d.from, tz).since,
            until: activityDayRange(d.to, tz).until,
          },
          50
        );
        expect(all.length).toBe(sum);
        counted += sum;
        if (Object.keys(filter).length === 0) {
          const recent = d.days.filter(
            (x) => x.date >= calendarDayIn(Date.now() - 86_400_000 * 2, tz)
          );
          if (recent.length >= 2) split += 1;
        }
      }
    }
    // Non-vacuity: rows were counted, and in at least one zone the recent
    // fixture straddled midnight (two recent days, not one).
    expect(counted).toBeGreaterThan(50);
    expect(split).toBeGreaterThan(0);
  });

  it("buckets by the viewer's zone: a row lands on its local day", async () => {
    // TIE_AT = 2026-09-28T06:00Z — Sep 28 in UTC, Sep 27 in Los Angeles.
    const utc = await daily({ tz: "UTC", days: 371, source: "proposal" });
    const la = await daily({
      tz: "America/Los_Angeles",
      days: 371,
      source: "proposal",
    });
    expect(
      utc.days.find((x) => x.date === "2026-09-28")?.count
    ).toBeGreaterThanOrEqual(4);
    expect(
      la.days.find((x) => x.date === "2026-09-27")?.count
    ).toBeGreaterThanOrEqual(4);
    expect(la.days.find((x) => x.date === "2026-09-28")).toBeUndefined();
  });

  it("the stranger's acts are never counted for USER", async () => {
    const mine = await daily({ tz: "UTC", days: 30, workspaceId: null });
    const theirs = await daily(
      { tz: "UTC", days: 30, workspaceId: null },
      STRANGER
    );
    const total = (d: typeof mine) => d.days.reduce((n, x) => n + x.count, 0);
    // USER has no personal (NULL-workspace) acts; the stranger has three.
    expect(total(mine)).toBe(0);
    expect(total(theirs)).toBeGreaterThanOrEqual(3);
  });

  it("an unknown zone is a caller error, never an empty grid", async () => {
    await expect(daily({ tz: "Mars/Olympus" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
