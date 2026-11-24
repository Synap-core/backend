/**
 * `synap_request_workspace_access` — an agent checks it can work in a space
 * BEFORE its first write. An agent is never a space member: the answer is the
 * membership of the person it acts for, within the key's grant, and nothing
 * is ever filed.
 *
 * Driven through the REAL MCP handler, the REAL `requestWorkspaceJoin` and
 * the gate's REAL membership check, on PGlite with every table. Rows rule
 * out: a seat the agent still holds counting as access, a proposal filed for
 * any answer, a grant that does not reach the space, an archived space told
 * "member", and a space that does not exist.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
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

import { runWithGrant } from "@synap/database";
import {
  allSchemaTables,
  pgliteSchemaDdl,
} from "../../../__tests__/pglite-ddl.js";
import { workspaceHandlers } from "./workspace.js";
import { AGENT_PERSON_NOT_MEMBER } from "../../../utils/permission-check.js";

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID(); // the person is an editor
const WS_SEAT = randomUUID(); // the person is not a member; the agent holds a seat
const WS_ARCHIVED = randomUUID(); // archived; the person is an editor
const WS_OWNED = randomUUID(); // the person owns it
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id) values ($1, 'h@x', 'Human', 'human', null), ($2, 'a@x', 'Scout', 'agent', $1)`,
    [HUMAN, AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, archived_at) values
      ($1, 'Sales', $4, 'team', '{}'::jsonb, null),
      ($2, 'Builder', $4, 'team', '{}'::jsonb, null),
      ($3, 'Old', $4, 'team', '{}'::jsonb, now()),
      ($5, 'Mine', $4, 'team', '{}'::jsonb, null)`,
    [WS, WS_SEAT, WS_ARCHIVED, randomUUID(), WS_OWNED]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS_OWNED, HUMAN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor'), ($4, $5, $3, 'editor'), ($6, $7, $8, 'admin')`,
    [
      randomUUID(),
      WS,
      HUMAN,
      randomUUID(),
      WS_ARCHIVED,
      randomUUID(),
      WS_SEAT,
      AGENT,
    ]
  );
}, 120_000);

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

const proposalCount = async () => {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from proposals`
  );
  return rows[0]!.n;
};

describe("synap_request_workspace_access — the person's membership, nothing filed", () => {
  it("the person is a member ⇒ member, with the person's role", async () => {
    expect(await requestAccess(WS)).toMatchObject({
      status: "member",
      workspaceId: WS,
      role: "editor",
    });
    expect(await proposalCount()).toBe(0);
  });

  it("the person is not a member ⇒ refused, though the agent holds a seat there", async () => {
    const res = await requestAccess(WS_SEAT);
    expect(res.status).toBe("refused");
    expect(res.reason).toBe(AGENT_PERSON_NOT_MEMBER);
    expect(await proposalCount()).toBe(0);
  });

  it("the person owns the space ⇒ the agent acts there as an editor, never an owner", async () => {
    expect(await requestAccess(WS_OWNED)).toMatchObject({
      status: "member",
      role: "editor",
    });
  });

  it("a key whose grant does not reach the space ⇒ refused", async () => {
    const res = await requestAccess(WS, {
      scopes: [{ permissions: ["*"], workspaceIds: [WS_SEAT] }],
      clientId: null,
    });
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/grant does not reach this whole space/);
  });

  it("control: a grant that names the space ⇒ member", async () => {
    const res = await requestAccess(WS, {
      scopes: [{ permissions: ["*"], workspaceIds: [WS] }],
      clientId: null,
    });
    expect(res.status).toBe("member");
  });

  it("an archived space ⇒ refused as archived, never told 'member'", async () => {
    const res = await requestAccess(WS_ARCHIVED);
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/archived/);
  });

  it("a space that does not exist ⇒ refused", async () => {
    const res = await requestAccess(randomUUID());
    expect(res.status).toBe("refused");
    expect(String(res.reason)).toMatch(/No space has this id/);
  });
});
