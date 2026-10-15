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
  // The mint door's event append goes to the live postgres client; here the
  // rows under test are the key and its grant, not the event log.
  class EventRepository {
    async append(e: unknown) {
      return e;
    }
  }
  return { ...actual, db: h.db, getDb: async () => h.db, EventRepository };
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
  createNamedAgent,
  provisionSurfaceAgentKey,
  reapplyAgentKeyGrants,
} from "./agent-identity-service.js";
import { aiDefaultCapabilities } from "@synap-core/types/grants";
import { decideAgentPolicy } from "@synap/governance-policy";
import { mcpToolAllowed } from "../access/grant-door-fence.js";
import { grantWriteDenial } from "../utils/grant-write-check.js";
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

  it("the card's end is when the ACCESS ends — a grant cut to end before its key wins", async () => {
    // Live 2026-10-11: a key ending 2027-01-09 whose grant (bounded by the
    // connecting key) ended 2027-01-02 filed a card saying 2027-01-09.
    const keyEnd = new Date(Date.now() + 90 * 86_400_000);
    const grantEnd = new Date(Date.now() + 80 * 86_400_000);
    const keyId = await mintKey(AGENT, false);
    await q(`update grants set expires_at = $2 where api_key_id = $1`, [
      keyId,
      grantEnd,
    ]);
    const { proposalId } = await fileAgentConnectProposal({
      keyId,
      agentUserId: AGENT,
      ownerUserId: OWNER,
      agentName: "Claude-code",
      agentType: "claude-code",
      expiresAt: keyEnd,
    });
    const [row] = (
      await q<{ data: Record<string, unknown> }>(
        `select data from proposals where id = $1`,
        [proposalId]
      )
    ).rows;
    expect(row!.data.expiresAt).toBe(grantEnd.toISOString());
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

describe('a NEW agent from /setup/agent starts with "AI — read & propose"', () => {
  it("its key resolves to the preset: ask/orient/session/facet yes; delete/approve/vault no", async () => {
    const res = await provisionSurfaceAgentKey({
      agentType: "fresh-surface",
      createdByUserId: OWNER,
      linkedUserId: OWNER,
    });
    expect(res.alreadyValid).not.toBe(true);
    const keyId = (res as { keyId: string }).keyId;
    const caps = (
      await q<{ caps: string[] }>(
        `select agent_metadata -> 'capabilities' as caps from users where id = $1`,
        [res.agentUserId]
      )
    ).rows[0]!.caps;
    expect(caps).toEqual(aiDefaultCapabilities());

    const grant = (await new GrantRepository(h.db as never).resolveForKey(
      keyId
    ))!;
    expect(grant.scopes.flatMap((s) => [...s.permissions]).sort()).toEqual(
      agentKeyGrantPermissions(aiDefaultCapabilities()).permissions.sort()
    );

    for (const tool of ["synap_ask", "synap_orient", "synap_list_sessions"])
      expect(mcpToolAllowed(tool, true, grant), tool).toBe(true);

    const write = (subjectType: string, action: string) =>
      grantWriteDenial(
        {
          subjectType,
          action,
          data: subjectType === "entity" ? { profileSlug: "note" } : {},
        },
        grant
      );
    const rung = (subjectType: string, action: string) =>
      decideAgentPolicy({
        subjectType,
        action,
        agentCapabilities: caps,
        subjectKind: subjectType === "entity" ? "note" : undefined,
      } as Parameters<typeof decideAgentPolicy>[0]).verdict !== "deny";

    for (const [subject, action] of [
      ["focus_session", "create"],
      ["facet", "attach"],
      ["entity", "create"],
    ] as const) {
      expect(await write(subject, action), `${subject}.${action}`).toBeNull();
      expect(rung(subject, action), `${subject}.${action}`).toBe(true);
    }
    for (const [subject, action] of [
      ["entity", "delete"],
      ["proposal", "approve"],
      ["vault", "grant"],
    ] as const) {
      expect(
        await write(subject, action),
        `${subject}.${action}`
      ).not.toBeNull();
      expect(rung(subject, action), `${subject}.${action}`).toBe(false);
    }
  });

  it("createNamedAgent: a new named agent starts with the preset too", async () => {
    const res = await createNamedAgent({
      name: "Named",
      agentType: "named-fresh",
      createdByUserId: OWNER,
    });
    const caps = (
      await q<{ caps: string[] }>(
        `select agent_metadata -> 'capabilities' as caps from users where id = $1`,
        [res.agentUserId]
      )
    ).rows[0]!.caps;
    expect(caps).toEqual(aiDefaultCapabilities());
  });

  it("an EXISTING agent keeps its own limits ([] stays full access)", async () => {
    const res = await provisionSurfaceAgentKey({
      agentType: "codex",
      createdByUserId: OWNER,
      linkedUserId: OWNER,
    });
    expect(res.agentUserId).toBe(FULL_AGENT);
    const caps = (
      await q<{ caps: string[] }>(
        `select agent_metadata -> 'capabilities' as caps from users where id = $1`,
        [FULL_AGENT]
      )
    ).rows[0]!.caps;
    expect(caps).toEqual([]);
    const keyId = (res as { keyId: string }).keyId;
    expect(await grantOf(keyId)).toEqual([
      { permissions: ["*"], workspaceIds: null },
    ]);
  });
});

describe("re-applying capabilities NARROWS each key's own grant set, never rebuilds it", () => {
  const W1 = randomUUID();
  const P1 = randomUUID();
  async function agentWith(capabilities: string[]) {
    const id = randomUUID();
    await q(
      `insert into users (id, email, user_type, created_by_user_id, agent_type, agent_metadata)
       values ($1, $2, 'agent', $3, 'narrow', $4::jsonb)`,
      [id, `${id}@x`, OWNER, JSON.stringify({ capabilities })]
    );
    return id;
  }
  async function keyWithGrant(
    agent: string,
    grant: Record<string, unknown>,
    active = true
  ) {
    const id = randomUUID();
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope)
       values ($1, $2, $3, $4, 'hub_inbound', 'k', 'synap_', 'h', '{}')`,
      [id, agent, OWNER, active]
    );
    await new GrantRepository(h.db as never).attachMany([
      {
        apiKeyId: id,
        principalUserId: agent,
        onBehalfOf: OWNER,
        expiresAt: null,
        createdBy: OWNER,
        permissions: [],
        ...grant,
      } as never,
    ]);
    return id;
  }
  const liveRows = async (keyId: string) =>
    (
      await q<{
        permissions: string[];
        workspace_ids: string[] | null;
        project_ids: string[] | null;
        label: string | null;
        client_id: string | null;
      }>(
        `select permissions, workspace_ids, project_ids, label, client_id from grants
         where api_key_id = $1 and revoked_at is null`,
        [keyId]
      )
    ).rows;

  it("keeps the key's places, label and client; drops what the agent lost; adds nothing", async () => {
    const agent = await agentWith(["entity.note.create"]);
    const keyId = await keyWithGrant(agent, {
      permissions: ["entity.note.read", "entity.note.create", "document.read"],
      workspaceIds: [W1],
      projectIds: [P1],
      label: "Only the launch project",
      clientId: "cli-app",
    });
    await q(`update users set agent_metadata = $2::jsonb where id = $1`, [
      agent,
      JSON.stringify({ capabilities: ["entity.*.create"] }),
    ]);
    await reapplyAgentKeyGrants({ agentUserId: agent, createdBy: OWNER });
    const rows = await liveRows(keyId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.workspace_ids).toEqual([W1]);
      expect(r.project_ids).toEqual([P1]);
      expect(r.label).toBe("Only the launch project");
      expect(r.client_id).toBe("cli-app");
      expect(r.permissions).not.toContain("entity.*.create");
    }
    expect(rows.flatMap((r) => r.permissions)).toContain("entity.note.create");
  });

  it("a key left with nothing in common touches nothing", async () => {
    const agent = await agentWith(["entity.note.create"]);
    const keyId = await keyWithGrant(agent, {
      permissions: ["document.update"],
    });
    await q(`update users set agent_metadata = $2::jsonb where id = $1`, [
      agent,
      JSON.stringify({ capabilities: ["entity.note.create"] }),
    ]);
    await reapplyAgentKeyGrants({ agentUserId: agent, createdBy: OWNER });
    expect(await liveRows(keyId)).toEqual([]);
  });

  it("an app's own agent is skipped: its reach is the app's approved requests", async () => {
    const agent = await agentWith([]);
    await q(
      `insert into apps (id, public_id, name, owner_user_id, agent_user_id) values ($1, $2, 'App', $3, $4)`,
      [randomUUID(), `app_${agent.slice(0, 8)}`, OWNER, agent]
    );
    const keyId = await keyWithGrant(agent, {
      permissions: ["entity.note.read"],
      workspaceIds: [W1],
    });
    expect(
      await reapplyAgentKeyGrants({ agentUserId: agent, createdBy: OWNER })
    ).toBe(0);
    expect(await liveRows(keyId)).toEqual([
      expect.objectContaining({
        permissions: ["entity.note.read"],
        workspace_ids: [W1],
      }),
    ]);
  });

  it("approving agent/connect narrows the stored (project-pinned) grant, never rebuilds it wider", async () => {
    const keyId = await keyWithGrant(
      AGENT,
      {
        permissions: ["entity.*.read", "document.read"],
        projectIds: [P1],
      },
      false
    );
    const { proposalId } = await fileAgentConnectProposal({
      keyId,
      agentUserId: AGENT,
      ownerUserId: OWNER,
      agentName: "Claude-code",
      agentType: "claude-code",
      expiresAt: null,
    });
    const asked: AgentConnectRequest[] = [
      { permission: "entity.*.read", workspaceId: null },
      { permission: "document.read", workspaceId: null },
    ];
    await approveViaProposal(
      proposalId,
      [{ permission: "entity.*.read", workspaceId: null }],
      asked,
      keyId
    );
    expect(await liveRows(keyId)).toEqual([
      expect.objectContaining({
        permissions: ["entity.*.read"],
        project_ids: [P1],
      }),
    ]);
  });
});

describe("agent/connect — the approved proposal must name the key's own agent", () => {
  it("a payload naming another agent is refused and the key stays pending", async () => {
    const { keyId, proposalId } = await pendingConnection();
    const asked = [{ permission: "entity.*.read", workspaceId: null }];
    const data = { agentUserId: FULL_AGENT, keyId, requests: asked, asked };
    await expect(
      proposalExecRegistry.resolveExact("agent/connect")!.execute({
        proposal: {
          id: proposalId,
          targetType: "agent",
          targetId: FULL_AGENT,
          proposalType: "connect",
          workspaceId: null,
          data,
        },
        payload: null,
        userId: OWNER,
        input: { proposalId },
        ctx: {} as never,
        deps: {
          emitProposalReviewed: () => {},
          reportProposalOutcome: () => {},
        } as never,
      } as never)
    ).rejects.toThrow(/different agent/);
    expect(await keyRow(keyId)).toMatchObject({ is_active: false });
  });
});

describe("a pending connection never switches the agent's working keys off", () => {
  it("siblings stay live while it waits, and the same computer's is replaced when it is approved", async () => {
    // Same computer reconnecting (one instance id): approval replaces its old
    // key. Another computer's key is never replaced — see
    // agent-key-multi-computer.pglite.test.ts.
    const first = await provisionSurfaceAgentKey({
      agentType: "sibling-surface",
      createdByUserId: OWNER,
      linkedUserId: OWNER,
      instanceId: "m-this-computer",
    });
    const liveKey = (first as { keyId: string }).keyId;
    const pending = await provisionSurfaceAgentKey({
      agentType: "sibling-surface",
      createdByUserId: OWNER,
      linkedUserId: OWNER,
      instanceId: "m-this-computer",
      instanceLabel: "devbox",
      pendingApproval: true,
    });
    const pendingKey = (pending as { keyId: string }).keyId;
    // What /setup/agent does for a key caller: the new key waits inactive.
    await q(`update api_keys set is_active = false where id = $1`, [
      pendingKey,
    ]);
    expect(await keyRow(liveKey)).toMatchObject({
      is_active: true,
      revoked_at: null,
    });
    expect(
      await approvePendingAgentKey({ keyId: pendingKey, approverId: OWNER })
    ).toBe("approved");
    expect((await keyRow(liveKey)).revoked_at).not.toBeNull();
    expect(await keyRow(pendingKey)).toMatchObject({
      is_active: true,
      revoked_at: null,
    });
    // The mint door stores the computer's name the client sent.
    expect(
      (
        await q<{ instance_label: string | null }>(
          `select instance_label from api_keys where id = $1`,
          [pendingKey]
        )
      ).rows[0]!.instance_label
    ).toBe("devbox");
  });
});

describe("the idempotent re-provision counts only a LIVE key", () => {
  it("a key awaiting approval is not alreadyValid; an active one is", async () => {
    const base = {
      agentType: "idem-surface",
      createdByUserId: OWNER,
      linkedUserId: OWNER,
      instanceId: "m-idem",
    };
    const first = await provisionSurfaceAgentKey(base);
    const waiting = (first as { keyId: string }).keyId;
    // What /setup/agent does for a key that needs approval: it waits inactive,
    // never revoked — `awaiting_approval` (key-holder-state.ts).
    await q(`update api_keys set is_active = false where id = $1`, [waiting]);

    const again = await provisionSurfaceAgentKey({ ...base, idempotent: true });
    expect(again).not.toHaveProperty("alreadyValid");
    const minted = (again as { keyId: string }).keyId;
    expect(minted).not.toBe(waiting);
    expect(await keyRow(minted)).toMatchObject({
      is_active: true,
      revoked_at: null,
    });

    expect(
      await provisionSurfaceAgentKey({ ...base, idempotent: true })
    ).toMatchObject({ alreadyValid: true });
  });
});
