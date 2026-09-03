/**
 * `resolveEntityWorkspaceId` (shared.ts) — the third arbitrary-workspace-pick
 * fix (`synap_match_playbooks`, mirroring the earlier `synap_get_relations`
 * fix). Pins the required behaviour: when an entityId is named, ITS
 * workspace is the lens — never whichever member workspace an unordered
 * SELECT happens to sort first.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import {
  db,
  users,
  workspaces,
  workspaceMembers,
  entities,
  eq,
} from "@synap/database";
import { resolveEntityWorkspaceId } from "../handlers/shared.js";

describe("resolveEntityWorkspaceId (DB-backed)", () => {
  const userId = `test-resolve-ws-user-${randomUUID()}`;
  const entityWsId = randomUUID();
  const memberWsId = randomUUID();
  const entityId = randomUUID();

  afterEach(async () => {
    await db.delete(entities).where(eq(entities.id, entityId));
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    await db.delete(workspaces).where(eq(workspaces.id, entityWsId));
    await db.delete(workspaces).where(eq(workspaces.id, memberWsId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("resolves the ENTITY's own workspace, not the caller's first member workspace", async () => {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@synap.test`,
      name: "Test Resolve Ws User",
      userType: "human",
      emailVerified: false,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
    });
    // Two distinct workspaces: the caller is a MEMBER of one (memberWsId) but
    // the entity being matched/related lives in the OTHER (entityWsId). If
    // the fix regresses to `getUserMemberWorkspaceIds(userId)[0]`, this test
    // will see memberWsId returned instead of entityWsId.
    await db.insert(workspaces).values([
      {
        id: entityWsId,
        name: "Entity Home Workspace",
        ownerId: userId,
        workspaceType: "personal",
      },
      {
        id: memberWsId,
        name: "Unrelated Member Workspace",
        ownerId: userId,
        workspaceType: "personal",
      },
    ] as never);
    await db.insert(workspaceMembers).values({
      userId,
      workspaceId: memberWsId,
      role: "owner",
    } as never);
    await db.insert(entities).values({
      id: entityId,
      userId,
      workspaceId: entityWsId,
      type: "note",
      title: "Entity in its own workspace",
    } as never);

    const resolved = await resolveEntityWorkspaceId(userId, entityId);

    expect(resolved.workspaceId).toBe(entityWsId);
    expect(resolved.workspaceId).not.toBe(memberWsId);
    expect(resolved.autoPicked).toBe(false);
    expect(resolved.memberCount).toBe(0);
  });

  it("falls back to first member workspace, and discloses it, when no entityId is given", async () => {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@synap.test`,
      name: "Test Resolve Ws User",
      userType: "human",
      emailVerified: false,
      kratosIdentityId: null,
      timezone: "UTC",
      locale: "en",
    });
    await db.insert(workspaces).values({
      id: memberWsId,
      name: "Unrelated Member Workspace",
      ownerId: userId,
      workspaceType: "personal",
    } as never);
    await db.insert(workspaceMembers).values({
      userId,
      workspaceId: memberWsId,
      role: "owner",
    } as never);

    const resolved = await resolveEntityWorkspaceId(userId, undefined);

    expect(resolved.workspaceId).toBe(memberWsId);
    expect(resolved.autoPicked).toBe(true);
    expect(resolved.memberCount).toBe(1);
  });
});
