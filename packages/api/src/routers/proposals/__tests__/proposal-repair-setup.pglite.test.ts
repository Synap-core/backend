/**
 * `proposals.repair` SETUP arm and `proposals.repairOptions` setup rows
 * (finding 91a3bfd3, plan d717d6ac addendum B): a person hands over what a
 * proposal needs before it can apply — an install's API key, a key an agent
 * asked to read — on the proposal itself, vault first.
 *
 * SEAM: the REAL router procedures → the REAL authority ladder, the REAL
 * setup projection (`resolveProposalSetups`), the REAL vault create door
 * (`secretsVault.create`, encryption included) and the REAL revise core, on
 * PGlite. Stubbed: the catalog cache read (the cal-com manifest), the
 * connection-state read (no Nango), the vault repository's row insert
 * (recorded, then written to PGlite) and the executor dispatch.
 *
 * What it pins:
 *  1. repairOptions lists the install's key row WITH the manifest's `obtain`
 *     steps, and only the person's OWN vault secrets as choices;
 *  2. a NEW key is created in the vault and only its `vault://` ref reaches
 *     the proposal; the value is nowhere in the row, its history or the reply;
 *  3. an `approval_failed` row reopens to `pending` (and the failure goes);
 *  4. it is person-only: an agent, a key's grant, and (for a new key) a stale
 *     device session are refused, and nothing is written;
 *  5. every entry is checked before any vault write;
 *  6. a vault.request with no matching secret offers the same row, and the
 *     key typed there becomes the secret the request names;
 *  7. an install whose manifest the pod cannot read (not in the cache, and
 *     the by-key catalog read finds nothing: proposal eaa77f7d) says so
 *     (`unreadable`), offers nothing to hand over, and the repair refuses.
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

const h = vi.hoisted(() => {
  process.env.VAULT_SERVER_KEY = "ab".repeat(32);
  return {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    applied: [] as string[],
    vaultCreates: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  h.db = db;
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

const OBTAIN = {
  url: "https://app.cal.com/settings/developer/api-keys",
  steps: [
    "Open Settings, then Developer, then API Keys",
    "Create a key and copy it (it starts with cal_live_)",
  ],
};

vi.mock(
  "../../../services/capabilities/marketplace-install.js",
  async (orig) => ({
    ...((await orig()) as object),
    // `github-merge` is an opt-in capability: never in the cache.
    lookupCatalogEntry: vi.fn(async (_kind: string, slug: string) =>
      slug === "github-merge"
        ? null
        : {
            definition: {
              key: "cal-com",
              name: "Cal.com",
              params: [
                {
                  name: "calApiKey",
                  label: "Cal.com API key",
                  type: "password",
                  required: true,
                  description: "The Cal.com API key.",
                  obtain: OBTAIN,
                },
              ],
              vault: [{ ref: "k", name: "Cal.com", value: "{{calApiKey}}" }],
              tools: [],
            },
          }
    ),
  })
);

// The by-key catalog read (the Control Plane) finds nothing either.
vi.mock(
  "../../../services/capabilities/cp-template-client.js",
  async (orig) => ({
    ...((await orig()) as object),
    fetchCPCapabilityTemplate: vi.fn(async () => null),
  })
);

vi.mock(
  "../../../services/capabilities/capability-catalog.js",
  async (orig) => ({
    ...((await orig()) as object),
    // No Nango: every vault id the page names exists (the ref the repair
    // writes is then `satisfied`).
    loadConnState: vi.fn(async (_userId: string, ids: string[]) => ({
      providerConn: new Map<string, string>(),
      providerAvailable: null,
      providerConnFault: null,
      vaultExists: new Set<string>(ids),
      vaultMeta: new Map(),
      reauthConnIds: new Set<string>(),
    })),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { SecretsVaultRepository, runWithGrant } from "@synap/database";
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
const OTHER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const OWN_SECRET = randomUUID();
const OTHERS_SECRET = randomUUID();
const TYPED_KEY = "cal_live_TYPED-BY-THE-PERSON-0123456789";

const human = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ authenticated: true, userId, ...extra }) as never;
const caller = (userId: string, extra: Record<string, unknown> = {}) =>
  proposalsRouter.createCaller(human(userId, extra));

async function fileInstall(
  status = "approval_failed",
  slug = "cal-com"
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, data, revision_history, agent_user_id, created_by, rejection_reason, created_at, updated_at)
     values ($1, $2, 'capability.install', 'capability', 'market:capability:cal-com', $3, $4::jsonb, '[]'::jsonb, $5, $6, $7, now(), now())`,
    [
      id,
      status,
      WS,
      JSON.stringify({
        slug,
        kind: "capability",
        version: null,
        source: "synap",
        params: {},
        ...(status === "approval_failed"
          ? {
              failure: {
                errorClass: "missing_field",
                missingFields: ["calApiKey"],
              },
            }
          : {}),
      }),
      AGENT,
      OWNER,
      status === "approval_failed" ? "Needs setup: Cal.com API key." : null,
    ]
  );
  return id;
}

async function fileVaultRequest(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, data, revision_history, agent_user_id, created_by, created_at, updated_at)
     values ($1, 'pending', 'vault.request', 'vault', 'fal.ai:api_key', $2, $3::jsonb, '[]'::jsonb, $4, $5, now(), now())`,
    [
      id,
      WS,
      JSON.stringify({
        secretType: "api_key",
        service: "fal.ai",
        purpose: "Generate the launch images",
        ttl: 60,
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
    data: Record<string, unknown>;
    revision_history: unknown;
    rejection_reason: string | null;
  }>(
    `select status, data, revision_history, rejection_reason from proposals where id = $1`,
    [id]
  );
  return rows[0]!;
}

async function secretCount(): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from secrets`
  );
  return Number(rows[0]!.n);
}

async function insertSecret(id: string, userId: string, name: string) {
  await q(
    `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag, encryption_mode, created_at, updated_at)
     values ($1, $2, $3, 'api_key', 'x', 'x', 'x', 'server', now(), now())`,
    [id, userId, name]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  for (const u of [OWNER, OTHER]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, u]
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
  await insertSecret(OWN_SECRET, OWNER, "Cal.com (work)");
  await insertSecret(OTHERS_SECRET, OTHER, "Someone else's Cal.com");
}, 120_000);

beforeEach(() => {
  h.applied = [];
  h.vaultCreates = [];
  // The vault's own create door runs for real (agent refusal, key check,
  // server-side encryption); only its row insert is recorded and written here.
  vi.spyOn(SecretsVaultRepository.prototype, "create").mockImplementation(
    async (input, userId: string) => {
      const data = input as unknown as Record<string, unknown>;
      h.vaultCreates.push({ ...data, userId });
      const id = (data.id as string | undefined) ?? randomUUID();
      await q(
        `insert into secrets (id, user_id, name, type, category, encrypted_data, iv, auth_tag, encryption_mode, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'server', now(), now())`,
        [
          id,
          userId,
          data.name,
          data.type,
          data.category ?? null,
          data.encryptedData,
          data.iv,
          data.authTag,
        ]
      );
      return {
        id,
        name: data.name,
        type: data.type,
        createdAt: new Date(),
      } as never;
    }
  );
});

afterEach(() => vi.restoreAllMocks());

describe("proposals.repairOptions — setup rows", () => {
  it("lists the install's key row with the manifest's steps, and only the person's own secrets", async () => {
    const id = await fileInstall();
    const repair = await caller(OWNER).repairOptions({ proposalId: id });
    expect(repair.repairable).toBe(true);
    expect(repair.fields).toEqual([]);
    expect(repair.setup?.blocking).toBe(true);
    expect(repair.setup?.params).toEqual([
      expect.objectContaining({
        name: "calApiKey",
        label: "Cal.com API key",
        required: true,
        secret: true,
        satisfied: false,
        obtain: OBTAIN,
      }),
    ]);
    const refs = repair.setup!.secretChoices.map((c) => c.ref);
    expect(refs).toContain(`vault://${OWN_SECRET}`);
    expect(refs).not.toContain(`vault://${OTHERS_SECRET}`);
  });

  it("an install whose manifest cannot be read says so and offers nothing to hand over", async () => {
    const id = await fileInstall("approval_failed", "github-merge");
    const repair = await caller(OWNER).repairOptions({ proposalId: id });
    // Never an absent setup (read as "no setup") nor an empty "nothing needed".
    expect(repair.setup).toMatchObject({
      unreadable: true,
      blocking: true,
      params: [],
      secretChoices: [],
    });
    expect(repair.repairable).toBe(false);

    const before = await secretCount();
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 0,
        setup: { githubToken: { kind: "new", value: TYPED_KEY } },
      })
    ).rejects.toThrow(/cannot read what this proposal needs/);
    expect(await secretCount()).toBe(before);
    expect(h.vaultCreates).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("approval_failed");
  });

  it("a vault.request no secret matches offers the same row", async () => {
    const id = await fileVaultRequest();
    const repair = await caller(OWNER).repairOptions({ proposalId: id });
    expect(repair.repairable).toBe(true);
    expect(repair.setup?.params).toEqual([
      expect.objectContaining({
        name: "secret",
        secret: true,
        satisfied: false,
        required: true,
        description: "Generate the launch images",
      }),
    ]);
  });
});

describe("proposals.repair — setup arm", () => {
  it("a NEW key goes to the vault first; only its ref reaches the proposal, which reopens as pending", async () => {
    const id = await fileInstall();
    const out = await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      setup: { calApiKey: { kind: "new", value: TYPED_KEY } },
    });
    expect(out).toEqual({ revision: 1, secretsCreated: 1 });
    expect(JSON.stringify(out)).not.toContain(TYPED_KEY);

    // Created through the vault door, encrypted: the plaintext never stored.
    expect(h.vaultCreates).toHaveLength(1);
    expect(h.vaultCreates[0]).toMatchObject({
      userId: OWNER,
      name: "cal-com · Cal.com API key",
      type: "api_key",
    });
    expect(JSON.stringify(h.vaultCreates[0])).not.toContain(TYPED_KEY);

    const row = await rowOf(id);
    expect(row.status).toBe("pending");
    expect(row.rejection_reason).toBeNull();
    expect(row.data.failure).toBeUndefined();
    const ref = (row.data.params as Record<string, string>).calApiKey;
    expect(ref).toMatch(/^vault:\/\/[0-9a-f-]{36}$/);
    expect(JSON.stringify(row)).not.toContain(TYPED_KEY);

    // The row is satisfied now: Approve is no longer held.
    const after = await caller(OWNER).repairOptions({ proposalId: id });
    expect(after.setup?.blocking).toBe(false);
    expect(after.setup?.params[0]?.ref).toBe(ref);
  });

  it("an existing secret of the person's own is linked by ref; no new secret is made", async () => {
    const id = await fileInstall("pending");
    const before = await secretCount();
    await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      setup: { calApiKey: { kind: "existing", ref: `vault://${OWN_SECRET}` } },
    });
    expect(await secretCount()).toBe(before);
    expect((await rowOf(id)).data.params).toEqual({
      calApiKey: `vault://${OWN_SECRET}`,
    });
  });

  it.each([
    [
      "someone else's secret",
      { calApiKey: { kind: "existing", ref: `vault://${OTHERS_SECRET}` } },
      /not one of yours/,
    ],
    [
      "a plain value under a secret row",
      { calApiKey: { kind: "value", value: TYPED_KEY } },
      /is a secret/,
    ],
    [
      "a row the proposal does not need",
      {
        calApiKey: { kind: "new", value: TYPED_KEY },
        planted: { kind: "value", value: "x" },
      },
      /not something this proposal needs/,
    ],
  ])("refuses %s, and writes nothing", async (_name, setup, message) => {
    const id = await fileInstall();
    const before = await secretCount();
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 0,
        setup: setup as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    expect(await secretCount()).toBe(before);
    expect(h.vaultCreates).toHaveLength(0);
    const row = await rowOf(id);
    expect(row.status).toBe("approval_failed");
    expect(JSON.stringify(row)).not.toContain(TYPED_KEY);
  });

  it("is a person's act: an agent is refused", async () => {
    const id = await fileInstall();
    await expect(
      caller(OWNER, { agentUserId: AGENT }).repair({
        proposalId: id,
        expectedRevision: 0,
        setup: { calApiKey: { kind: "new", value: TYPED_KEY } },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.vaultCreates).toHaveLength(0);
    expect((await rowOf(id)).status).toBe("approval_failed");
  });

  it("is a person's act: a key's grant is refused", async () => {
    const id = await fileInstall();
    await expect(
      runWithGrant({ scopes: [{ permissions: ["*"] }], clientId: "app" }, () =>
        caller(OWNER).repair({
          proposalId: id,
          expectedRevision: 0,
          setup: { calApiKey: { kind: "new", value: TYPED_KEY } },
        })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.vaultCreates).toHaveLength(0);
  });

  it("typing a new key needs a recent sign-in on a device session", async () => {
    const id = await fileInstall();
    const stale = {
      sessionKind: "person_device",
      session: { device: { id: "dev-1", authTime: new Date(0) } },
    };
    await expect(
      caller(OWNER, stale).repair({
        proposalId: id,
        expectedRevision: 0,
        setup: { calApiKey: { kind: "new", value: TYPED_KEY } },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.vaultCreates).toHaveLength(0);
    // Picking one already in the vault creates no credential: no step-up.
    await caller(OWNER, stale).repair({
      proposalId: id,
      expectedRevision: 0,
      setup: { calApiKey: { kind: "existing", ref: `vault://${OWN_SECRET}` } },
    });
    expect((await rowOf(id)).status).toBe("pending");
  });

  it("a stale revision is refused before anything reaches the vault", async () => {
    const id = await fileInstall();
    await expect(
      caller(OWNER).repair({
        proposalId: id,
        expectedRevision: 3,
        setup: { calApiKey: { kind: "new", value: TYPED_KEY } },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.vaultCreates).toHaveLength(0);
  });

  it("a vault.request: the key typed on it becomes the secret the request names", async () => {
    const id = await fileVaultRequest();
    await caller(OWNER).repair({
      proposalId: id,
      expectedRevision: 0,
      setup: { secret: { kind: "new", value: "fal-TYPED-KEY" } },
    });
    expect(h.vaultCreates[0]).toMatchObject({
      name: expect.stringMatching(/ key$/),
      category: "fal.ai",
      type: "api_key",
    });
    const row = await rowOf(id);
    expect(row.status).toBe("pending");
    expect(row.data.secretId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(row)).not.toContain("fal-TYPED-KEY");
    // Named now: the request takes no further row.
    const after = await caller(OWNER).repairOptions({ proposalId: id });
    expect(after.setup).toBeUndefined();
  });
});
