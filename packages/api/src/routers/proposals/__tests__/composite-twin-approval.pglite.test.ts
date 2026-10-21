/**
 * FB1020 BLOCKER-2 — an agent capture that names an existing record can be
 * approved.
 *
 * THE DEFECT: since B2 the capture door files a same-name twin as `possible`
 * (with the candidate on the card) instead of weak-linking it. Every
 * composite approval passed `approvalDuplicate: "ask_reviewer"` per op, and
 * `entities.create` then refused EVERY twin with ENTITY_WEAK_DEDUP unless the
 * client sent `identityResolutionByRef` — which no client sent. So the
 * commonest agent write could only be rejected.
 *
 * THE RULE (one, for the composite and the single executor): an item with no
 * verb keeps both for the twin records its card SHOWED (the reviewer saw
 * "looks like X" and approved as proposed); a twin the card never showed
 * refuses so the card asks; a strong identity match still merges; a verb in
 * `identityResolutionByRef` wins.
 *
 * Driven through the REAL `proposals.approve` → `applyProposalApproval` →
 * `materializeCompositeGraph` → `entities.create` → the duplicate door, with
 * the REAL gate (not mocked), on PGlite with every table. Stubbed: review
 * authority (the approver may approve) and delivery side effects.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    eventRepository: new Proxy(
      {},
      { get: () => async () => ({ id: randomUUID() }) }
    ),
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock(
  "../review-authority.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
  })
);
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 1,
    lastPeerGeneration: 0,
    lastPeerContact: null,
  })),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const USER = randomUUID();
const AGENT = randomUUID();
const PERSON_PROFILE = randomUUID();
let client: PGlite;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params);

async function person(title: string, email?: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, created_at)
     values ($1,$2,null,'person',$3,$4,'{}'::jsonb, now() - interval '1 day')`,
    [id, USER, PERSON_PROFILE, title]
  );
  if (email) {
    await q(
      `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source)
       values (gen_random_uuid(),$1,'email',$2,'seed')`,
      [id, email]
    );
  }
  return id;
}

const countTitled = async (title: string) =>
  (
    await q(`select id from entities where title = $1 and deleted_at is null`, [
      title,
    ])
  ).rows.length;

/** An agent's pending capture graph, the shape `submitCaptureGraph` files. */
async function pendingCapture(
  op: Record<string, unknown>,
  shown: Array<{ id: string; title: string }>
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, agent_user_id, subject_user_id)
     values ($1,'pending','capture.graph','entity',$2,$3::jsonb,$4,$4,$5)`,
    [
      id,
      randomUUID(),
      JSON.stringify({
        operations: [
          {
            op: "create_entity",
            ref: "p1",
            profileSlug: "person",
            properties: {},
            ...op,
          },
        ],
        source: "intelligence",
        duplicateCheck: {
          status: shown.length > 0 ? "possible" : "clear",
          subject: "entity",
          candidates: shown.map((s) => ({
            ref: "record",
            id: s.id,
            kind: "person",
            title: s.title,
            why: "same_name",
            forRef: "p1",
            forTitle: op.title,
          })),
        },
      }),
      AGENT,
      USER,
    ]
  );
  return id;
}

async function approve(
  proposalId: string,
  extra: Record<string, unknown> = {}
) {
  const { proposalsRouter } = await import("../../proposals.js");
  return proposalsRouter
    .createCaller({
      db: holder.db,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never)
    .approve({ proposalId, ...extra } as never) as Promise<{
    success?: boolean;
  }>;
}

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await q(
    `insert into users (id, email, user_type) values ($1,'owner@x.test','human')`,
    [USER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,'agent@x.test','agent',$2)`,
    [AGENT, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values ($1,'person','Person','kind','system','pod',null,true,'{}'::jsonb)`,
    [PERSON_PROFILE]
  );
  holder.db = drizzle(client, { schema });
}, 120_000);

describe("approving a capture that names an existing record (BLOCKER-2)", () => {
  it("a plain approve on a twin the card SHOWED keeps both", async () => {
    const ada = await person("Ada Lovelace");
    const proposalId = await pendingCapture({ title: "Ada Lovelace" }, [
      { id: ada, title: "Ada Lovelace" },
    ]);
    const res = await approve(proposalId);
    expect(res.success).toBe(true);
    expect(await countTitled("Ada Lovelace")).toBe(2);
  });

  it("a twin the card did NOT show refuses, so the card asks — nothing lands", async () => {
    await person("Bea Late");
    const proposalId = await pendingCapture({ title: "Bea Late" }, []);
    await expect(approve(proposalId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await countTitled("Bea Late")).toBe(1);
  });

  it("a verb sent as identityResolutionByRef wins: keep_existing creates nothing", async () => {
    const cy = await person("Cy Twin");
    const proposalId = await pendingCapture({ title: "Cy Twin" }, [
      { id: cy, title: "Cy Twin" },
    ]);
    const res = await approve(proposalId, {
      identityResolutionByRef: {
        p1: { verb: "keep_existing", existingEntityId: cy },
      },
    });
    expect(res.success).toBe(true);
    expect(await countTitled("Cy Twin")).toBe(1);
  });

  it("a graph naming SIX existing records is approvable: each item keeps its own twin on the card (B1)", async () => {
    // The persisted answer comes from the REAL door per item and the REAL
    // merge, exactly as `submitCaptureGraph` builds it. A graph-wide cap of 5
    // dropped item 6's twin, so every approve refused with ENTITY_WEAK_DEDUP.
    const { and, entities, isNull, ownerPrivateVisibleWhere } = await import(
      "@synap/database"
    );
    const { findDuplicateCandidates, mergeDuplicateChecks } = await import(
      "../../../services/duplicates/find-duplicate-candidates.js"
    );
    const names = Array.from({ length: 6 }, (_, i) => `Sixfold Twin ${i + 1}`);
    for (const name of names) await person(name);
    const checks = [];
    for (const [i, title] of names.entries()) {
      const answer = await findDuplicateCandidates(holder.db as never, {
        subject: "entity",
        userId: USER,
        profileSlug: "person",
        title,
        signals: [],
        recordScope: and(
          ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, USER),
          isNull(entities.workspaceId)
        ),
        forRef: `p${i + 1}`,
      });
      checks.push(answer.check);
    }
    const duplicateCheck = mergeDuplicateChecks("entity", checks);
    // Non-vacuity: the door found every item's twin before the merge.
    expect(checks.map((c) => c.candidates.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(
      new Set(duplicateCheck.candidates.map((c) => c.forRef)),
      "every proposed item shows its own twin"
    ).toEqual(new Set(names.map((_, i) => `p${i + 1}`)));

    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, agent_user_id, subject_user_id)
       values ($1,'pending','capture.graph','entity',$2,$3::jsonb,$4,$4,$5)`,
      [
        proposalId,
        randomUUID(),
        JSON.stringify({
          operations: names.map((title, i) => ({
            op: "create_entity",
            ref: `p${i + 1}`,
            profileSlug: "person",
            properties: {},
            title,
          })),
          source: "intelligence",
          duplicateCheck,
        }),
        AGENT,
        USER,
      ]
    );
    const res = await approve(proposalId);
    expect(res.success).toBe(true);
    for (const name of names) expect(await countTitled(name)).toBe(2);
  });

  it("a strong identity twin merges, card or not", async () => {
    const rhea = await person("Rhea Real", "rhea@real.test");
    const proposalId = await pendingCapture(
      { title: "R. Real", properties: { email: "rhea@real.test" } },
      []
    );
    const res = await approve(proposalId);
    expect(res.success).toBe(true);
    expect(await countTitled("R. Real")).toBe(0);
    expect(await countTitled("Rhea Real")).toBe(1);
    expect(rhea).toBeTruthy();
  });
});
