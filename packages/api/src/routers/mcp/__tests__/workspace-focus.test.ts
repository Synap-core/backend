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
