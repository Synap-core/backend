/**
 * POD DEFAULT 1 — "roll up along a relation" (plan 7d71ddcc W3, decisions
 * D3, D5, D6), end to end on PGlite: a part moves through THE thing's door
 * (`moveStatus`), the reactions job (`handleReactions`, the one reactor)
 * reads that move off the outbox, lists the rules — the roll-up a relation
 * DECLARES (`profile_relations.metadata.reactions`, `relationReactionSource`)
 * — runs the guards, and the `roll_up` effect moves (or proposes) the parent
 * through the same door, with the reaction's `cause`.
 *
 *  - D5: a lost part is ignored; at least one part must be done; an open part
 *    holds the parent;
 *  - D3: the parent's move into done is PROPOSED by default — the pod files
 *    it (`createdBy: system:reactions`) with its `cause`; `terminal: "apply"`
 *    moves it;
 *  - every level: the parent's move rolls ITS parent up when the rule chains,
 *    and not when it does not (`not_chained`, logged);
 *  - a person's move wins: a parent moved after the plan read it is skipped
 *    `moved_meanwhile`, nothing overwritten;
 *  - a paused rule (its rule row a draft, the person's pause) is skipped and
 *    logged;
 *  - include "reactions": the parent reads its roll-up with "2 of 2 done",
 *    the part reads the rule that fires when it moves.
 *
 * Real: the status door and the gate, the outbox, the reactor's job and
 * guards, the declared source, the effect, the reaction log, the parts
 * reader. Stubbed: post-commit delivery only (as status-move-grant).
 *
 * NEGATIVE CONTROL: on the `-negctl` branch `rollupProgress` counts a lost
 * part as open — "a lost part is ignored" fails (the campaign never moves).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
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
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction's body on the handle.
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { AnyTransitionPayload } from "@synap-core/types/lifecycle";
import {
  listReactions,
  registerReactionSource,
  registerReactionStateSource,
  resetReactionRegistryForTests,
} from "@synap/jobs/utils/reactions.js";
import {
  registerReactionEffect,
  resetReactionEffectsForTests,
} from "@synap/jobs/utils/reaction-effects.js";
import { handleReactions } from "@synap/jobs/workers/reactions.js";
import { moveStatus } from "../../lifecycle/move-status.js";
import {
  REACTION_PROPOSAL_AUTHOR,
  rollUpReactionEffect,
} from "../roll-up-effect.js";
import {
  relationReactionSource,
  relationRollupId,
} from "../relation-reactions.js";
import { reactionEnabledStates } from "../reaction-rule-rows.js";
import { readStatusReactions } from "../../status/status-reactions.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const POST = randomUUID();
const CAMPAIGN = randomUUID();
const SERIES = randomUUID();
const POST_STATUS = randomUUID();
const CAMPAIGN_STATUS = randomUUID();
const SERIES_STATUS = randomUUID();
const PART_OF = randomUUID();

const POST_RULE = relationRollupId({
  relationDefId: PART_OF,
  sourceProfileId: POST,
  targetProfileId: CAMPAIGN,
});
const CAMPAIGN_RULE = relationRollupId({
  relationDefId: PART_OF,
  sourceProfileId: CAMPAIGN,
  targetProfileId: SERIES,
});

const SLUG: Record<string, string> = {
  [POST]: "post_status",
  [CAMPAIGN]: "campaign_status",
  [SERIES]: "series_status",
};
const CATEGORY: Record<string, string> = {
  idea: "open",
  writing: "active",
  published: "done",
  dropped: "lost",
  draft: "open",
  live: "active",
  complete: "done",
  cancelled: "lost",
  planned: "open",
  running: "active",
  finished: "done",
};

async function thing(profileId: string, status: string): Promise<string> {
  const id = randomUUID();
  const type =
    profileId === POST
      ? "post"
      : profileId === CAMPAIGN
        ? "campaign"
        : "series";
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, $3, $4, $5, null, $6, $7, $8::jsonb, now(), now())`,
    [
      id,
      USER,
      type,
      profileId,
      `A ${type}`,
      status,
      CATEGORY[status],
      JSON.stringify({ [SLUG[profileId]!]: status }),
    ]
  );
  return id;
}

async function partOf(child: string, parent: string): Promise<void> {
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, source_kind, target_kind, type, metadata, created_at)
     values (gen_random_uuid(), $1, null, $2, $3, 'entity', 'entity', 'part_of', '{}'::jsonb, now())`,
    [USER, child, parent]
  );
}

/** What the pair declares (the link's `metadata.reactions`). */
async function declare(
  source: string,
  target: string,
  reactions: unknown[] | null
): Promise<void> {
  await q(
    `update profile_relations set metadata = $4::jsonb
      where source_profile_id = $1 and target_profile_id = $2 and relation_def_id = $3`,
    [
      source,
      target,
      PART_OF,
      JSON.stringify(reactions === null ? {} : { reactions }),
    ]
  );
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

/** A move made through THE door; its transition, as the outbox holds it. */
async function move(id: string, to: string): Promise<AnyTransitionPayload> {
  const r = await moveStatus({
    entityId: id,
    to,
    actor: { kind: "system", userId: USER },
  });
  expect(r.status, JSON.stringify(r)).toBe("moved");
  return (r as { transition: AnyTransitionPayload }).transition;
}

/** The newest move of a thing, off the outbox (the reactor's own read). */
async function lastMoveOf(id: string): Promise<AnyTransitionPayload> {
  const rows = await q<{ transition: AnyTransitionPayload | string }>(
    `select transition from lifecycle_transition_outbox
      where transition->>'subjectId' = $1
      order by (transition->>'recordedAt') desc limit 1`,
    [id]
  );
  const t = rows.rows[0]!.transition;
  return typeof t === "string" ? JSON.parse(t) : t;
}

const logOf = async (reactionId: string) =>
  (
    await q<{ type: string; data: Record<string, unknown> }>(
      `select type, data from events where subject_type = 'reaction' and subject_id = $1 order by timestamp`,
      [reactionId]
    )
  ).rows;

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'post', 'Post', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($2, 'campaign', 'Campaign', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($3, 'series', 'Series', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [POST, CAMPAIGN, SERIES]
  );
  const options = (keys: string[]) =>
    JSON.stringify({
      enumOptions: keys.map((key) => ({
        key,
        label: key,
        category: CATEGORY[key],
      })),
    });
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'post_status', 'enum', $2::jsonb, now(), now()),
            ($3, 'campaign_status', 'enum', $4::jsonb, now(), now()),
            ($5, 'series_status', 'enum', $6::jsonb, now(), now())`,
    [
      POST_STATUS,
      options(["idea", "writing", "published", "dropped"]),
      CAMPAIGN_STATUS,
      options(["draft", "live", "complete", "cancelled"]),
      SERIES_STATUS,
      options(["planned", "running", "finished"]),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true), ($3, $4, true), ($5, $6, true)`,
    [POST, POST_STATUS, CAMPAIGN, CAMPAIGN_STATUS, SERIES, SERIES_STATUS]
  );
  await q(
    `insert into relation_defs (id, slug, display_name, workspace_id, user_id, ui_hints, is_directional, created_at, updated_at)
     values ($1, 'part_of', 'Part of', null, $2, '{}'::jsonb, true, now(), now())`,
    [PART_OF, USER]
  );
  await q(
    `insert into profile_relations (source_profile_id, target_profile_id, relation_def_id, display_order, metadata)
     values ($1, $2, $5, 0, '{}'::jsonb), ($3, $4, $5, 0, '{}'::jsonb)`,
    [POST, CAMPAIGN, CAMPAIGN, SERIES, PART_OF]
  );
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from proposals; delete from events; delete from skills; delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  resetReactionRegistryForTests();
  resetReactionEffectsForTests();
  registerReactionSource(relationReactionSource);
  registerReactionEffect(rollUpReactionEffect);
  await declare(POST, CAMPAIGN, null);
  await declare(CAMPAIGN, SERIES, null);
});

describe("the declaration joins the one list", () => {
  it("a declared roll-up is a rule: on a post's done or lost, via part_of, in words", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup" }]);
    const rule = (await listReactions()).find((r) => r.id === POST_RULE);
    expect(rule).toMatchObject({
      source: "declared",
      enabled: true,
      when: {
        subjectType: "entity",
        category: ["done", "lost"],
        profileSlug: ["post"],
      },
      via: { link: "relation", relation: "part_of", parent: "target" },
      do: { effect: "roll_up" },
    });
    expect(rule!.title).toBe(
      "When every post part of a campaign is done, the campaign moves to its next status"
    );
  });
});

describe("D5 — the parent moves when every non-lost part is done", () => {
  it("a lost part is ignored: the last open part done moves the campaign (terminal: apply), with the cause", async () => {
    await declare(POST, CAMPAIGN, [
      { kind: "rollup", terminal: "apply", terminalWhy: "Trusted." },
    ]);
    const c = await thing(CAMPAIGN, "live");
    const done = await thing(POST, "published");
    const dropped = await thing(POST, "dropped");
    const last = await thing(POST, "writing");
    for (const p of [done, dropped, last]) await partOf(p, c);

    const t = await move(last, "published");
    const r = await handleReactions({ transitionId: t.transitionId });

    expect(r).toMatchObject({ applied: 1, proposed: 0 });
    expect(await statusOf(c)).toBe("complete");
    const moved = await lastMoveOf(c);
    expect(moved.cause).toMatchObject({
      reactionId: POST_RULE,
      transitionId: t.transitionId,
      chainId: t.transitionId,
      depth: 1,
    });
    expect((await logOf(POST_RULE)).map((l) => l.type)).toEqual([
      "reaction.applied",
    ]);
  });

  it("no part done (all lost): nothing moves", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    const c = await thing(CAMPAIGN, "live");
    const a = await thing(POST, "dropped");
    const b = await thing(POST, "writing");
    for (const p of [a, b]) await partOf(p, c);

    const t = await move(b, "dropped");
    const r = await handleReactions({ transitionId: t.transitionId });

    expect(r.applied).toBe(0);
    expect(await statusOf(c)).toBe("live");
  });

  it("an open part holds the parent", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    const c = await thing(CAMPAIGN, "live");
    const a = await thing(POST, "writing");
    const b = await thing(POST, "writing");
    for (const p of [a, b]) await partOf(p, c);

    const t = await move(a, "published");
    await handleReactions({ transitionId: t.transitionId });
    expect(await statusOf(c)).toBe("live");
  });
});

describe("D3 — the parent's move into done is proposed by default", () => {
  it("the pod files it for the person, with the cause; the campaign stays where it is", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup" }]);
    const c = await thing(CAMPAIGN, "live");
    const p = await thing(POST, "writing");
    await partOf(p, c);

    const t = await move(p, "published");
    const r = await handleReactions({ transitionId: t.transitionId });

    expect(r).toMatchObject({ applied: 0, proposed: 1 });
    expect(await statusOf(c)).toBe("live");
    const filed = await q<{
      status: string;
      created_by: string;
      subject_user_id: string | null;
      data: Record<string, unknown>;
    }>(
      `select status, created_by, subject_user_id, data from proposals where target_id = $1`,
      [c]
    );
    expect(filed.rows).toHaveLength(1);
    const row = filed.rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.created_by).toBe(REACTION_PROPOSAL_AUTHOR);
    const inner = (row.data.data ?? row.data) as Record<string, unknown>;
    expect(inner).toMatchObject({
      entityId: c,
      to: "complete",
      expectedFrom: "live",
      cause: { reactionId: POST_RULE, depth: 1 },
    });
    expect((await logOf(POST_RULE)).map((l) => l.type)).toEqual([
      "reaction.proposed",
    ]);
  });

  it("a move that is not into done or lost applies (next status: draft → live)", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup" }]);
    const c = await thing(CAMPAIGN, "draft");
    const p = await thing(POST, "writing");
    await partOf(p, c);

    const t = await move(p, "published");
    await handleReactions({ transitionId: t.transitionId });
    expect(await statusOf(c)).toBe("live");
  });
});

describe("every level — a parent's move rolls up its own parent", () => {
  it("when the rule chains: post → campaign → series, the cause one deeper", async () => {
    await declare(POST, CAMPAIGN, [
      { kind: "rollup", terminal: "apply", chains: true },
    ]);
    await declare(CAMPAIGN, SERIES, [
      { kind: "rollup", to: "finished", terminal: "apply" },
    ]);
    const s = await thing(SERIES, "running");
    const c = await thing(CAMPAIGN, "live");
    const p = await thing(POST, "writing");
    await partOf(c, s);
    await partOf(p, c);

    const t = await move(p, "published");
    await handleReactions({ transitionId: t.transitionId });
    expect(await statusOf(c)).toBe("complete");
    const campaignMove = await lastMoveOf(c);
    await handleReactions({ transitionId: campaignMove.transitionId });

    expect(await statusOf(s)).toBe("finished");
    expect((await lastMoveOf(s)).cause).toMatchObject({
      reactionId: CAMPAIGN_RULE,
      chainId: t.transitionId,
      depth: 2,
    });
  });

  it("not when it does not chain: the next level is skipped not_chained, logged", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    await declare(CAMPAIGN, SERIES, [
      { kind: "rollup", to: "finished", terminal: "apply" },
    ]);
    const s = await thing(SERIES, "running");
    const c = await thing(CAMPAIGN, "live");
    const p = await thing(POST, "writing");
    await partOf(c, s);
    await partOf(p, c);

    const t = await move(p, "published");
    await handleReactions({ transitionId: t.transitionId });
    await handleReactions({ transitionId: (await lastMoveOf(c)).transitionId });

    expect(await statusOf(s)).toBe("running");
    const log = await logOf(CAMPAIGN_RULE);
    expect(log.map((l) => [l.type, l.data.code])).toEqual([
      ["reaction.skipped", "not_chained"],
    ]);
  });
});

describe("a person's move wins (D6)", () => {
  it("a parent moved after the plan read it is skipped moved_meanwhile", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    const c = await thing(CAMPAIGN, "live");
    const p = await thing(POST, "writing");
    await partOf(p, c);
    const t = await move(p, "published");
    const rule = (await listReactions()).find((r) => r.id === POST_RULE)!;

    const [write] = await rollUpReactionEffect.plan(t, rule);
    expect(write).toMatchObject({ to: "complete", expectedFrom: "live" });
    await move(c, "cancelled");
    const out = await rollUpReactionEffect.apply(write!, {
      transition: t,
      reaction: rule,
      cause: {
        reactionId: rule.id,
        transitionId: t.transitionId,
        chainId: t.transitionId,
        depth: 1,
      },
    });

    expect(out.status).toBe("moved_meanwhile");
    expect(await statusOf(c)).toBe("cancelled");
  });
});

describe("the person's pause", () => {
  it("a rule whose row is a draft is skipped paused, logged, nothing moved", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    await q(
      `insert into skills (id, user_id, name, category, kind, scope, status, approved, metadata)
       values (gen_random_uuid(), $1, 'rule', 'rule', 'instruction', 'pod', 'active', true, $2::jsonb)`,
      [
        USER,
        JSON.stringify({
          rule: {
            v: 1,
            intent: "x",
            scope: { kind: "pod" },
            draft: true,
            behaviours: [],
            reaction: { id: POST_RULE },
          },
        }),
      ]
    );
    registerReactionStateSource(() => reactionEnabledStates());
    const c = await thing(CAMPAIGN, "live");
    const p = await thing(POST, "writing");
    await partOf(p, c);

    const t = await move(p, "published");
    await handleReactions({ transitionId: t.transitionId });

    expect(await statusOf(c)).toBe("live");
    expect((await logOf(POST_RULE)).map((l) => l.data.code)).toEqual([
      "paused",
    ]);
  });
});

describe('statusOf include "reactions"', () => {
  it("the parent reads the roll-up that moves it, its parts' progress and its last outcome; the part reads the rule it fires", async () => {
    await declare(POST, CAMPAIGN, [{ kind: "rollup", terminal: "apply" }]);
    const c = await thing(CAMPAIGN, "live");
    const a = await thing(POST, "published");
    const b = await thing(POST, "dropped");
    const last = await thing(POST, "writing");
    for (const p of [a, b, last]) await partOf(p, c);
    const t = await move(last, "published");
    await handleReactions({ transitionId: t.transitionId });

    const read = await readStatusReactions(USER, [
      { id: c, type: "entity", profileId: CAMPAIGN },
      { id: last, type: "entity", profileId: POST },
    ]);

    expect(read.get(c)).toEqual([
      expect.objectContaining({
        ruleId: POST_RULE,
        role: "moves",
        source: "relation",
        paused: false,
        terminal: "apply",
        progress: expect.objectContaining({
          done: 2,
          of: 2,
          lost: 1,
          ready: true,
          label: "2 of 2 done · 1 dropped",
        }),
        last: expect.objectContaining({ outcome: "applied" }),
      }),
    ]);
    expect(read.get(last)).toEqual([
      expect.objectContaining({
        ruleId: POST_RULE,
        role: "fires",
        whenWords: "A post moves to done or lost",
      }),
    ]);
  });
});
