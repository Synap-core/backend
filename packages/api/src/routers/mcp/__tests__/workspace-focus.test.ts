/**
 * Advisory workspace focus — WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md, Layer 2.
 *
 * Two things are pinned here:
 *   1. `pickAdvisoryWorkspaceId` — the pure precedence rule: an explicit
 *      per-call workspaceId (or a bound service-key pin, both folded into
 *      `confinedWorkspaceId` upstream) ALWAYS wins; the agent's live focus is
 *      consulted ONLY when that resolved to nothing.
 *   2. `synap_set_workspace_focus` — DB-backed end-to-end: name→id resolution
 *      against the caller's own workspaces, ambiguous/unknown-name handling,
 *      the clear path, and the "no agent identity" guard.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import { db, users, workspaces, workspaceMembers, eq } from "@synap/database";
import {
  pickAdvisoryWorkspaceId,
  executeMCPToolViaHubProtocol,
} from "../adapter.js";
import { getAgentFocusWorkspaceId } from "../../../services/agent-identity-service.js";

describe("pickAdvisoryWorkspaceId (pure precedence)", () => {
  it("prefers the confined/explicit id over the agent's focus", () => {
    expect(pickAdvisoryWorkspaceId("explicit-ws", "focus-ws")).toBe(
      "explicit-ws"
    );
  });

  it("falls back to the agent's focus when nothing else resolved", () => {
    expect(pickAdvisoryWorkspaceId(undefined, "focus-ws")).toBe("focus-ws");
  });

  it("returns undefined when neither is set", () => {
    expect(pickAdvisoryWorkspaceId(undefined, undefined)).toBeUndefined();
    expect(pickAdvisoryWorkspaceId(undefined, null)).toBeUndefined();
  });
});

describe("synap_set_workspace_focus (DB-backed)", () => {
  const humanUserId = `test-focus-human-${randomUUID()}`;
  const agentUserId = `test-focus-agent-${randomUUID()}`;
  const wsAId = randomUUID();
  const wsBId = randomUUID();

  afterEach(async () => {
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, humanUserId));
    await db.delete(workspaces).where(eq(workspaces.id, wsAId));
    await db.delete(workspaces).where(eq(workspaces.id, wsBId));
    await db.delete(users).where(eq(users.id, humanUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
  });

  async function setUp(names: { a: string; b: string }) {
    await db.insert(users).values({
      id: humanUserId,
      email: `${humanUserId}@synap.test`,
      name: "Test Focus Human",
      userType: "human",
      emailVerified: false,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
    });
    await db.insert(users).values({
      id: agentUserId,
      email: `${agentUserId}@synap.agent`,
      name: "Test Focus Agent",
      userType: "agent",
      emailVerified: true,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
      agentMetadata: {
        agentType: "test",
        createdByUserId: humanUserId,
      } as never,
    });
    await db.insert(workspaces).values([
      {
        id: wsAId,
        name: names.a,
        ownerId: humanUserId,
        workspaceType: "personal",
      } as never,
      {
        id: wsBId,
        name: names.b,
        ownerId: humanUserId,
        workspaceType: "personal",
      } as never,
    ]);
    await db
      .insert(workspaceMembers)
      .values([
        { workspaceId: wsAId, userId: humanUserId, role: "owner" } as never,
        { workspaceId: wsBId, userId: humanUserId, role: "owner" } as never,
      ]);
  }

  it("resolves a workspace by exact name and writes the focus", async () => {
    await setUp({ a: "CRM", b: "Marketing" });

    const result = await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "CRM" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("focused");
    expect(parsed.workspaceId).toBe(wsAId);

    expect(await getAgentFocusWorkspaceId(agentUserId)).toBe(wsAId);
  });

  it("errors with candidates when the name matches more than one workspace", async () => {
    await setUp({ a: "CRM Sales", b: "CRM Support" });

    const result = await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "CRM" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/matches 2 workspaces/);
    expect(parsed.candidates).toHaveLength(2);
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBeNull();
  });

  it("errors when no workspace matches the name", async () => {
    await setUp({ a: "CRM", b: "Marketing" });

    const result = await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "Nonexistent Workspace" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/No workspace named/);
  });

  it("clears the focus when workspace is omitted", async () => {
    await setUp({ a: "CRM", b: "Marketing" });
    await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "CRM" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBe(wsAId);

    const result = await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "clear" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("cleared");
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBeNull();
  });

  it("refuses to set a focus with no agent identity on the key", async () => {
    await setUp({ a: "CRM", b: "Marketing" });

    const result = await executeMCPToolViaHubProtocol(
      "synap_set_workspace_focus",
      { workspace: "CRM" },
      humanUserId,
      ["mcp.write"],
      undefined,
      undefined // no agentUserId — bare human/service key
    );
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/No agent identity/);
  });
});

/**
 * Phase A3 — domain MCP writes must not silently land on membership[0].
 * Capture text (and the same class of write tools) reject with available
 * workspaces when neither an explicit lens nor advisory focus resolved.
 */
describe("synap_capture domain write placement (no silent membership[0])", () => {
  const humanUserId = `test-capture-ws-human-${randomUUID()}`;
  const agentUserId = `test-capture-ws-agent-${randomUUID()}`;
  const wsAId = randomUUID();
  const wsBId = randomUUID();

  afterEach(async () => {
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, humanUserId));
    await db.delete(workspaces).where(eq(workspaces.id, wsAId));
    await db.delete(workspaces).where(eq(workspaces.id, wsBId));
    await db.delete(users).where(eq(users.id, humanUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
  });

  async function setUp() {
    await db.insert(users).values({
      id: humanUserId,
      email: `${humanUserId}@synap.test`,
      name: "Test Capture WS Human",
      userType: "human",
      emailVerified: false,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
    });
    await db.insert(users).values({
      id: agentUserId,
      email: `${agentUserId}@synap.agent`,
      name: "Test Capture WS Agent",
      userType: "agent",
      emailVerified: true,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
      agentMetadata: {
        agentType: "test",
        createdByUserId: humanUserId,
      } as never,
    });
    await db.insert(workspaces).values([
      {
        id: wsAId,
        name: "CRM",
        ownerId: humanUserId,
        workspaceType: "personal",
      } as never,
      {
        id: wsBId,
        name: "Marketing",
        ownerId: humanUserId,
        workspaceType: "personal",
      } as never,
    ]);
    await db
      .insert(workspaceMembers)
      .values([
        { workspaceId: wsAId, userId: humanUserId, role: "owner" } as never,
        { workspaceId: wsBId, userId: humanUserId, role: "owner" } as never,
      ]);
  }

  it("rejects domain text capture without workspaceId/focus (lists available)", async () => {
    await setUp();

    const result = await executeMCPToolViaHubProtocol(
      "synap_capture",
      { text: "Ada left Acme last Friday" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("rejected");
    expect(parsed.reason).toBe("workspace-required");
    expect(parsed.message).toMatch(/refusing to pick an arbitrary membership/);
    expect(parsed.message).toMatch(/synap_orient/);
    expect(parsed.availableWorkspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: wsAId, name: "CRM" }),
        expect.objectContaining({ id: wsBId, name: "Marketing" }),
      ])
    );
    expect(parsed.writeReceipt?.state).toBe("rejected");
    expect(parsed.scope?.workspaceId).toBeNull();
  });

  it("still rejects no-durable-content before placement when text is empty", async () => {
    await setUp();

    // Empty payload must not become workspace-required (and must not write).
    const result = await executeMCPToolViaHubProtocol(
      "synap_capture",
      { text: "  " },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("rejected");
    expect(parsed.reason).toBe("no-durable-content");
  });

  it("rejects create_project without workspace the same way", async () => {
    await setUp();

    const result = await executeMCPToolViaHubProtocol(
      "synap_create_project",
      { name: "Orphan Project" },
      humanUserId,
      ["mcp.write"],
      undefined,
      agentUserId
    );

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/refusing to pick an arbitrary membership/);
    expect(parsed.availableWorkspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: wsAId, name: "CRM" }),
      ])
    );
  });
});
