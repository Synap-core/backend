/**
 * The project/workspace tools an agent uses to shape an engagement:
 * `synap_list_projects`, `synap_list_workspaces`, `synap_update_project`,
 * `synap_project_use_workspace`. DB-backed (localhost:5432/synap_test), driven
 * through the real MCP dispatcher — nothing hand-built between the tool call
 * and the rows it reads or writes.
 *
 * What is pinned, and why each one matters to an agent:
 *   - the list tools return LEAN rows (no settings blob, no deprecated
 *     `projects` duplicate) that still carry the INDEX an agent needs to act:
 *     usedWorkspaceIds / usedByProjectIds / entityCount;
 *   - a link on a project the caller cannot see is refused BEFORE governance,
 *     so no proposal is filed that approval could only write as a ghost edge;
 *   - an agent's `reasoning` reaches the proposal the human reviews, for both
 *     the update and the link (it used to be accepted and dropped).
 */

import { randomUUID } from "crypto";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  db,
  users,
  workspaces,
  workspaceMembers,
  projects,
  proposals,
  links,
  eq,
  and,
  inArray,
} from "@synap/database";
import { executeMCPToolViaHubProtocol } from "../adapter.js";

function parse(
  result: Awaited<ReturnType<typeof executeMCPToolViaHubProtocol>>
) {
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  return JSON.parse(text) as Record<string, any>;
}

describe("project/workspace MCP tools (DB-backed)", () => {
  const human = `test-pw-human-${randomUUID()}`;
  const stranger = `test-pw-stranger-${randomUUID()}`;
  const agent = `test-pw-agent-${randomUUID()}`;
  const wsId = randomUUID();
  const projectId = randomUUID();
  const foreignProjectId = randomUUID();

  beforeAll(async () => {
    await db.insert(users).values(
      [human, stranger].map((id) => ({
        id,
        email: `${id}@synap.test`,
        name: id,
        userType: "human",
        emailVerified: false,
        kratosIdentityId: null,
        timezone: "UTC",
        locale: "en",
      })) as never
    );
    await db.insert(users).values({
      id: agent,
      email: `${agent}@synap.agent`,
      name: "Test PW Agent",
      userType: "agent",
      emailVerified: true,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
      agentMetadata: { agentType: "test", createdByUserId: human } as never,
    } as never);
    await db.insert(workspaces).values({
      id: wsId,
      name: "Test PW Operations",
      ownerId: human,
      workspaceType: "personal",
    } as never);
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsId, userId: human, role: "owner" } as never);
    // Pod-personal projects: visible only to their owner.
    await db.insert(projects).values([
      { id: projectId, userId: human, name: "Test PW Launch" },
      { id: foreignProjectId, userId: stranger, name: "Test PW Foreign" },
    ] as never);
  });

  afterAll(async () => {
    await db
      .delete(links)
      .where(inArray(links.fromId, [projectId, foreignProjectId]));
    await db
      .delete(proposals)
      .where(inArray(proposals.createdBy, [human, stranger, agent]));
    await db
      .delete(projects)
      .where(inArray(projects.id, [projectId, foreignProjectId]));
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(users).where(inArray(users.id, [human, stranger, agent]));
  });

  it("links a visible project to a workspace (human, direct) and both lists show the INDEX", async () => {
    const linked = parse(
      await executeMCPToolViaHubProtocol(
        "synap_project_use_workspace",
        { projectId, workspaceId: wsId },
        human,
        ["mcp.write"]
      )
    );
    expect(linked.status).toBe("linked");

    const listed = parse(
      await executeMCPToolViaHubProtocol("synap_list_projects", {}, human, [
        "mcp.read",
      ])
    );
    expect(listed.error).toBeUndefined();
    const row = listed.items.find((p: { id: string }) => p.id === projectId);
    expect(row).toBeDefined();
    expect(row.usedWorkspaceIds).toEqual([wsId]);
    expect(row.name).toBe("Test PW Launch");
    // Lean: no settings blob, no deprecated duplicate array.
    expect(row).not.toHaveProperty("settings");
    expect(listed).not.toHaveProperty("projects");
    expect(listed.pagination).toBeDefined();
    // The caller never sees a project it cannot see.
    expect(
      listed.items.some((p: { id: string }) => p.id === foreignProjectId)
    ).toBe(false);

    const ws = parse(
      await executeMCPToolViaHubProtocol("synap_list_workspaces", {}, human, [
        "mcp.read",
      ])
    );
    expect(ws.error).toBeUndefined();
    const wsRow = ws.workspaces.find((w: { id: string }) => w.id === wsId);
    expect(wsRow).toBeDefined();
    expect(wsRow.usedByProjectIds).toEqual([projectId]);
    expect(wsRow.entityCount).toBe(0);
    expect(wsRow.role).toBe("owner");
    expect(wsRow).not.toHaveProperty("settings");
  });

  it("refuses a link on a project the caller cannot see, and files NO proposal", async () => {
    const before = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.createdBy, [human, agent]));
    const refused = parse(
      await executeMCPToolViaHubProtocol(
        "synap_project_use_workspace",
        {
          projectId: foreignProjectId,
          workspaceId: wsId,
          reasoning: "should not land",
        },
        human,
        ["mcp.write"],
        undefined,
        agent
      )
    );
    expect(refused.error).toBe("Project not found");
    const after = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.createdBy, [human, agent]));
    expect(after.length).toBe(before.length);
    const edges = await db
      .select({ id: links.id })
      .from(links)
      .where(
        and(eq(links.fromId, foreignProjectId), eq(links.linkType, "uses"))
      );
    expect(edges).toHaveLength(0);
  });

  it("carries the agent's reasoning and the new fields into the update the human reviews", async () => {
    const reason = `rename for the Bpifrance deadline ${randomUUID()}`;
    const out = parse(
      await executeMCPToolViaHubProtocol(
        "synap_update_project",
        {
          projectId,
          name: "Test PW Launch (renamed)",
          phase: "wedge A",
          targetDate: "2026-12-15",
          reasoning: reason,
        },
        human,
        ["mcp.write"],
        undefined,
        agent
      )
    );
    // An agent's structure write is governed: it never auto-applies on this
    // pod's default policy, and the proposal must carry the reason AND the
    // full patch (the `project/update` executor replays the patch verbatim).
    expect(out.status).toBe("proposed");
    expect(out.reviewUrl).toEqual(expect.any(String));
    const [row] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, out.proposalId));
    const stored = JSON.stringify(row);
    expect(stored).toContain(reason);
    expect(stored).toContain("wedge A");
    expect(stored).toContain("2026-12-15");
    // Nothing applied yet.
    const [p] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(p.phase).toBeNull();
  });
});
