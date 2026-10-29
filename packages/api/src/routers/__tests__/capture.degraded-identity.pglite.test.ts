/**
 * A DEGRADED capture still looks at who the text names (issue 1c252b3b, B-W2).
 *
 * THE DEFECT: when the structurer gave no plan, `capture.structure` returned
 * its raw-note fallback BEFORE step "matching": "Met Léa Martin
 * (lea@acme.test) about the renewal" filed a note with `dedupCandidates: {}`
 * and no word about the Léa Martin already in the pod.
 *
 * Driven through the REAL `capture.structure` (IS answering null), the REAL
 * identity pass, the REAL duplicate door and the REAL `resolveIdentity` SQL on
 * PGlite (every table). Stubbed at module boundaries only: the IS client,
 * profiles, placement, context assembly, search, routing memory, relation
 * types, embeddings, the read-only guard and intake recording.
 *
 * Rows, each ruling out a wrong rule:
 *  - the caller's own person named by email in the text is a MENTION (rules
 *    out "no identity pass on the degraded path");
 *  - another user's person with the same email is NOT (rules out the
 *    pod-wide strong index leaking a record the caller cannot see);
 *  - a caller-named `person` whose fallback title twins the caller's own
 *    person is a dedup candidate; another user's same-name person is not;
 *  - R6: nothing is linked — the fallback has no `existingEntityId` and no
 *    relation, whatever matched.
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
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    ProfileResolutionService: class {
      async getAccessibleProfiles() {
        return [
          {
            id: "p-note",
            slug: "note",
            displayName: "Note",
            profileKind: "kind",
          },
          {
            id: "p-person",
            slug: "person",
            displayName: "Person",
            profileKind: "kind",
          },
        ];
      }
      async getEffectiveLifecycles() {
        return new Map();
      }
      async getEffectiveProperties() {
        return [];
      }
    },
    resolveWorkspacePlacement: async () => ({
      candidates: [],
      rung: 6,
      workspaceId: null,
      reason: "no ontology signal",
      confidence: null,
    }),
    assembleStructureContext: async () => ({
      instructions: undefined,
      guidelines: [],
      guidelineStatus: "ok",
    }),
  };
});
vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async () => ({
    client: { structure: async () => null },
  }),
}));
vi.mock("../../utils/is-structure-retry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // One attempt: the retry policy is not under test, and its backoff is slow.
  callStructureWithRetry: async (call: () => Promise<unknown>) => ({
    result: await call(),
    attempts: 1,
    lastReason: undefined,
  }),
}));
vi.mock("@synap/search", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchService: { searchCollection: async () => ({ results: [] }) },
}));
vi.mock("../../services/routing-memory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRoutingMemory: async () => undefined,
}));
vi.mock("../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEffectiveRelationTypes: async () => [],
}));
vi.mock(
  "../../services/retrieval/hybrid-recall.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    embedQuery: async () => ({ embedding: null }),
  })
);
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock(
  "../../services/intake/record-structure-intake.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordStructureIntake: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      intake: { requestedSessionIgnored: false },
    }),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const { captureRouter } = await import("../capture.js");

const USER = randomUUID();
const OTHER = randomUUID();
const MY_LEA = randomUUID();
const THEIR_PAUL = randomUUID();
const MY_ADA = randomUUID();
const THEIR_GRACE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, email, user_type) values ($1,'me@x','human'), ($2,'them@x','human')`,
    [USER, OTHER]
  );
  // Pod-personal people (workspace NULL): owner-private to their owner.
  for (const [id, owner, title] of [
    [MY_LEA, USER, "Léa Martin"],
    [THEIR_PAUL, OTHER, "Paul Private"],
    [MY_ADA, USER, "Ada Lovelace"],
    [THEIR_GRACE, OTHER, "Grace Hopper"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, type, title, properties, workspace_id, created_at)
       values ($1,$2,'person',$3,'{}'::jsonb,null, now() - interval '1 day')`,
      [id, owner, title]
    );
  }
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source)
     values (gen_random_uuid(),$1,'email','lea@acme.test','seed'),
            (gen_random_uuid(),$2,'email','paul@private.test','seed')`,
    [MY_LEA, THEIR_PAUL]
  );
}, 120_000);

const caller = captureRouter.createCaller({
  authenticated: true,
  userId: USER,
  workspaceId: null,
  sessionId: null,
  agentUserId: null,
} as never);

type Degraded = {
  degraded?: boolean;
  dedupSkipped?: boolean;
  proposals: Array<{ tempId: string; existingEntityId?: string }>;
  relations: unknown[];
  mentions?: Array<{ entityId: string; signal: string }>;
  dedupCandidates: Record<string, Array<{ entityId: string }>>;
};

async function degradedCapture(text: string, profileSlug?: string) {
  const out = (await caller.structure({
    text,
    ...(profileSlug ? { profileSlug } : {}),
  })) as Degraded;
  expect(out.degraded).toBe(true);
  return out;
}

describe("a degraded capture offers the records its text names (B-W2)", () => {
  it("the caller's own person, named by email, is a mention", async () => {
    const out = await degradedCapture(
      "Met Léa Martin <lea@acme.test> about the renewal"
    );
    expect(out.mentions).toEqual([
      expect.objectContaining({ entityId: MY_LEA, signal: "email" }),
    ]);
    expect(out.dedupSkipped).toBeUndefined();
  });

  it("another user's person with that email is never named", async () => {
    const out = await degradedCapture(
      "Lunch with Paul <paul@private.test> next week"
    );
    expect(out.mentions).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(THEIR_PAUL);
  });

  it("a caller-named person twinning the caller's own record is a candidate; a peer's is not", async () => {
    const mine = await degradedCapture("Ada Lovelace", "person");
    expect(mine.dedupCandidates.t1?.map((c) => c.entityId)).toEqual([MY_ADA]);

    const theirs = await degradedCapture("Grace Hopper", "person");
    expect(theirs.dedupCandidates.t1).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain(THEIR_GRACE);
  });

  it("R6: whatever matched, nothing is linked", async () => {
    const out = await degradedCapture(
      "Ada Lovelace — reach Léa at lea@acme.test",
      "person"
    );
    expect(out.mentions?.length).toBe(1);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]!.existingEntityId).toBeUndefined();
    expect(out.relations).toEqual([]);
  });
});
