/**
 * The object-first homes reads — `lifecycle.home` and `lifecycle.moving` —
 * against real SQL (PGlite, every table) through the REAL router:
 *
 *  home
 *   - spaces = the caller's visible, live spaces; an archived one, a system
 *     one (`settings.systemSlug`) and an agent's own space are not listed;
 *   - a space's intent is `settings.intent` (source template), else INFERRED
 *     (declared-lifecycle profiles with things IN that space; label = name);
 *     a space producing nothing is a library;
 *   - per produced kind: the board's columns (done counted within the window,
 *     the unclassified column when it holds any), live / doneWindowed /
 *     total, being-worked (live things with open work), needs-you from
 *     the grouped needs-you read, and the headline by the first reason that
 *     holds (needs_you → being_worked → stuck → recent);
 *   - a failed sub-read is null, never 0; an unknown produced slug is left out.
 *  moving
 *   - things with open work (subject session, in-flight worker target,
 *     scheduled prep), visible to the caller, the work under each with its
 *     kind / live / asksYou / actor; most urgent first; space + project lens.
 *
 * Stubbed: `getEffectiveLifecycle` (its own suites prove it) and
 * `countNeedsYouByScope` (the grouped needs-you read: its own PGlite suite
 * proves it equals `signals.count` per scope — this pins that the home asks
 * it ONCE, for every space and kind on the page).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const DEAL = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  countCalls: [] as Array<Record<string, unknown>>,
  failSpaceCount: null as string | null,
  failLiveness: false,
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
    countWorkerPendingApprovals: async () => 0,
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 0])),
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId !== "11111111-1111-4111-8111-111111111111") return null;
        return {
          propertySlug: "commercialStage",
          options: [
            { key: "draft", category: "open", stuckAfterDays: 7 },
            { key: "negotiating", category: "active" },
            { key: "won", category: "done" },
            { key: "lost", category: "lost" },
          ],
          unclassified: [],
        };
      }
    },
  };
});

vi.mock("./signals.js", () => ({
  // The ONE grouped needs-you read (its own suite proves it equals
  // `signals.count` per scope); here: what the home asks it, and that it
  // asks ONCE.
  countNeedsYouByScope: async (
    _ctx: unknown,
    input: {
      projectId?: string;
      spaces: Array<{ workspaceId: string; profileSlugs: string[] }>;
    }
  ) => {
    h.countCalls.push(input as never);
    return {
      total: 5,
      bySpace: new Map(
        input.spaces.map((s) => [
          s.workspaceId,
          s.workspaceId === h.failSpaceCount ? null : 2,
        ])
      ),
      byKind: new Map(
        input.spaces.map((s) => [
          s.workspaceId,
          new Map(
            s.profileSlugs.map((slug) => [slug, slug === "deal" ? 3 : null])
          ),
        ])
      ),
      attentionReads: 1,
    };
  },
}));

vi.mock("../services/runs/session-liveness.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/runs/session-liveness.js")
    >();
  return {
    ...actual,
    loadSessionLiveness: async (...args: unknown[]) => {
      if (h.failLiveness) throw new Error("liveness down");
      return (
        actual.loadSessionLiveness as (...a: unknown[]) => Promise<unknown>
      )(...args);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { lifecycleRouter } from "./lifecycle.js";

const USER = "user-1";
const AGENT = "agent-1";
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
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => minsAgo(d * 24 * 60);

const caller = () =>
  lifecycleRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);

async function space(
  name: string,
  o: {
    settings?: Record<string, unknown>;
    type?: string;
    archived?: boolean;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, archived_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,now(),now())`,
    [
      id,
      name,
      USER,
      o.type ?? "operational",
      JSON.stringify(o.settings ?? {}),
      o.archived ? new Date().toISOString() : null,
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(),$1,$2,'owner')`,
    [id, USER]
  );
  return id;
}

async function deal(
  ws: string,
  title: string,
  status: string | null,
  createdDaysAgo = 0,
  owner = USER
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, status, status_category, properties, created_at)
     values ($1,$2,$3,'deal',$4,$5,$6,$7,'{}'::jsonb,$8)`,
    [
      id,
      owner,
      ws,
      DEAL,
      title,
      status,
      { draft: "open", negotiating: "active", won: "done", lost: "lost" }[
        status ?? ""
      ] ?? null,
      daysAgo(createdDaysAgo),
    ]
  );
  return id;
}

async function session(o: {
  subject?: string | null;
  status?: string;
  worker?: boolean;
  running?: boolean;
  owes?: boolean;
  title?: string;
  agent?: string;
  mins: number;
}): Promise<string> {
  const id = randomUUID();
  const room = randomUUID();
  if (o.running) {
    await q(
      `insert into chat_turns (id, channel_id, status, started_at, updated_at) values ($1,$2,'running',now(),now())`,
      [randomUUID(), room]
    );
  }
  const slots = o.owes
    ? [
        {
          id: "s1",
          label: "Approve",
          owner: "human",
          blockedReason: "needs_human",
          owedSince: minsAgo(o.mins),
        },
      ]
    : [];
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, subject_entity_id, channel_id, expected_outputs, agent_ids, metadata, created_at, started_at, updated_at)
     values ($1,$2,$3,'g',$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$11,$11)`,
    [
      id,
      USER,
      o.title ?? null,
      o.status ?? "active",
      o.worker ? "playbook" : "human",
      o.subject ?? null,
      room,
      JSON.stringify(slots),
      o.agent ? [o.agent] : [],
      JSON.stringify(o.worker ? { automationId: randomUUID() } : {}),
      minsAgo(o.mins),
    ]
  );
  return id;
}

let DEV = "";
let MISC = "";
let LIB = "";
let ARCHIVED = "";
let SYSTEM = "";
let AGENTWS = "";
const T: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human'), ($2,'Scout','a@x.io','agent')`,
    [USER, AGENT]
  );
  await q(
    `insert into profiles (id, slug, display_name, plural, profile_kind, entity_scope, is_active) values ($1,'deal','Deal','Deals','kind','workspace',true)`,
    [DEAL]
  );
  // The declaration the inference reads (`declaredLifecycleProfilesStatement`).
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1,gen_random_uuid(),true)`,
    [DEAL]
  );

  DEV = await space("Dev", {
    settings: {
      intent: {
        label: "Sales",
        produces: ["deal", "no_such_kind"],
        source: "template",
      },
    },
  });
  MISC = await space("Misc");
  LIB = await space("Library");
  ARCHIVED = await space("Old", { archived: true });
  SYSTEM = await space("Pod admin", { settings: { systemSlug: "pod-admin" } });
  AGENTWS = await space("Scout KB", { type: "agent" });

  // DEV: draft ×2 (one stuck: 10 days in column), negotiating ×1,
  //      won ×2 (one inside the 7-day window, one 30 days ago), one stray.
  T.stuck = await deal(DEV, "Stuck draft", "draft", 10);
  T.fresh = await deal(DEV, "Fresh draft", "draft", 1);
  T.neg = await deal(DEV, "Negotiating", "negotiating", 2);
  T.wonNew = await deal(DEV, "Won now", "won", 0);
  T.wonOld = await deal(DEV, "Won long ago", "won", 30);
  T.stray = await deal(DEV, "Stray", "weird", 3);
  // MISC: one deal → inferred producer of `deal`.
  T.misc = await deal(MISC, "Misc deal", "draft", 0);
  // Someone else's deal in a space the caller cannot see.
  const hidden = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'Hidden','other','operational','{}'::jsonb)`,
    [hidden]
  );
  T.hidden = await deal(hidden, "Hidden", "draft", 0, "other");
});

describe("lifecycle.home", () => {
  it("lists the caller's live domain spaces with their intent", async () => {
    const home = await caller().home();
    const ids = home.spaces.map((s) => s.workspaceId);
    expect(ids).toEqual(expect.arrayContaining([DEV, MISC, LIB]));
    for (const gone of [ARCHIVED, SYSTEM, AGENTWS])
      expect(ids).not.toContain(gone);

    const dev = home.spaces.find((s) => s.workspaceId === DEV)!;
    expect(dev).toMatchObject({
      name: "Dev",
      label: "Sales",
      source: "template",
      kind: "producing",
    });
    // The unknown produced slug is left out, never an error.
    expect(dev.produces.map((p) => p.profileSlug)).toEqual(["deal"]);

    const misc = home.spaces.find((s) => s.workspaceId === MISC)!;
    expect(misc).toMatchObject({
      label: "Misc",
      source: "inferred",
      kind: "producing",
    });
    expect(misc.produces.map((p) => p.profileSlug)).toEqual(["deal"]);

    const lib = home.spaces.find((s) => s.workspaceId === LIB)!;
    expect(lib).toMatchObject({
      source: "inferred",
      kind: "library",
      produces: [],
    });
    // Producing spaces first.
    expect(ids.indexOf(LIB)).toBeGreaterThan(ids.indexOf(MISC));
  });

  it("per produced kind: the board's columns, windowed done, totals, words", async () => {
    const dev = (await caller().home()).spaces.find(
      (s) => s.workspaceId === DEV
    )!;
    const deal = dev.produces[0]!;
    expect(deal).toMatchObject({
      label: "Deal",
      plural: "Deals",
      windowDays: 7,
      total: 6,
      live: 4, // draft 2 + negotiating 1 + unclassified 1
      doneWindowed: 1,
    });
    expect(deal.columns.map((c) => [c.key, c.category, c.count])).toEqual([
      ["draft", "open", 2],
      ["negotiating", "active", 1],
      ["won", "done", 1],
      ["lost", "lost", 0],
      ["__unclassified", null, 1],
    ]);
  });

  it("needs-you: ONE grouped read for the page; a failed scope is null, never 0", async () => {
    h.countCalls.length = 0;
    h.failSpaceCount = MISC;
    try {
      const home = await caller().home();
      expect(home.needsYou.total).toBe(5);
      const by = new Map(
        home.needsYou.bySpace.map((b) => [b.workspaceId, b.count])
      );
      expect(by.get(DEV)).toBe(2);
      expect(by.get(MISC)).toBeNull();
      const dev = home.spaces.find((s) => s.workspaceId === DEV)!;
      expect(dev.produces[0]!.needsYou).toBe(3);
      // One read, asked for every listed space and its produced kinds.
      expect(h.countCalls).toHaveLength(1);
      const asked = h.countCalls[0] as unknown as {
        spaces: Array<{ workspaceId: string; profileSlugs: string[] }>;
      };
      expect(asked.spaces.map((x) => x.workspaceId).sort()).toEqual(
        home.spaces.map((x) => x.workspaceId).sort()
      );
      expect(
        asked.spaces.find((x) => x.workspaceId === DEV)?.profileSlugs
      ).toEqual(["deal", "no_such_kind"]);
    } finally {
      h.failSpaceCount = null;
    }
  });

  it("projectId narrows every read it hands down", async () => {
    const P = randomUUID();
    await q(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values (gen_random_uuid(),$1,$2,$3,'belongs_to_project')`,
      [USER, T.neg, P]
    );
    h.countCalls.length = 0;
    const home = await caller().home({ projectId: P });
    expect(h.countCalls).toHaveLength(1);
    expect(h.countCalls[0]!.projectId).toBe(P);
    const deal = home.spaces.find((s) => s.workspaceId === DEV)!.produces[0]!;
    expect(deal.total).toBe(1);
    expect(deal.live).toBe(1);
  });

  it("being worked + headline: needs_you over being_worked over stuck over recent", async () => {
    let deal = (await caller().home()).spaces.find(
      (s) => s.workspaceId === DEV
    )!.produces[0]!;
    // Nobody on anything: the stuck draft heads the kind.
    expect(deal.beingWorked).toBe(0);
    expect(deal.headline).toMatchObject({ entityId: T.stuck, reason: "stuck" });

    const live = await session({ subject: T.fresh, running: true, mins: 5 });
    deal = (await caller().home()).spaces.find((s) => s.workspaceId === DEV)!
      .produces[0]!;
    expect(deal.beingWorked).toBe(1);
    expect(deal.headline).toMatchObject({
      entityId: T.fresh,
      reason: "being_worked",
    });

    const asks = await session({ subject: T.neg, owes: true, mins: 8 });
    // A session on a TERMINAL thing is not "being worked".
    const onWon = await session({ subject: T.wonNew, mins: 3 });
    deal = (await caller().home()).spaces.find((s) => s.workspaceId === DEV)!
      .produces[0]!;
    expect(deal.beingWorked).toBe(2);
    expect(deal.headline).toMatchObject({
      entityId: T.neg,
      status: "negotiating",
      reason: "needs_you",
    });
    await q(`update focus_sessions set status = 'closed' where id = any($1)`, [
      [live, asks, onWon],
    ]);
  });

  it("a failed open-work read: being-worked is null, the headline skips its reasons", async () => {
    await session({ subject: T.fresh, running: true, mins: 5 });
    h.failLiveness = true;
    try {
      const deal = (await caller().home()).spaces.find(
        (s) => s.workspaceId === DEV
      )!.produces[0]!;
      expect(deal.beingWorked).toBeNull();
      expect(deal.headline?.reason).toBe("stuck");
    } finally {
      h.failLiveness = false;
      await q(`update focus_sessions set status = 'closed'`);
    }
  });
});

describe("lifecycle.moving", () => {
  it("things with open work, the work under each, most urgent first", async () => {
    const quiet = await session({
      subject: T.stuck,
      mins: 60,
      title: "Long quiet",
    });
    const live = await session({
      subject: T.fresh,
      running: true,
      mins: 5,
      agent: AGENT,
    });
    const asks = await session({
      subject: T.neg,
      owes: true,
      mins: 8,
      title: "Pricing",
    });
    const prep = await session({
      subject: T.misc,
      status: "scheduled",
      mins: 1,
      title: "Call prep",
    });
    const worker = await session({ worker: true, mins: 4 });
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values (gen_random_uuid(),'session',$1,'entity',$2,'targets','{"role":"worker_target"}'::jsonb,now())`,
      [worker, T.stuck]
    );
    // Not moving: a closed session, and a session on a thing the caller cannot see.
    await session({ subject: T.wonOld, status: "closed", mins: 2 });
    await session({ subject: T.hidden, mins: 2 });

    const { items } = await caller().moving();
    expect(items.map((i) => i.entityId)).toEqual([
      T.neg,
      T.fresh,
      T.stuck,
      T.misc,
    ]);

    const neg = items[0]!;
    expect(neg).toMatchObject({
      title: "Negotiating",
      profileSlug: "deal",
      workspaceId: DEV,
      status: "negotiating",
      category: "active",
    });
    expect(neg.work).toEqual([
      expect.objectContaining({
        sessionId: asks,
        kind: "session",
        label: "Pricing",
        asksYou: true,
        live: false,
      }),
    ]);
    expect(items[1]!.work[0]).toMatchObject({
      sessionId: live,
      live: true,
      actor: "Scout",
    });
    const stuckWork = items[2]!.work;
    expect(stuckWork.map((w) => [w.sessionId, w.kind])).toEqual(
      expect.arrayContaining([
        [quiet, "session"],
        [worker, "worker"],
      ])
    );
    expect(items[3]!.work[0]).toMatchObject({
      sessionId: prep,
      kind: "scheduled",
      label: "Call prep",
    });
  });

  it("narrows to a space and caps at limit", async () => {
    const inMisc = await caller().moving({ workspaceId: MISC, limit: 30 });
    expect(inMisc.items.map((i) => i.entityId)).toEqual([T.misc]);
    const one = await caller().moving({ limit: 1 });
    expect(one.items).toHaveLength(1);
  });
});
