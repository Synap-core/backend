/**
 * FB1020 review M3 (security, multi-user pods) — the capture door's duplicate
 * check only ever sees rows the CALLER can see.
 *
 * THE DEFECT: the weak scope was `workspace OR isNull(workspaceId)`, and
 * `entities` is owner-private: a NULL workspace means "personal to its
 * owner", so the scope admitted EVERY user's pod-personal rows. Since B2 each
 * hit is a named candidate persisted on the proposal and returned on the
 * receipt — another user's record title, leaked. The strong-identity link had
 * no visibility gate at all: the graph was wired to another user's record.
 *
 * Driven through the REAL `submitCaptureGraph`, the REAL duplicate door and
 * the REAL `resolveIdentity` SQL on PGlite (every table). Stubbed: workspace
 * placement, the agent-governance verdict (execute) and the two terminal
 * writers + the materializer, which are what the outcome is observed through.
 *
 * Rows, each ruling out a wrong rule:
 *  - another user's pod-personal same-name record is NOT a candidate (rules
 *    out the owner-blind NULL branch);
 *  - another user's record with the same email is NOT linked (rules out the
 *    ungated strong link);
 *  - CONTROLS: the caller's OWN same-name record is still a candidate, and
 *    the caller's own same-email record is still linked (rules out a floor
 *    that sees nothing).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
    resolveGraphWorkspaceFromSlugs: vi.fn(async () => ({
      workspaceId: null,
      rung: 6,
      reason: "pod-wide",
      confidence: 1,
      candidates: [],
      ask: false,
    })),
  };
});
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-identity-service.js")>()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi
    .fn()
    .mockResolvedValue({ decision: "execute" }),
}));
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileResolutionService } from "@synap/database";

const { submitCaptureGraph } = await import("./submit-capture-graph.js");
const writer = await import("../../utils/event-backed-proposal.js");
const materializer = await import("../../utils/materialize-composite.js");
const dedup = await import("../../utils/pending-capture-dedup.js");

const USER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const THEIR_JANE = randomUUID();
const THEIR_GRACE = randomUUID();
const MY_MIA = randomUUID();
const MY_RHEA = randomUUID();

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
  // Pod-personal records (workspace NULL): two are the OTHER user's.
  for (const [id, owner, title] of [
    [THEIR_JANE, OTHER, "Jane Doe"],
    [THEIR_GRACE, OTHER, "Grace Private"],
    [MY_MIA, USER, "Mia Mine"],
    [MY_RHEA, USER, "Rhea Mine"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, type, title, properties, workspace_id, created_at)
       values ($1,$2,'person',$3,'{}'::jsonb,null, now() - interval '1 day')`,
      [id, owner, title]
    );
  }
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source)
     values (gen_random_uuid(),$1,'email','grace@private.test','seed'),
            (gen_random_uuid(),$2,'email','rhea@mine.test','seed')`,
    [THEIR_GRACE, MY_RHEA]
  );
}, 120_000);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(null as never);
  vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
});

async function capture(entity: Record<string, unknown>) {
  const pending = vi
    .spyOn(writer, "createEventBackedProposal")
    .mockImplementation(async (input) => ({
      proposal: { id: "prop-1", data: input.data } as never,
      requestedEvent: null,
      correlationId: "c",
    }));
  const receipt = vi
    .spyOn(writer, "createAutoApprovedProposal")
    .mockImplementation(
      async (input) =>
        ({
          proposal: { id: input.id, data: input.data } as never,
          requestedEvent: null,
          completedEvent: null,
          correlationId: "c",
        }) as never
    );
  const materialize = vi
    .spyOn(materializer, "materializeCompositeGraph")
    .mockResolvedValue({
      entities: [{ ref: "p1", entityId: "ent-new", linked: false }],
      relations: [],
      relationsFailed: [],
      created: 1,
    } as never);
  const result = await submitCaptureGraph({
    userId: USER,
    agentUserId: AGENT,
    workspaceId: null,
    entities: [
      { ref: "p1", profileSlug: "person", properties: {}, ...entity },
    ] as never,
  } as never);
  const filed = pending.mock.calls[0]?.[0] ?? receipt.mock.calls[0]?.[0];
  const data = (filed?.data ?? {}) as {
    duplicateCheck?: { status: string; candidates: Array<{ id: string }> };
    operations?: Array<{ existingEntityId?: string }>;
  };
  return { result, data, materialize };
}

describe("the capture door's duplicate check sees only the caller's rows (M3)", () => {
  it("another user's pod-personal same-name record is never a candidate", async () => {
    const { data, result } = await capture({ title: "Jane Doe" });
    expect(JSON.stringify(data.duplicateCheck)).not.toContain(THEIR_JANE);
    expect(data.duplicateCheck?.status).toBe("clear");
    expect(result.applied).toBe(true);
  });

  it("another user's record with the same email is never linked", async () => {
    const { materialize, data } = await capture({
      title: "G. Hopper",
      properties: { email: "grace@private.test" },
    });
    const ops = materialize.mock.calls[0]![0] as Array<{
      existingEntityId?: string;
    }>;
    expect(ops[0]!.existingEntityId).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(THEIR_GRACE);
  });

  it("CONTROL — the caller's OWN same-name record is still a candidate", async () => {
    const { data } = await capture({ title: "Mia Mine" });
    expect(data.duplicateCheck?.status).toBe("possible");
    expect(data.duplicateCheck?.candidates).toEqual([
      expect.objectContaining({ id: MY_MIA }),
    ]);
  });

  it("CONTROL — the caller's own same-email record is still linked", async () => {
    const { materialize } = await capture({
      title: "R. Mine",
      properties: { email: "rhea@mine.test" },
    });
    const ops = materialize.mock.calls[0]![0] as Array<{
      existingEntityId?: string;
    }>;
    expect(ops[0]!.existingEntityId).toBe(MY_RHEA);
  });
});
