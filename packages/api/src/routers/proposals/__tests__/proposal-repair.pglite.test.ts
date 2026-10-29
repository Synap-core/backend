/**
 * `proposals.repair` and `proposals.repairOptions` (decision fa6c8833): a
 * person repairs a FAILED entity proposal — use the value the pod says it
 * meant, pick another allowed one, or add the value to the field — and the
 * card then approves exactly the revision the repair made, through `approve`.
 *
 * SEAM: the REAL router procedures → the REAL authority ladder, the REAL
 * revise core and the REAL repair projection, on PGlite. Stubbed: the kind's
 * schema (`ProfileResolutionService` boundary), the property-def edit door
 * (recorded) and the executor dispatch after approve's gates (recorded).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  applied: [] as string[],
  defUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  // PGlite is ONE connection (see proposal-review-session-gate.pglite.test).
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../apply-approval.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyProposalApproval: async (args: { proposal: { id: string } }) => {
      h.applied.push(args.proposal.id);
      return { success: true };
    },
  };
});

vi.mock("../../../services/profiles/update-property-def.js", () => ({
  updatePropertyDef: async (input: Record<string, unknown>) => {
    h.defUpdates.push(input);
    return { propertyDef: { id: input.propertyDefId } };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "@synap/database";
import { proposalsRouter } from "../../proposals.js";

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
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const VIEWER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const CATEGORIES = ["working_style", "focus", "preferences", "habits"];

const human = (userId: string) => ({ authenticated: true, userId }) as never;
const caller = (userId: string) => proposalsRouter.createCaller(human(userId));

async function fileFailed(
  category: string,
  targetType = "entity"
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, data, revision_history, agent_user_id, created_by, rejection_reason, created_at, updated_at)
     values ($1, 'approval_failed', 'create', $2, $3, $4, $5::jsonb, '[]'::jsonb, $6, $7, 'Couldn''t apply — some of the details aren''t valid.', now(), now())`,
    [
      id,
      targetType,
      randomUUID(),
      WS,
      JSON.stringify({
        requestId: randomUUID(),
        targetType,
        changeType: "create",
        data: {
          profileSlug: "user_observation",
          title: "Founder working preference",
          properties: { uo_category: category, uo_observation: "x" },
        },
        failure: { errorClass: "validation" },
      }),
      AGENT,
      OWNER,
    ]
  );
  return id;
}

async function rowOf(id: string) {
  const { rows } = await q<{
    status: string;
    data: { data: { properties: Record<string, unknown> } };
  }>(`select status, data from proposals where id = $1`, [id]);
  return rows[0]!;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  for (const [u, role] of [
    [OWNER, "editor"],
    [VIEWER, "viewer"],
  ] as const) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), WS, u, role]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'W', $2, $3::jsonb)`,
    [
      WS,
      randomUUID(),
      JSON.stringify({
        aiGovernance: { proposalApprovalPolicy: "any_editor" },
      }),
    ]
  );
}, 120_000);

beforeEach(() => {
  h.applied = [];
  h.defUpdates = [];
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue({ id: "profile-uo", defaultValues: {} } as never);
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveProperties"
  ).mockResolvedValue([
    {
      id: "def-category",
      slug: "uo_category",
      valueType: "string",
      required: false,
      defaultValue: null,
      displayOrder: 0,
      isLifecycle: false,
      workspaceId: null,
      constraints: { enum: CATEGORIES },
      uiHints: {},
    } as unknown as EffectiveProperty,
  ]);
});

afterEach(() => vi.restoreAllMocks());

describe("proposals.repairOptions", () => {
  it("names the field, the refused value and the one it meant", async () => {
    const id = await fileFailed("preference");
    const repair = await caller(OWNER).repairOptions({ proposalId: id });
    expect(repair.fields).toEqual([
      expect.objectContaining({
        key: "uo_category",
        rejected: ["preference"],
        didYouMean: "preferences",
        canAddOption: false,
      }),
    ]);
  });

  it("is refused to a viewer, as `get` refuses them (FORBIDDEN)", async () => {
    const id = await fileFailed("preference");
    await expect(
      caller(VIEWER).repairOptions({ proposalId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("proposals.repair", () => {
  it("uses the value it meant, reopens the proposal, and approve takes exactly that revision", async () => {
    const id = await fileFailed("preference");
    const res = await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      set: { uo_category: "preferences" },
    });
    expect(res).toEqual({ revision: 1 });
    const row = await rowOf(id);
    expect(row.status).toBe("pending");
    expect(row.data.data.properties).toEqual({
      uo_category: "preferences",
      uo_observation: "x",
    });
    expect(h.defUpdates).toEqual([]);
    // The repair approves nothing itself; the card approves the revision it
    // made, through every gate of `approve`.
    expect(h.applied).toEqual([]);
    await caller(OWNER).approve({
      proposalId: id,
      expectedRevision: res.revision,
    });
    expect(h.applied).toEqual([id]);
  });

  it("adds a new idea to the field first, then sets it", async () => {
    const id = await fileFailed("rituals");
    const res = await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      set: { uo_category: "rituals" },
      addOption: { key: "uo_category", value: "rituals" },
    });
    expect(h.defUpdates).toEqual([
      expect.objectContaining({
        propertyDefId: "def-category",
        constraints: { enum: [...CATEGORIES, "rituals"] },
      }),
    ]);
    expect(res).toEqual({ revision: 1 });
  });

  it("only grows the field when nothing is set: the revision is the one the reader saw", async () => {
    const id = await fileFailed("rituals");
    const res = await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      addOption: { key: "uo_category", value: "rituals" },
    });
    expect(res).toEqual({ revision: 0 });
    expect(h.defUpdates).toHaveLength(1);
  });

  it("refuses to add a near twin of an allowed value, and changes nothing", async () => {
    const id = await fileFailed("preference");
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 0,
        set: { uo_category: "preference" },
        addOption: { key: "uo_category", value: "preference" },
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/'preferences' is already allowed/),
    });
    expect(h.defUpdates).toEqual([]);
    expect(h.applied).toEqual([]);
    expect((await rowOf(id)).status).toBe("approval_failed");
  });

  it("refuses a repair of a version the reader did not see", async () => {
    const id = await fileFailed("preference");
    // An agent revised it after the card drew (revision 0 → 1).
    await q(
      `update proposals set revision_history = '[{"at":"x","by":null,"before":{},"patch":{}}]'::jsonb where id = $1`,
      [id]
    );
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 0,
        set: { uo_category: "preferences" },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.applied).toEqual([]);
    expect((await rowOf(id)).data.data.properties.uo_category).toBe(
      "preference"
    );
  });

  it("refuses a proposal that is not a record's create or update", async () => {
    const id = await fileFailed("preference", "playbook");
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 0,
        set: { uo_category: "preferences" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.applied).toEqual([]);
  });

  it("refuses a reader who cannot approve it", async () => {
    const id = await fileFailed("preference");
    await expect(
      caller(VIEWER).repair({
        proposalId: id,
        expectedRevision: 0,
        set: { uo_category: "preferences" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.applied).toEqual([]);
  });
});
