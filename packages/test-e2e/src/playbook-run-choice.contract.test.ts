/**
 * Who runs a playbook: the Hub REST doors, over real HTTP against a running
 * API (run choice v3, decisions D3, D4, D6, D7).
 *
 *   GET /api/hub/playbooks/{id}/run-choice  the read an app's run button draws;
 *   PUT /api/hub/playbooks/{id}/run-choice  remember the choice: a person's key
 *                                           applies it, an agent's key files a
 *                                           proposal (202) and stores nothing.
 *
 * Seeds its own person, space, agent, playbook and two keys (the person's and
 * the agent's, each with the full grant) and removes them after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import {
  db,
  eq,
  users,
  workspaces,
  workspaceMembers,
  apiKeys,
  playbooks,
  links,
  proposals,
  GrantRepository,
} from "@synap/database";

const TEST_API_PORT = process.env.TEST_API_PORT ?? "4000";
const HUB_BASE = `http://127.0.0.1:${TEST_API_PORT}/api/hub`;

async function hub(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${HUB_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const PERSON = `run-choice-${randomUUID()}`;
const AGENT = randomUUID();
let workspaceId = "";
let playbookId = "";
let personKey = "";
let agentKey = "";
const keyIds: string[] = [];

async function mintKey(userId: string, linkedUserId: string | null) {
  const raw = `synap_hub_test_${randomBytes(32).toString("hex")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      ...(linkedUserId ? { linkedUserId } : {}),
      keyName: "run-choice-contract",
      keyPrefix: "synap_hub_test_",
      keyHash: await bcrypt.hash(raw, 12),
      keyType: "hub_inbound",
      scope: ["hub-protocol.read", "hub-protocol.write"],
      isActive: true,
      usageCount: 0,
    })
    .returning({ id: apiKeys.id });
  keyIds.push(row.id);
  await new GrantRepository(db).attach({
    apiKeyId: row.id,
    principalUserId: userId,
    onBehalfOf: linkedUserId ?? userId,
    permissions: ["*"],
    expiresAt: null,
    label: "Full access",
    createdBy: linkedUserId ?? userId,
  });
  return raw;
}

describe("Hub REST: who runs a playbook", () => {
  beforeAll(async () => {
    await db.insert(users).values([
      {
        id: PERSON,
        email: `${PERSON}@synap.test`,
        name: "Run Choice Person",
        userType: "human",
        emailVerified: true,
      },
      {
        id: AGENT,
        email: `${AGENT}@agents.synap.test`,
        name: "Claude Code",
        userType: "agent",
        agentType: "claude-code",
        createdByUserId: PERSON,
      },
    ]);
    const [ws] = await db
      .insert(workspaces)
      .values({ ownerId: PERSON, name: "Run Choice Space", type: "personal" })
      .returning({ id: workspaces.id });
    workspaceId = ws.id;
    // The agent is in the space, so its ask is the run-choice proposal itself
    // (not a request to join the space first).
    await db.insert(workspaceMembers).values([
      { workspaceId, userId: PERSON, role: "owner" },
      { workspaceId, userId: AGENT, role: "editor" },
    ]);
    const [pb] = await db
      .insert(playbooks)
      .values({
        workspaceId,
        createdBy: PERSON,
        name: `Package ideas ${randomUUID().slice(0, 8)}`,
        goalTemplate: "Package the bank",
        executor: "is-agent",
        status: "active",
      })
      .returning({ id: playbooks.id });
    playbookId = pb.id;
    personKey = await mintKey(PERSON, null);
    agentKey = await mintKey(AGENT, PERSON);
  }, 60_000);

  afterAll(async () => {
    await db
      .delete(links)
      .where(eq(links.toId, playbookId))
      .catch(() => {});
    await db
      .delete(proposals)
      .where(eq(proposals.workspaceId, workspaceId))
      .catch(() => {});
    for (const id of keyIds) {
      await db
        .delete(apiKeys)
        .where(eq(apiKeys.id, id))
        .catch(() => {});
    }
    await db
      .delete(playbooks)
      .where(eq(playbooks.id, playbookId))
      .catch(() => {});
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .catch(() => {});
    await db
      .delete(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .catch(() => {});
    await db
      .delete(users)
      .where(eq(users.id, AGENT))
      .catch(() => {});
    await db
      .delete(users)
      .where(eq(users.id, PERSON))
      .catch(() => {});
  });

  it("GET: nothing stored asks, Synap AI first with the provider it uses, hidden listed", async () => {
    const { status, body } = await hub(
      "GET",
      `/playbooks/${playbookId}/run-choice`,
      personKey
    );
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.stored).toBeNull();
    expect(body.ask).toBe(true);
    const options = body.options as Array<Record<string, unknown>>;
    expect(options[0]).toMatchObject({
      choice: { executor: "is-agent" },
      recommended: true,
    });
    expect(String(options[0].label)).toMatch(/^Synap AI · using /);
    expect(options[0].provider).toEqual(
      expect.objectContaining({ key: expect.any(String) })
    );
    expect(Array.isArray(body.hidden)).toBe(true);
  });

  it("PUT with an agent's key: a proposal (202), nothing stored", async () => {
    const { status, body } = await hub(
      "PUT",
      `/playbooks/${playbookId}/run-choice`,
      agentKey,
      { choice: { executor: "external-agent", agentUserId: AGENT } }
    );
    expect(status, JSON.stringify(body)).toBe(202);
    expect(body.status).toBe("proposed");
    expect(typeof body.proposalId).toBe("string");
    expect(body.runChoice).toBeNull();
    const [filed] = await db
      .select({
        targetType: proposals.targetType,
        proposalType: proposals.proposalType,
      })
      .from(proposals)
      .where(eq(proposals.id, String(body.proposalId)));
    expect(filed).toEqual({
      targetType: "playbook",
      proposalType: "set_run_choice",
    });
    const read = await hub(
      "GET",
      `/playbooks/${playbookId}/run-choice`,
      personKey
    );
    expect(read.body.stored).toBeNull();
  });

  it("PUT with the person's key: applied (200), the next read does not ask", async () => {
    const { status, body } = await hub(
      "PUT",
      `/playbooks/${playbookId}/run-choice`,
      personKey,
      { choice: { executor: "external-agent", agentUserId: AGENT } }
    );
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("applied");
    const runChoice = body.runChoice as Record<string, unknown>;
    expect(runChoice.stored).toEqual({
      executor: "external-agent",
      agentUserId: AGENT,
    });
    expect(runChoice.ask).toBe(false);
  });

  it("PUT with an unusable choice: 400", async () => {
    const { status } = await hub(
      "PUT",
      `/playbooks/${playbookId}/run-choice`,
      personKey,
      { choice: { executor: "someone" } }
    );
    expect(status).toBe(400);
  });
});
