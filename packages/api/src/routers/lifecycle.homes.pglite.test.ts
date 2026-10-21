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
const LEAD = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
/** A POD-SCOPE kind with a lifecycle (homes X1: rows with no space). */
const DECISION = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  countCalls: [] as Array<Record<string, unknown>>,
  failSpaceCount: null as string | null,
  failLiveness: false,
  /** `getEffectiveLifecycle` calls — counted by the Q-S4 ratchet. */
  lifecycleReads: 0,
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
        h.lifecycleReads++;
        if (profileId === "22222222-2222-4222-8222-222222222222") {
          return {
            propertySlug: "leadStage",
            options: [
              { key: "new", category: "open" },
              { key: "qualified", category: "active" },
              { key: "converted", category: "done" },
            ],
            unclassified: [],
          };
        }
        if (profileId === "44444444-4444-4444-8444-444444444444") {
          return {
            propertySlug: "decisionStatus",
            options: [
              { key: "proposed", category: "open" },
              { key: "accepted", category: "done" },
            ],
            unclassified: [],
          };
        }
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

vi.mock("./signals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signals.js")>()),
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
      truncated: true,
      bySpace: new Map(
        input.spaces.map((s) => [
          s.workspaceId,
          s.workspaceId === h.failSpaceCount ? null : 2,
        ])
      ),
      bySpaceTruncated: new Map(
        input.spaces.map((s) => [
          s.workspaceId,
          s.workspaceId === h.failSpaceCount ? null : false,
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
      byKindTruncated: new Map(
        input.spaces.map((s) => [
          s.workspaceId,
          new Map(
            s.profileSlugs.map((slug) => [slug, slug === "deal" ? true : null])
          ),
        ])
      ),
      podLevel: 4,
      podLevelTruncated: false,
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
import { preferencesRouter } from "./preferences.js";
import { db as pgDb } from "@synap/database";

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

async function person(ws: string | null, title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, created_at)
     values ($1,$2,$3,'person',$4,$5,'{}'::jsonb,now())`,
    [id, USER, ws, PERSON, title]
  );
  return id;
}

async function leadFacet(
  entityId: string,
  ws: string | null,
  status: string,
  owner: string
): Promise<void> {
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata, created_at, updated_at)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb,now(),now())`,
    [
      entityId,
      LEAD,
      owner,
      ws,
      status,
      { new: "open", qualified: "active", converted: "done" }[status] ?? null,
    ]
  );
}

async function session(o: {
  subject?: string | null;
  status?: string;
  worker?: boolean;
  running?: boolean;
  owes?: boolean;
  title?: string;
  agent?: string;
  /** `agent` = an undecided agent DRAFT (triage pending). */
  origin?: string;
  /** The session's own space (`focus_sessions.workspace_id`). */
  workspace?: string;
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
    `insert into focus_sessions (id, user_id, title, goal, status, origin, subject_entity_id, channel_id, expected_outputs, agent_ids, metadata, created_at, started_at, updated_at, workspace_id)
     values ($1,$2,$3,'g',$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$11,$11,$12)`,
    [
      id,
      USER,
      o.title ?? null,
      o.status ?? "active",
      o.origin ?? (o.worker ? "playbook" : "human"),
      o.subject ?? null,
      room,
      JSON.stringify(slots),
      o.agent ? [o.agent] : [],
      JSON.stringify(o.worker ? { automationId: randomUUID() } : {}),
      minsAgo(o.mins),
      o.workspace ?? null,
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
let CRM = "";
let HIDDEN = "";
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
  await q(
    `insert into profiles (id, slug, display_name, plural, profile_kind, entity_scope, is_active) values
       ($1,'lead','Lead','Leads','role','pod',true),
       ($2,'person','Person','People','kind','pod',true)`,
    [LEAD, PERSON]
  );
  // The declaration the inference reads (`declaredLifecycleProfilesStatement`).
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1,gen_random_uuid(),true), ($2,gen_random_uuid(),true)`,
    [DEAL, LEAD]
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
  HIDDEN = hidden;
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'Hidden','other','operational','{}'::jsonb)`,
    [hidden]
  );
  T.hidden = await deal(hidden, "Hidden", "draft", 0, "other");

  // ROLE-produced work (homes review M1): CRM produces `lead`, a ROLE whose
  // stage lives on the facet. The people live elsewhere (MISC / pod-wide).
  CRM = await space("CRM", {
    settings: {
      intent: { label: "Pipeline", produces: ["lead"], source: "template" },
    },
  });
  T.alice = await person(MISC, "Alice");
  T.bob = await person(null, "Bob");
  T.carol = await person(MISC, "Carol");
  await leadFacet(T.alice, CRM, "qualified", USER);
  // A shared role's facet is stored POD-WIDE (no space).
  await leadFacet(T.bob, null, "new", USER);
  // Carol's lead facet sits in a space the caller cannot see.
  await leadFacet(T.carol, hidden, "qualified", "other");
  // Dave's lead facet is pod-wide but SOMEONE ELSE's (the facet owner floor).
  T.dave = await person(MISC, "Dave");
  await leadFacet(T.dave, null, "qualified", "other");
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

  it("the unclassified column says how many have NO status, apart from undeclared values (X2)", async () => {
    // TWO unset vs ONE undeclared value ("weird"), so the counts disagree
    // under a rule that mixed them up.
    const unset = [
      await deal(DEV, "No status yet", null, 1),
      await deal(DEV, "No status either", null, 2),
    ];
    try {
      const dealKind = (await caller().home()).spaces
        .find((s) => s.workspaceId === DEV)!
        .produces.find((p) => p.profileSlug === "deal")!;
      // "weird" (an undeclared value) + two with no status at all.
      expect(dealKind.columns.at(-1)).toMatchObject({
        key: "__unclassified",
        label: "No declared status",
        count: 3,
        unset: 2,
      });
      const board = await caller().board({
        profileSlug: "deal",
        workspaceId: DEV,
      });
      expect(
        board.columns.find((c) => c.key === "__unclassified")
      ).toMatchObject({
        count: 3,
        unset: 2,
      });
    } finally {
      await q(
        `update entities set deleted_at = now() where id = any($1::uuid[])`,
        [unset]
      );
    }
  });

  it("needs-you: ONE grouped read for the page; a failed scope is null, never 0", async () => {
    h.countCalls.length = 0;
    h.failSpaceCount = MISC;
    try {
      const home = await caller().home();
      expect(home.needsYou.total).toBe(5);
      // The floor flag reaches the wire: a capped total says "5+", not "5".
      expect(home.needsYou.truncated).toBe(true);
      // Pod-level needs-you reaches the wire (X3): a client tells "in no
      // space" apart from "a space's count is missing".
      expect(home.needsYou.podLevel).toBe(4);
      const by = new Map(
        home.needsYou.bySpace.map((b) => [b.workspaceId, b.count])
      );
      expect(by.get(DEV)).toBe(2);
      expect(by.get(MISC)).toBeNull();
      const flags = new Map(
        home.needsYou.bySpace.map((b) => [b.workspaceId, b.truncated])
      );
      expect(flags.get(DEV)).toBe(false);
      expect(flags.get(MISC)).toBeNull();
      const dev = home.spaces.find((s) => s.workspaceId === DEV)!;
      expect(dev.produces[0]!.needsYou).toBe(3);
      // The kind's and pod level's floor flags reach the wire too.
      expect(dev.produces[0]!.needsYouTruncated).toBe(true);
      expect(home.needsYou.podLevelTruncated).toBe(false);
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

  /** A project of USER's: `home` = projects.workspace_id, `uses` = edges. */
  async function project(o: {
    home?: string | null;
    uses?: string[];
    owner?: string;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name, slug, status) values ($1,$2,$3,'P',$4,'active')`,
      [id, o.owner ?? USER, o.home ?? null, `p-${id}`]
    );
    for (const ws of o.uses ?? []) {
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_at) values (gen_random_uuid(),'project',$1,'workspace',$2,'uses',now())`,
        [id, ws]
      );
    }
    return id;
  }

  it("projectId narrows every read it hands down", async () => {
    const P = await project({ uses: [DEV] });
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

  it("projectId lists only the project's spaces: the ones it uses + its home", async () => {
    const all = (await caller().home()).spaces.map((s) => s.workspaceId);
    expect(all).toEqual(expect.arrayContaining([DEV, MISC, LIB]));

    const used = await project({ uses: [DEV] });
    const spaces = (await caller().home({ projectId: used })).spaces;
    expect(spaces.map((s) => s.workspaceId)).toEqual([DEV]);

    // A home with no `uses` edge (an older project) still counts.
    const homed = await project({ home: MISC, uses: [LIB] });
    expect(
      new Set(
        (await caller().home({ projectId: homed })).spaces.map(
          (s) => s.workspaceId
        )
      )
    ).toEqual(new Set([MISC, LIB]));

    // The needs-you read is asked for the project's spaces only.
    h.countCalls.length = 0;
    await caller().home({ projectId: used });
    expect(
      (h.countCalls[0]!.spaces as Array<{ workspaceId: string }>).map(
        (s) => s.workspaceId
      )
    ).toEqual([DEV]);
  });

  it("projectId also lists a space holding a thing filed into it, even one the project never linked", async () => {
    const P = await project({ uses: [DEV] });
    const fileInto = (thing: string) =>
      q(
        `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values (gen_random_uuid(),$1,$2,$3,'belongs_to_project')`,
        [USER, thing, P]
      );
    // MISC is not a part of P, but its deal is filed into P: it stays visible.
    await fileInto(T.misc);
    // A DELETED thing filed from LIB does not drag LIB in; nor does a thing in
    // a space the caller cannot see.
    const gone = await deal(LIB, "Deleted", "draft");
    await q(`update entities set deleted_at = now() where id = $1`, [gone]);
    await fileInto(gone);
    await fileInto(T.hidden);

    const home = await caller().home({ projectId: P });
    expect(new Set(home.spaces.map((s) => s.workspaceId))).toEqual(
      new Set([DEV, MISC])
    );
    const misc = home.spaces.find((s) => s.workspaceId === MISC)!;
    expect(misc.produces.find((k) => k.profileSlug === "deal")?.total).toBe(1);
  });

  it("a project in no space has no spaces; one the caller cannot see is NOT_FOUND", async () => {
    const bare = await project({});
    expect((await caller().home({ projectId: bare })).spaces).toEqual([]);

    const theirs = await project({ owner: "user-2", uses: [DEV] });
    await expect(caller().home({ projectId: theirs })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller().home({ projectId: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

describe("lifecycle.home — pod-wide things (homes X1, review #5)", () => {
  async function decisionRow(ws: string | null): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, type, profile_id, title, status, status_category, properties, created_at)
       values ($1,$2,$3,'decision',$4,'D','proposed','open','{}'::jsonb,now())`,
      [id, USER, ws, DECISION]
    );
    return id;
  }
  const sum = (cols: Array<{ count: number }> | undefined) =>
    cols?.reduce((n, c) => n + c.count, 0);

  it("a card counts what its board shows (pod-wide rows included); only OWNED rows make a space produce", async () => {
    await q(
      `insert into profiles (id, slug, display_name, plural, profile_kind, entity_scope, is_active) values ($1,'decision','Decision','follow-ups','kind','pod',true)`,
      [DECISION]
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1,gen_random_uuid(),true)`,
      [DECISION]
    );
    const beta = await space("Beta decisions", {
      settings: {
        intent: { label: "Beta", produces: ["decision"], source: "template" },
      },
    });
    // No intent and no decision of its own: only pod-wide ones reach it.
    const gamma = await space("Gamma nothing", {});
    const rows: string[] = [];
    try {
      for (let i = 0; i < 3; i++) rows.push(await decisionRow(null)); // pod-wide
      rows.push(await decisionRow(beta), await decisionRow(beta));
      rows.push(await decisionRow(MISC)); // MISC infers `decision`

      const home = await caller().home();
      for (const ws of [beta, MISC]) {
        const card = home.spaces
          .find((s) => s.workspaceId === ws)!
          .produces.find((p) => p.profileSlug === "decision")!;
        const board = await caller().board({
          profileSlug: "decision",
          workspaceId: ws,
        });
        // The card's door opens this board: the two counts are one count.
        expect(sum(card.columns)).toBe(sum(board.columns));
      }
      const cardOf = (ws: string) =>
        sum(
          home.spaces
            .find((s) => s.workspaceId === ws)!
            .produces.find((p) => p.profileSlug === "decision")!.columns
        );
      expect(cardOf(beta)).toBe(2 + 3);
      expect(cardOf(MISC)).toBe(1 + 3);
      // The stored plural is lower-case and hyphenated ("follow-ups", as a
      // person typed it): sentence-cased like "Deals", hyphen kept — never
      // humanized as a slug ("Follow ups").
      expect(
        home.spaces
          .find((s) => s.workspaceId === beta)!
          .produces.find((p) => p.profileSlug === "decision")!.plural
      ).toBe("Follow-ups");
      // Inference reads OWNED rows only: pod-wide decisions never make
      // Gamma (or a Finance / Foundation) a producer of decisions.
      expect(
        home.spaces
          .find((s) => s.workspaceId === gamma)
          ?.produces.some((p) => p.profileSlug === "decision") ?? false
      ).toBe(false);
      expect("podWide" in home).toBe(false);
    } finally {
      await q(
        `update entities set deleted_at = now() where id = any($1::uuid[])`,
        [rows]
      );
      await q(
        `update workspaces set archived_at = now() where id = any($1::uuid[])`,
        [[beta, gamma]]
      );
    }
  });
});

describe("lifecycle.home cost (homes review Q-S4)", () => {
  /**
   * Reads one home issues: SQL queries PLUS the lifecycle declaration reads
   * (`getEffectiveLifecycle`, stubbed here, so each counts as ONE read — its
   * own internal queries are proven in its suites, not counted here). NOT
   * covered: the in-flight bound (`HOME_KIND_CONCURRENCY`) — this counts
   * reads, not their overlap.
   */
  async function homeQueries(): Promise<number> {
    const spy = vi.spyOn(h.client!, "query");
    try {
      spy.mockClear();
      h.lifecycleReads = 0;
      await caller().home();
      return spy.mock.calls.length + h.lifecycleReads;
    } finally {
      spy.mockRestore();
    }
  }

  it("RATCHET: each producing (space, kind) adds a bounded, constant number of queries", async () => {
    const extra: string[] = [];
    const producing = (name: string) =>
      space(name, {
        settings: {
          intent: { label: name, produces: ["deal"], source: "template" },
        },
      });
    try {
      const base = await homeQueries();
      extra.push(await producing("Extra one"));
      const one = await homeQueries();
      extra.push(await producing("Extra two"));
      const two = await homeQueries();
      expect(base).toBeGreaterThan(5); // non-vacuity: the spy sees drizzle's queries
      // Linear in the pairs, never super-linear …
      expect(two - one).toBe(one - base);
      // … and the per-pair cost never grows back.
      expect(one - base).toBeLessThanOrEqual(HOME_QUERIES_PER_KIND);
      expect(base).toBeLessThanOrEqual(HOME_QUERIES_FIXTURE);
      // Non-vacuity: the lifecycle declaration reads ARE in the count.
      expect(h.lifecycleReads).toBeGreaterThan(0);
    } finally {
      for (const id of extra)
        await q(`update workspaces set archived_at = now() where id = $1`, [
          id,
        ]);
    }
  });
});

/**
 * The ratchet's ceilings, measured on this fixture (Q-S4). Lower them when a
 * change earns it; raising one is a decision the commit message must name.
 */
// 2 SQL + 1 lifecycle declaration read (counted since the final review #6;
// it was there all along, the ratchet could not see it).
const HOME_QUERIES_PER_KIND = 3;
const HOME_QUERIES_FIXTURE = 26;

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

  it("asks you = THE needs-you owed predicate: a draft's owed slot never asks you (Q-S3)", async () => {
    await q(`update focus_sessions set status = 'closed'`);
    const draft = await session({
      subject: T.fresh,
      owes: true,
      origin: "agent",
      mins: 3,
      title: "Draft asks",
    });
    const mine = await session({
      subject: T.neg,
      owes: true,
      mins: 4,
      title: "Mine asks",
    });
    try {
      const { items } = await caller().moving();
      const work = new Map(
        items.flatMap((i) => i.work).map((w) => [w.sessionId, w])
      );
      expect(work.get(mine)?.asksYou).toBe(true);
      // The count never counts a draft (`excludeDrafts`), so neither does this.
      expect(work.get(draft)?.asksYou).toBe(false);

      // The home headline: the draft's thing is not "needs you".
      const home = await caller().home();
      const dealKind = home.spaces
        .find((s) => s.workspaceId === DEV)!
        .produces.find((p) => p.profileSlug === "deal")!;
      expect(dealKind.headline).toMatchObject({
        entityId: T.neg,
        reason: "needs_you",
      });
    } finally {
      await q(`update focus_sessions set status = 'closed'`);
    }
  });
});

describe("lifecycle.moving — unattached work (A7)", () => {
  it("open work sessions on NO thing: no subject, no worker target, no draft, narrowed by their space", async () => {
    await q(`update focus_sessions set status = 'closed'`);
    const plain = await session({ mins: 20, title: "Loose plain" });
    const asks = await session({ owes: true, mins: 30, title: "Loose asks" });
    const inMisc = await session({
      mins: 10,
      title: "Loose in misc",
      workspace: MISC,
    });
    // Not unattached: on a thing, a draft, closed, and a session whose work
    // targets a thing (the other "on" of Moving now).
    const onThing = await session({ subject: T.neg, mins: 5, title: "On" });
    const draft = await session({ origin: "agent", mins: 6, title: "Draft" });
    const closed = await session({ status: "closed", mins: 7 });
    const targets = await session({ mins: 8, title: "Targets a thing" });
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values (gen_random_uuid(),'session',$1,'entity',$2,'targets','{"role":"worker_target"}'::jsonb,now())`,
      [targets, T.stuck]
    );
    try {
      const all = await caller().moving();
      // Asks you first, then the most recently moved.
      expect(all.unattached.map((u) => u.sessionId)).toEqual([
        asks,
        inMisc,
        plain,
      ]);
      expect(all.unattached[0]).toMatchObject({
        label: "Loose asks",
        asksYou: true,
        live: false,
      });
      expect(all.unattached[1]!.asksYou).toBe(false);
      // Each line names its SESSION's space (null = none), so a space whose
      // only work is unattached still gets its Moving-now chip.
      expect(all.unattached.map((u) => u.workspaceId)).toEqual([
        null,
        MISC,
        null,
      ]);
      // A thing's work lines carry no space of their own (the item has it).
      expect(
        all.items.flatMap((i) => i.work).some((w) => "workspaceId" in w)
      ).toBe(false);
      const loose = all.unattached.map((u) => u.sessionId);
      for (const id of [onThing, draft, closed, targets])
        expect(loose).not.toContain(id);
      // The thing's work stays a Moving-now item, never a loose line.
      expect(
        all.items.flatMap((i) => i.work.map((w) => w.sessionId))
      ).toContain(onThing);

      const misc = await caller().moving({ workspaceId: MISC, limit: 30 });
      expect(misc.unattached.map((u) => u.sessionId)).toEqual([inMisc]);
      // Capped by the read's limit.
      const one = await caller().moving({ limit: 1 });
      expect(one.unattached).toHaveLength(1);
    } finally {
      await q(`update focus_sessions set status = 'closed'`);
    }
  });
});

describe("role-produced work + the access floor (homes review M1 / S7)", () => {
  it("home: a ROLE-produced kind reads the facets under the space's lens", async () => {
    const home = await caller().home();
    const crm = home.spaces.find((s) => s.workspaceId === CRM)!;
    expect(crm).toMatchObject({ label: "Pipeline", kind: "producing" });
    const lead = crm.produces[0]!;
    expect(lead.profileSlug).toBe("lead");
    // Alice (CRM) + Bob (pod-wide, visible in every lens); Carol's facet is
    // in a space the caller cannot see.
    expect(lead.columns.map((c) => [c.key, c.count])).toEqual([
      ["new", 1],
      ["qualified", 1],
      ["converted", 0],
    ]);
  });

  it("home: another user's private space is never listed", async () => {
    const ids = (await caller().home()).spaces.map((s) => s.workspaceId);
    expect(ids).not.toContain(HIDDEN);
  });

  it("moving: a lead names the FACET's stage, kind and space, never the person's", async () => {
    await q(`update focus_sessions set status = 'closed'`);
    await session({ subject: T.alice, mins: 5, title: "Qualify Alice" });
    await session({ subject: T.bob, mins: 6, title: "Call Bob" });
    await session({ subject: T.carol, mins: 7, title: "Carol" });
    await session({ subject: T.dave, mins: 8, title: "Dave" });
    try {
      const { items } = await caller().moving();
      const by = new Map(items.map((i) => [i.entityId, i]));
      expect(by.get(T.alice)).toMatchObject({
        profileSlug: "lead",
        workspaceId: CRM,
        status: "qualified",
        category: "active",
      });
      // Someone else's pod-wide facet is behind the facet owner floor.
      expect(by.get(T.dave)).toMatchObject({
        profileSlug: "person",
        workspaceId: MISC,
      });
      // The pod-wide facet sits in the space that produces the role.
      expect(by.get(T.bob)).toMatchObject({
        profileSlug: "lead",
        workspaceId: CRM,
        status: "new",
        category: "open",
      });
      // Carol's lead facet is invisible: she moves as what she is.
      expect(by.get(T.carol)).toMatchObject({
        profileSlug: "person",
        workspaceId: MISC,
        status: null,
      });

      // The Sales chip narrows server-side to the facet's space.
      const inCrm = await caller().moving({ workspaceId: CRM, limit: 30 });
      expect(inCrm.items.map((i) => i.entityId).sort()).toEqual(
        [T.alice, T.bob].sort()
      );
      const inMisc = await caller().moving({ workspaceId: MISC, limit: 30 });
      expect(inMisc.items.map((i) => i.entityId).sort()).toEqual(
        [T.carol, T.dave].sort()
      );
    } finally {
      await q(`update focus_sessions set status = 'closed'`);
    }
  });

  it("moving: a readable session on a thing the caller cannot read is not listed", async () => {
    await q(`update focus_sessions set status = 'closed'`);
    await session({ subject: T.hidden, mins: 2 });
    await session({ subject: T.fresh, mins: 3 });
    try {
      const ids = (await caller().moving()).items.map((i) => i.entityId);
      expect(ids).toEqual([T.fresh]);
    } finally {
      await q(`update focus_sessions set status = 'closed'`);
    }
  });
});

/**
 * Home's LAST SEEN is pod-side (0333), so "while you were away" follows the
 * person across devices: `preferences.markHomeSeen` stamps it (server time),
 * `lifecycle.home` returns it. Driven through both real routers on PGlite.
 */
describe("home: last seen, on the pod", () => {
  const prefs = (userId: string) =>
    preferencesRouter.createCaller({
      db: pgDb,
      authenticated: true,
      userId,
      workspaceId: null,
    } as never);

  it("never stamped → null; markHomeSeen → the next home read returns that stamp", async () => {
    await q(`delete from user_preferences`);
    expect((await caller().home()).homeLastSeenAt).toBeNull();

    const before = Date.now();
    const { homeLastSeenAt } = await prefs(USER).markHomeSeen();
    expect(Date.parse(homeLastSeenAt)).toBeGreaterThanOrEqual(before);
    expect((await caller().home()).homeLastSeenAt).toBe(homeLastSeenAt);
  });

  it("is per person: another user's stamp never reaches this home", async () => {
    await q(`delete from user_preferences`);
    await prefs("someone-else").markHomeSeen();
    expect((await caller().home()).homeLastSeenAt).toBeNull();
  });
});
