/**
 * Agent workspace-focus (WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md, Layer 2 —
 * advisory slice). DB-backed round-trip for `getAgentFocusWorkspaceId` /
 * `setAgentFocusWorkspace` — the read/write door for `agentMetadata.focusWorkspaceId`.
 * Same live-DB pattern as `external-user-mapping.test.ts` / `api-keys.test.ts`.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import { db, users, eq } from "@synap/database";
import {
  getAgentFocusWorkspaceId,
  setAgentFocusWorkspace,
} from "./agent-identity-service.js";

describe("agent workspace-focus (agentMetadata.focusWorkspaceId)", () => {
  const agentUserId = `test-agent-focus-${randomUUID()}`;

  afterEach(async () => {
    await db.delete(users).where(eq(users.id, agentUserId));
  });

  async function createAgentUser(
    agentMetadata: Record<string, unknown> | null = null
  ) {
    await db.insert(users).values({
      id: agentUserId,
      email: `${agentUserId}@synap.agent`,
      name: "Test Focus Agent",
      userType: "agent",
      emailVerified: true,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
      agentMetadata: agentMetadata as never,
    });
  }

  it("returns null when the agent has no agentMetadata", async () => {
    await createAgentUser(null);
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBeNull();
  });

  it("returns null when agentMetadata exists but has no focusWorkspaceId", async () => {
    await createAgentUser({
      agentType: "test",
      createdByUserId: "someone",
    });
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBeNull();
  });

  it("sets the focus and reads it back live", async () => {
    await createAgentUser({ agentType: "test", createdByUserId: "someone" });
    const wsId = randomUUID();

    await setAgentFocusWorkspace(agentUserId, wsId);

    expect(await getAgentFocusWorkspaceId(agentUserId)).toBe(wsId);

    const [row] = await db
      .select({ agentMetadata: users.agentMetadata })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    expect(
      (row?.agentMetadata as unknown as Record<string, unknown>)?.focusMode
    ).toBe("advisory");
    // Merge, not overwrite: sibling agentMetadata fields survive.
    expect(
      (row?.agentMetadata as unknown as Record<string, unknown>)?.agentType
    ).toBe("test");
  });

  it("clears the focus with workspaceId: null, leaving the rest of agentMetadata intact", async () => {
    await createAgentUser({
      agentType: "test",
      createdByUserId: "someone",
      autoApproveFor: ["entities.create"],
    });
    const wsId = randomUUID();
    await setAgentFocusWorkspace(agentUserId, wsId);
    expect(await getAgentFocusWorkspaceId(agentUserId)).toBe(wsId);

    await setAgentFocusWorkspace(agentUserId, null);

    expect(await getAgentFocusWorkspaceId(agentUserId)).toBeNull();
    const [row] = await db
      .select({ agentMetadata: users.agentMetadata })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const meta = row?.agentMetadata as unknown as Record<string, unknown>;
    expect(meta.focusWorkspaceId).toBeUndefined();
    expect(meta.focusMode).toBeUndefined();
    expect(meta.autoApproveFor).toEqual(["entities.create"]);
  });

  it("returns null for an agent user id that doesn't exist", async () => {
    expect(await getAgentFocusWorkspaceId(randomUUID())).toBeNull();
  });
});
