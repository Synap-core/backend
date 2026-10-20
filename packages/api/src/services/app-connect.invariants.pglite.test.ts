/**
 * App Connect — the key-request invariants, end to end on PGlite.
 *
 * App Connect IS the door an app (or an agent acting for its owner) uses to
 * get a scoped key: `POST /apps/:id/connect` files ONE `app/connect` proposal,
 * the owner approves it, `POST /apps/:id/key` mints the key once. These rows
 * drive the REAL chain — `requestAccess` → `applyProposalApproval` (the ONE
 * approve door) → the `app/connect` executor → `issueKey` with the REAL
 * `ApiKeyRepository` (bcrypt + lookup hash + its `api_key.create.completed`
 * event) → `apiKeyService.validateApiKey` (what every key-auth door runs) →
 * `revokeApp` → `revokeApiKeys` (the ONE revoke door).
 *
 * Seams replaced, and why: the event store (`EventRepository`) and `auditLog`
 * write through the postgres-js client this harness has not — both are
 * replaced by recorders, so what they would have persisted (and what SSE,
 * peer sync and webhook deliveries are built from) is asserted directly.
 * `createPendingProposal` lands its row in PGlite unchanged.
 *
 * NOT covered here (stated): log lines — pino writes off-thread, so a log
 * capture would pass vacuously. The issue/approve path has no logger call
 * that takes the key (read at the source); a failed mint logs only `err`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  /** Every event the spine would have stored (and broadcast / synced). */
  events: [] as unknown[],
  /** Every auditLog call (the app timeline, the key's audit row). */
  audits: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
      h.events.push(event);
      return event;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    EventRepository: RecordingEventRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({
  auditLog: async (opts: unknown) => {
    h.audits.push(opts);
    return null;
  },
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    createPendingProposal: async (input: Record<string, unknown>) => {
      const [row] = await (h.db as any)
        .insert(schema.proposals)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          workspaceId: input.workspaceId ?? null,
          status: "pending",
          data: input.data,
          agentUserId: input.agentUserId ?? null,
          createdBy: input.createdBy,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { AppRepository, runWithActingAgent } from "@synap/database";
import { applyProposalApproval } from "../routers/proposals/apply-approval.js";
import { apiKeyService } from "./api-keys.js";
import { issueKey, requestAccess, revokeApp } from "./app-connect.js";

const OWNER = "human-owner";
const AGENT = randomUUID();
const SALES = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const tableNames: string[] = [];

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      await h.client!.exec(ddlFor(value));
      tableNames.push(getTableConfig(value).name);
    }
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'owner@x', 'human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, created_via)
     values ($1, 'agent@x', 'agent', $2, 'claude-code', 'cli')`,
    [AGENT, OWNER]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
    SALES,
    "Sales",
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), SALES, OWNER]
  );
}, 120_000);

async function registered(name: string) {
  return new AppRepository(h.db as never).register({
    ownerUserId: OWNER,
    name,
  });
}

async function loadProposal(id: string) {
  const { db } = await import("@synap/database");
  const { eq } = await import("drizzle-orm");
  return (
    db as unknown as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
}

/** File a request through the real door, approve it through the ONE door. */
async function requestAndApprove(name: string, permission: string) {
  const app = await registered(name);
  const { proposalId } = await requestAccess({
    publicId: app.publicId,
    ownerUserId: OWNER,
    requests: [{ permission, workspace: "Sales" }],
  });
  const result = await applyProposalApproval({
    proposal: (await loadProposal(proposalId)) as never,
    userId: OWNER,
    input: { proposalId },
    ctx: { authenticated: true, userId: OWNER } as never,
  });
  return { app, proposalId, result };
}

const approvedOf = async (appId: string) =>
  (
    await q<{ approved_requests: unknown }>(
      `select approved_requests from apps where id = $1`,
      [appId]
    )
  ).rows[0]!.approved_requests;

describe("invariant 3 — an agent never approves an app's access", () => {
  /**
   * Same pending `app/connect` proposal, same approve door; only the caller
   * differs. The owner's approval is the positive control: without it a
   * refusal for an unrelated reason would pass every agent row.
   */
  const pending = async (name: string) => {
    const app = await registered(name);
    const { proposalId } = await requestAccess({
      publicId: app.publicId,
      ownerUserId: OWNER,
      requests: [{ permission: "entity.note.read", workspace: "Sales" }],
    });
    return { app, proposalId };
  };
  const approveAs = async (proposalId: string, ctx: Record<string, unknown>) =>
    applyProposalApproval({
      proposal: (await loadProposal(proposalId)) as never,
      userId: OWNER,
      input: { proposalId },
      ctx: { authenticated: true, userId: OWNER, ...ctx } as never,
    });

  it("an agent key (ctx.agentUserId) is refused — nothing approved", async () => {
    const { app, proposalId } = await pending("floor-ctx");
    await expect(approveAs(proposalId, { agentUserId: AGENT })).rejects.toThrow(
      /An agent credential cannot approve proposals/
    );
    expect(await approvedOf(app.id)).toBeNull();
  });

  it("an acting agent in the request ALS (the Hub REST door's shape) is refused", async () => {
    const { app, proposalId } = await pending("floor-als");
    await expect(
      runWithActingAgent(AGENT, () => approveAs(proposalId, {}))
    ).rejects.toThrow(/An agent credential cannot approve proposals/);
    expect(await approvedOf(app.id)).toBeNull();
  });

  it("the Intelligence Service's internal key is refused", async () => {
    const { app, proposalId } = await pending("floor-is");
    await expect(
      approveAs(proposalId, { keyType: "is_internal" })
    ).rejects.toThrow(/An agent credential cannot approve proposals/);
    expect(await approvedOf(app.id)).toBeNull();
  });

  it("CONTROL: the owner, signed in, approves", async () => {
    const { app, proposalId } = await pending("floor-owner");
    const result = await approveAs(proposalId, {});
    expect(result.success).toBe(true);
    expect(await approvedOf(app.id)).toEqual([
      { permission: "entity.note.read", workspaceId: SALES },
    ]);
  });
});

describe("invariant 2 — the key's plaintext lives only in the one-time response", () => {
  it("is in no table row, no event, no audit call after request → approve → issue", async () => {
    const { app } = await requestAndApprove("secret-free", "entity.note.read");
    const eventsBefore = h.events.length;
    const auditsBefore = h.audits.length;
    const issued = await issueKey({
      publicId: app.publicId,
      ownerUserId: OWNER,
      via: "cli",
    });
    // The one delivery: the caller gets it, whole.
    expect(issued.apiKey).toMatch(/^synap_/);
    expect(issued.apiKey.length).toBeGreaterThan(40);

    // Non-vacuity: the mint DID emit and audit (else "absent" proves nothing).
    const newEvents = h.events.slice(eventsBefore);
    const newAudits = h.audits.slice(auditsBefore);
    expect(
      newEvents.some((e) => JSON.stringify(e).includes(issued.keyId))
    ).toBe(true);
    expect(
      newAudits.some((a) => JSON.stringify(a).includes(issued.keyId))
    ).toBe(true);

    const secret = issued.apiKey;
    // The random part alone, so a prefix-stripped copy is caught too.
    const material = secret.replace(/^synap_[a-z_]*?(?=[0-9a-f]{64}$)/, "");
    expect(material).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.events)).not.toContain(material);
    expect(JSON.stringify(h.audits)).not.toContain(material);

    let scanned = 0;
    for (const t of tableNames) {
      const rows = (await q<{ r: string }>(`select t::text as r from "${t}" t`))
        .rows;
      scanned += rows.length;
      for (const { r } of rows) expect(r).not.toContain(material);
    }
    // Non-vacuity: the scan saw the key row, the app and the proposal.
    expect(scanned).toBeGreaterThan(5);
    const keyRow = (
      await q<{ key_hash: string }>(
        `select key_hash from api_keys where id = $1`,
        [issued.keyId]
      )
    ).rows[0]!;
    expect(keyRow.key_hash).toMatch(/^\$2[aby]\$/);
  });
});

describe("D8 — an app key does not expire; rotation is a re-issue", () => {
  it("the key and its grant carry no expiry", async () => {
    const { app } = await requestAndApprove("no-expiry", "entity.note.read");
    const issued = await issueKey({
      publicId: app.publicId,
      ownerUserId: OWNER,
      via: "cli",
    });
    const [key] = (
      await q<{ expires_at: string | null }>(
        `select expires_at from api_keys where id = $1`,
        [issued.keyId]
      )
    ).rows;
    expect(key!.expires_at).toBeNull();
    const grants = (
      await q<{ expires_at: string | null }>(
        `select expires_at from grants where api_key_id = $1 and revoked_at is null`,
        [issued.keyId]
      )
    ).rows;
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.expires_at === null)).toBe(true);
  });
});

describe("invariant 4 — revoke stops the key at once", () => {
  it("a key that validated (and is cached) no longer validates after revokeApp", async () => {
    const { app } = await requestAndApprove("revoked", "entity.note.read");
    const issued = await issueKey({
      publicId: app.publicId,
      ownerUserId: OWNER,
      via: "cli",
    });
    // Validates — and is now in the 30s verification cache.
    const before = await apiKeyService.validateApiKey(issued.apiKey);
    expect(before?.id).toBe(issued.keyId);
    expect((await apiKeyService.validateApiKey(issued.apiKey))?.id).toBe(
      issued.keyId
    );

    await revokeApp({ publicId: app.publicId, ownerUserId: OWNER });

    // The cache was dropped by the ONE revoke door: refused immediately.
    expect(await apiKeyService.validateApiKey(issued.apiKey)).toBeNull();
    const live = (
      await q(
        `select id from grants where api_key_id = $1 and revoked_at is null`,
        [issued.keyId]
      )
    ).rows;
    expect(live).toHaveLength(0);
  });

  it("re-issuing rotates: the previous key stops at once", async () => {
    const { app } = await requestAndApprove("rotated", "entity.note.read");
    const first = await issueKey({
      publicId: app.publicId,
      ownerUserId: OWNER,
      via: "cli",
    });
    expect((await apiKeyService.validateApiKey(first.apiKey))?.id).toBe(
      first.keyId
    );
    const second = await issueKey({
      publicId: app.publicId,
      ownerUserId: OWNER,
      via: "cli",
    });
    expect(await apiKeyService.validateApiKey(first.apiKey)).toBeNull();
    expect((await apiKeyService.validateApiKey(second.apiKey))?.id).toBe(
      second.keyId
    );
  });
});

describe("invariant 1 — an owner grants an app only what they can do themselves", () => {
  /**
   * `resolveRequests` bounds a request by the spaces the owner can READ —
   * member ∪ owned ∪ pod-visible. Approving a WRITE there makes the app's
   * agent an `editor` member (`syncAppAgentMemberships`): a pod member who
   * may only read a pod-visible space (or is a viewer in it) would hand
   * their app edit rights they never had. Writes need the owner to hold
   * edit rights in that space; reads stay bounded by what they can read.
   */
  const OTHER = "other-human";
  const COMMONS = randomUUID();
  const SHARED = randomUUID();
  const DEMOTED = randomUUID();

  beforeAll(async () => {
    await q(
      `insert into users (id, email, user_type) values ($1, 'other@x', 'human')`,
      [OTHER]
    );
    // Pod-visible, owned by someone else, the owner is NOT a member.
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, 'Commons', $2, $3)`,
      [COMMONS, OTHER, JSON.stringify({ workspaceVisibility: "pod_visible" })]
    );
    // Someone else's; the owner is a VIEWER member.
    for (const [id, name] of [
      [SHARED, "Shared"],
      [DEMOTED, "Demoted"],
    ] as const) {
      await q(
        `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}')`,
        [id, name, OTHER]
      );
    }
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'viewer')`,
      [randomUUID(), SHARED, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), DEMOTED, OWNER]
    );
  });

  const ask = async (name: string, permission: string, workspace: string) =>
    requestAccess({
      publicId: (await registered(name)).publicId,
      ownerUserId: OWNER,
      requests: [{ permission, workspace }],
    });
  const proposalsFor = async (workspaceId: string) =>
    (
      await q<{ id: string }>(
        `select id from proposals where target_type = 'app' and data::text like $1`,
        [`%${workspaceId}%`]
      )
    ).rows;

  it("a write in a pod-visible space the owner only reads is refused — nothing filed", async () => {
    await expect(
      ask("commons-write", "entity.note.create", "Commons")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await proposalsFor(COMMONS)).toHaveLength(0);
  });

  it("a write where the owner is a viewer is refused", async () => {
    await expect(
      ask("viewer-write", "entity.note.create", "Shared")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await proposalsFor(SHARED)).toHaveLength(0);
  });

  it("the full-access `*` counts as a write — refused where the owner reads", async () => {
    await expect(ask("viewer-star", "*", "Shared")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("CONTROL: a read in the pod-visible space is filed", async () => {
    const { proposalId } = await ask(
      "commons-read",
      "entity.note.read",
      "Commons"
    );
    expect(proposalId).toBeTruthy();
  });

  it("CONTROL: a write in the owner's own space is filed", async () => {
    const { proposalId } = await ask(
      "own-write",
      "entity.note.create",
      "Sales"
    );
    expect(proposalId).toBeTruthy();
  });

  it("approving is re-checked: demoted after filing → refused, the app agent joins nothing", async () => {
    const app = await registered("demoted-write");
    const { proposalId } = await requestAccess({
      publicId: app.publicId,
      ownerUserId: OWNER,
      requests: [{ permission: "entity.note.create", workspace: "Demoted" }],
    });
    await q(
      `update workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2`,
      [DEMOTED, OWNER]
    );
    await expect(
      applyProposalApproval({
        proposal: (await loadProposal(proposalId)) as never,
        userId: OWNER,
        input: { proposalId },
        ctx: { authenticated: true, userId: OWNER } as never,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await approvedOf(app.id)).toBeNull();
    const editors = (
      await q(
        `select id from workspace_members where workspace_id = $1 and role = 'editor'`,
        [DEMOTED]
      )
    ).rows;
    expect(editors).toHaveLength(0);
  });
});
