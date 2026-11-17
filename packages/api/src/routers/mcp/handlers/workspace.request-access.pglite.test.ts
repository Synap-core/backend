/**
 * `synap_request_workspace_access` (ticket 4790c862) — an agent asks to join
 * a space BEFORE its first write, instead of learning it on that write.
 *
 * Driven through the REAL MCP handler, the REAL `requestWorkspaceJoin`, the
 * gate's REAL membership check and its REAL join producer
 * (`maybeCreateWorkspaceJoinProposal`), on PGlite with every table. Stubbed:
 * the event-backed proposal writer → a plain insert of the same row (the
 * event spine has its own suites).
 *
 * Rows rule out: a second join stacked for the same space (the gate's reuse),
 * a join filed for an agent that is already a member, a join filed when the
 * key's grant cannot reach the space (it would change nothing), a join into
 * an archived space, and a join filed for a space that does not exist.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: async () => ({ id: randomUUID() }),
}));
vi.mock("../../../utils/event-backed-proposal.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/event-backed-proposal.js")
  >()),
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, session_id, data, created_at, updated_at)
       values ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())`,
      [
        id,
        input.proposalType,
        input.targetType,
        input.targetId,
        input.workspaceId ?? null,
        input.agentUserId ?? null,
        input.createdBy ?? input.userId,
        input.sessionId ?? null,
        JSON.stringify(input.data ?? {}),
      ]
    );
    return {
      proposal: { id, data: input.data },
      requestedEvent: null,
      correlationId: "c",
    };
  },
}));

import { runWithGrant } from "@synap/database";
import {
  allSchemaTables,
  pgliteSchemaDdl,
} from "../../../__tests__/pglite-ddl.js";
import { workspaceHandlers } from "./workspace.js";

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID(); // the agent is not a member
const WS_MEMBER = randomUUID(); // the agent is an editor
const WS_ARCHIVED = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent')`,
    [HUMAN, AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, archived_at) values
      ($1, 'Sales', $4, 'team', '{}'::jsonb, null),
      ($2, 'Builder', $4, 'team', '{}'::jsonb, null),
      ($3, 'Old', $4, 'team', '{}'::jsonb, now())`,
    [WS, WS_MEMBER, WS_ARCHIVED, HUMAN]
  );
  for (const ws of [WS, WS_MEMBER, WS_ARCHIVED]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, HUMAN]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), WS_MEMBER, AGENT]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from proposals`);
});

async function requestAccess(
  workspaceId: string,
  grant?: { scopes: unknown[]; clientId: null }
) {
  const call = () =>
    workspaceHandlers.synap_request_workspace_access!({
      toolName: "synap_request_workspace_access",
      args: { workspaceId },
      userId: HUMAN,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
      confinedWorkspaceId: workspaceId,
    } as never);
  const res = await (grant ? runWithGrant(grant as never, call) : call());
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

const joins = () =>
  q<{ id: string; target_id: string; agent_user_id: string }>(
    `select id, target_id, agent_user_id from proposals where target_type = 'workspace' and proposal_type = 'join'`
  ).then((r) => r.rows);

describe("synap_request_workspace_access — the gate's own join, asked for on purpose", () => {
  it("not a member ⇒ ONE join for the person to approve; asked again, the same one", async () => {
    const first = await requestAccess(WS);
    expect(first).toMatchObject({ status: "proposed", workspaceId: WS });
    expect(String(first.message)).toMatch(/kept on the join and replayed/);
    const rows = await joins();
    expect(rows).toEqual([
      { id: first.proposalId, target_id: WS, agent_user_id: AGENT },
    ]);

    const again = await requestAccess(WS);
    expect(again.proposalId).toBe(first.proposalId);
    expect(await joins()).toHaveLength(1);
  });

  it("already a member ⇒ its role, nothing filed", async () => {
    expect(await requestAccess(WS_MEMBER)).toMatchObject({
      status: "member",
      role: "editor",
    });
    expect(await joins()).toEqual([]);
  });

  it("a key whose grant does not reach the space ⇒ refused, nothing filed", async () => {
    const res = await requestAccess(WS, {
      scopes: [{ permissions: ["*"], workspaceIds: [WS_MEMBER] }],
      clientId: null,
    });
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/grant does not reach this space/);
    expect(await joins()).toEqual([]);
  });

  it("control: a grant that names the space files the join", async () => {
    const res = await requestAccess(WS, {
      scopes: [{ permissions: ["*"], workspaceIds: [WS] }],
      clientId: null,
    });
    expect(res.status).toBe("proposed");
    expect(await joins()).toHaveLength(1);
  });

  it("an archived space ⇒ refused in words, nothing filed", async () => {
    const res = await requestAccess(WS_ARCHIVED);
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/archived/);
    expect(await joins()).toEqual([]);
  });

  it("a space that does not exist ⇒ refused, nothing filed", async () => {
    const res = await requestAccess(randomUUID());
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/No space has this id/);
    expect(await joins()).toEqual([]);
  });
});
