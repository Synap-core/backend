/**
 * P2 — an AI's key always carries its limits, and approving an AI is a
 * proposal. Driven on PGlite through the real pieces:
 *   attachAgentKeyGrant      — a key minted for an agent carries its capabilities;
 *   reapplyAgentKeyGrants    — editing capabilities re-grants its live keys;
 *   fileAgentConnectProposal — a pending key files ONE `agent/connect` request;
 *   the `agent/connect` executor and approvePendingAgentKey /
 *   rejectPendingAgentKey     — one approval, whichever door.
 *
 * Rows that rule out a wrong rule: a NARROWED approval binds the narrowed reach
 * (not the asked one); a WIDENED one is refused and the key stays pending; a
 * non-owner is refused; the pod-admin door settles the proposal (so a second
 * approval is a no-op); a proposal rejected on its own revokes the key at the
 * next poll.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
// The proposal INSERT is the shared door's (its own client, its notifications);
// here it lands in PGlite with the exact fields the service hands it.
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { proposals } = await import("@synap/database/schema");
  return {
    ...actual,
    createPendingProposal: async (input: Record<string, unknown>) => {
      const [row] = await (h.db as any)
        .insert(proposals)
        .values({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          data: input.data,
          status: "pending",
          createdBy: input.createdBy,
          subjectUserId: input.userId,
        })
        .returning();
      return row;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { GrantRepository } from "@synap/database";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
  agentKeyGrantPermissions,
} from "@synap-core/types/grants";
import {
  attachAgentKeyGrant,
  reapplyAgentKeyGrants,
} from "./agent-identity-service.js";
import {
  approvePendingAgentKey,
  fileAgentConnectProposal,
  rejectPendingAgentKey,
  settleRejectedAgentConnect,
  type AgentConnectRequest,
} from "./agent-connect.js";
import { registerAgentExecutors } from "../routers/proposals/executors/agent.js";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const FULL_AGENT = randomUUID();
const PRESET = [
  ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
    .permissions,
];

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

async function mintKey(agent: string, active: boolean) {
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope)
     values ($1, $2, $3, $4, 'hub_inbound', 'Claude-code Hub Key', 'synap_', 'h', '{}')`,
    [id, agent, OWNER, active]
  );
  await attachAgentKeyGrant({
    apiKeyId: id,
    agentUserId: agent,
    onBehalfOf: OWNER,
    expiresAt: null,
    createdBy: OWNER,
  });
  return id;
}

const grantOf = async (keyId: string) =>
  (await new GrantRepository(h.db as never).resolveForKey(keyId))?.scopes.map(
    (s) => ({
      permissions: [...s.permissions].sort(),
      workspaceIds: s.workspaceIds ?? null,
    })
  );
const keyRow = async (keyId: string) =>
  (
    await q<{ is_active: boolean; revoked_at: Date | null }>(
      `select is_active, revoked_at from api_keys where id = $1`,
      [keyId]
    )
  ).rows[0]!;
const proposalStatus = async (id: string) =>
  (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

async function pendingConnection() {
  const keyId = await mintKey(AGENT, false);
  const { proposalId } = await fileAgentConnectProposal({
    keyId,
    agentUserId: AGENT,
    ownerUserId: OWNER,
    agentName: "Claude-code",
    agentType: "claude-code",
    expiresAt: null,
  });
  return { keyId, proposalId };
}

/** Approve through the REAL executor, with the (possibly revised) payload. */
async function approveViaProposal(
  proposalId: string,
  requests: AgentConnectRequest[],
  asked: AgentConnectRequest[],
  keyId: string,
  as = OWNER
) {
  const data = { agentUserId: AGENT, keyId, requests, asked };
  await q(`update proposals set data = $2::jsonb where id = $1`, [
    proposalId,
    JSON.stringify(data),
  ]);
  return proposalExecRegistry.resolveExact("agent/connect")!.execute({
    proposal: {
      id: proposalId,
      targetType: "agent",
      targetId: AGENT,
      proposalType: "connect",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      sourceMessageId: null,
      data,
    },
    payload: null,
    userId: as,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
    } as never,
  } as never);
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, email] of [
    [OWNER, "owner@x"],
    [OTHER, "other@x"],
  ])
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [id, email]
    );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, agent_metadata)
     values ($1, 'agent@x', 'agent', $2, 'claude-code', $3::jsonb)`,
    [AGENT, OWNER, JSON.stringify({ capabilities: PRESET })]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, agent_metadata)
     values ($1, 'full@x', 'agent', $2, 'codex', '{"capabilities": []}'::jsonb)`,
    [FULL_AGENT, OWNER]
  );
  registerAgentExecutors();
}, 120_000);

describe("every key minted for an agent carries its capabilities", () => {
  it("a limited agent's key holds exactly its capabilities (+ reads)", async () => {
    const keyId = await mintKey(AGENT, true);
    expect(await grantOf(keyId)).toEqual([
      {
        permissions: agentKeyGrantPermissions(PRESET).permissions.sort(),
        workspaceIds: null,
      },
    ]);
  });

  it("an agent with [] keeps full access — `*`, never a narrower grant", async () => {
    const keyId = await mintKey(FULL_AGENT, true);
    expect(await grantOf(keyId)).toEqual([
      { permissions: ["*"], workspaceIds: null },
    ]);
  });

  it("editing capabilities re-grants every live key at once", async () => {
    const keyId = await mintKey(AGENT, true);
    await q(`update users set agent_metadata = $2::jsonb where id = $1`, [
      AGENT,
      JSON.stringify({ capabilities: ["entity.note.create"] }),
    ]);
    expect(
      await reapplyAgentKeyGrants({ agentUserId: AGENT, createdBy: OWNER })
    ).toBeGreaterThanOrEqual(1);
    const [scope] = (await grantOf(keyId))!;
    expect(scope!.permissions).toContain("entity.note.create");
    expect(scope!.permissions).not.toContain("entity.*.create");
    await q(`update users set agent_metadata = $2::jsonb where id = $1`, [
      AGENT,
      JSON.stringify({ capabilities: PRESET }),
    ]);
    await reapplyAgentKeyGrants({ agentUserId: AGENT, createdBy: OWNER });
  });
});

describe("agent/connect — approving an AI is a proposal", () => {
  it("files ONE pending request whose requests = asked = the key's grant", async () => {
    const { keyId, proposalId } = await pendingConnection();
    const [row] = (
      await q<{
        status: string;
        data: Record<string, unknown>;
        target_id: string;
      }>(`select status, data, target_id from proposals where id = $1`, [
        proposalId,
      ])
    ).rows;
    expect(row!.status).toBe("pending");
    expect(row!.target_id).toBe(AGENT);
    expect(row!.data.keyId).toBe(keyId);
    expect(row!.data.requests).toEqual(row!.data.asked);
    expect(
      (row!.data.requests as AgentConnectRequest[])
        .map((r) => r.permission)
        .sort()
    ).toEqual(agentKeyGrantPermissions(PRESET).permissions.sort());
  });

  it("a NARROWED approval activates exactly that key with the narrowed reach", async () => {
    const { keyId, proposalId } = await pendingConnection();
    const other = await pendingConnection();
    const asked: AgentConnectRequest[] = [
      { permission: "entity.*.read", workspaceId: null },
      { permission: "entity.*.create", workspaceId: null },
    ];
    const narrowed: AgentConnectRequest[] = [
      { permission: "entity.note.read", workspaceId: null },
    ];
    const result = await approveViaProposal(proposalId, narrowed, asked, keyId);
    expect(result.success).toBe(true);
    expect(await keyRow(keyId)).toMatchObject({ is_active: true });
    expect(await grantOf(keyId)).toEqual([
      { permissions: ["entity.note.read"], workspaceIds: null },
    ]);
    expect(await proposalStatus(proposalId)).toBe("approved");
    // Exactly that key: the other pending connection is untouched.
    expect(await keyRow(other.keyId)).toMatchObject({ is_active: false });
  });

  it("a WIDENED approval is refused and the key stays pending", async () => {
    const { keyId, proposalId } = await pendingConnection();
    const asked: AgentConnectRequest[] = [
      { permission: "entity.*.read", workspaceId: null },
    ];
    await expect(
      approveViaProposal(
        proposalId,
        [...asked, { permission: "entity.*.delete", workspaceId: null }],
        asked,
        keyId
      )
    ).rejects.toThrow(/only narrow/);
    expect(await keyRow(keyId)).toMatchObject({ is_active: false });
    expect(await proposalStatus(proposalId)).toBe("pending");
  });

  it("someone the key does not act for is refused", async () => {
    const { keyId, proposalId } = await pendingConnection();
    const asked = [{ permission: "entity.*.read", workspaceId: null }];
    await expect(
      approveViaProposal(proposalId, asked, asked, keyId, OTHER)
    ).rejects.toThrow(/Only the person/);
    expect(await keyRow(keyId)).toMatchObject({ is_active: false });
  });

  it("the pod-admin door approves through the same function and settles the proposal", async () => {
    const { keyId, proposalId } = await pendingConnection();
    expect(await approvePendingAgentKey({ keyId, approverId: OWNER })).toBe(
      "approved"
    );
    expect(await keyRow(keyId)).toMatchObject({ is_active: true });
    expect(await proposalStatus(proposalId)).toBe("approved");
    // No double approval: a second decision finds nothing to do.
    expect(await approvePendingAgentKey({ keyId, approverId: OWNER })).toBe(
      "already_active"
    );
  });

  it("rejecting on the pod-admin door revokes the key and rejects the proposal", async () => {
    const { keyId, proposalId } = await pendingConnection();
    expect(await rejectPendingAgentKey({ keyId, approverId: OWNER })).toBe(
      "rejected"
    );
    expect((await keyRow(keyId)).revoked_at).not.toBeNull();
    expect(await proposalStatus(proposalId)).toBe("rejected");
  });

  it("a proposal rejected on its own revokes the pending key at the next poll", async () => {
    const { keyId, proposalId } = await pendingConnection();
    await q(`update proposals set status = 'rejected' where id = $1`, [
      proposalId,
    ]);
    expect(await settleRejectedAgentConnect(keyId)).toBe(true);
    expect((await keyRow(keyId)).revoked_at).not.toBeNull();
    expect(await approvePendingAgentKey({ keyId, approverId: OWNER })).toBe(
      "rejected"
    );
  });
});

describe("agent/updateCapabilities — an edit that became a proposal applies on approval", () => {
  async function capabilitiesProposal(capabilities: string[]) {
    const id = randomUUID();
    const data = { agentUserId: AGENT, capabilities };
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, data, status, created_by)
       values ($1, 'agent', $2, 'updateCapabilities', $3::jsonb, 'pending', $4)`,
      [id, AGENT, JSON.stringify(data), OWNER]
    );
    return { id, data };
  }
  const approveCaps = (id: string, data: unknown, as = OWNER) =>
    proposalExecRegistry.resolveExact("agent/updateCapabilities")!.execute({
      proposal: {
        id,
        targetType: "agent",
        targetId: AGENT,
        proposalType: "updateCapabilities",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: null,
        sourceMessageId: null,
        data,
      },
      payload: null,
      userId: as,
      input: { proposalId: id },
      ctx: {} as never,
      deps: {
        emitProposalReviewed: () => {},
        reportProposalOutcome: () => {},
      } as never,
    } as never);
  const storedCaps = async () =>
    (
      await q<{ caps: string[] }>(
        `select agent_metadata -> 'capabilities' as caps from users where id = $1`,
        [AGENT]
      )
    ).rows[0]!.caps;

  it("sets the capabilities and re-grants the agent's live keys", async () => {
    const keyId = await mintKey(AGENT, true);
    const { id, data } = await capabilitiesProposal(["entity.note.create"]);
    const result = await approveCaps(id, data);
    expect(result.success).toBe(true);
    expect(await storedCaps()).toEqual(["entity.note.create"]);
    const [scope] = (await grantOf(keyId))!;
    expect(scope!.permissions).toContain("entity.note.create");
    expect(scope!.permissions).not.toContain("entity.*.create");
    expect(await proposalStatus(id)).toBe("approved");
    // Restore the preset for the other rows.
    const back = await capabilitiesProposal(PRESET);
    await approveCaps(back.id, back.data);
    expect(await storedCaps()).toEqual(PRESET);
  });

  it("refuses someone who is not the agent's person nor a pod admin", async () => {
    const { id, data } = await capabilitiesProposal(["entity.note.create"]);
    await expect(approveCaps(id, data, OTHER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await storedCaps()).toEqual(PRESET);
    expect(await proposalStatus(id)).toBe("pending");
  });

  it("refuses a pattern that does not parse", async () => {
    const { id, data } = await capabilitiesProposal(["Not.A.Grant.Pattern"]);
    await expect(approveCaps(id, data)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
