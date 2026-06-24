/**
 * channelVisibilityWhere — integration tests
 *
 * Tests the three branches of channel visibility:
 *   1. User owns the channel (channels.userId = me)
 *   2. User is an explicit member (channel_members row)
 *   3. Shared-type channel in a workspace the user belongs to (member or owner)
 *
 * Branch 3 is specifically verified NOT to match pod-visible workspaces
 * where the user isn't a member — that was the leak path before we removed
 * userVisibleWhere from the predicate.
 *
 * These tests require a running Postgres (DATABASE_URL from vitest config).
 * They skip if the connection fails.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  channels,
  channelMembers,
  workspaceMembers,
  workspaces,
  users,
  ChannelType,
  ChannelMemberKind,
  ChannelMemberRole,
  ChannelStatus,
  drizzleSql,
} from "@synap/database";
import { channelVisibilityWhere } from "../channel-visibility.js";

// ── Seed data ───────────────────────────────────────────────────────────────

const USERS = {
  OWNER: "00000000-0000-0000-0000-000000000001",
  MEMBER: "00000000-0000-0000-0000-000000000002",
  BYSTANDER: "00000000-0000-0000-0000-000000000003",
} as const;

const WORKSPACES = {
  JOINED: "00000000-0000-0000-0000-000000000010",
  POD_VISIBLE: "00000000-0000-0000-0000-000000000011",
} as const;

// Channel IDs named after the channel type + expected owner.
const CHANNEL = {
  /** Owner's personal channel — visible via branch 1. */
  PERSONAL_OWNED: "c0010000-0000-0000-0000-000000000000",
  /** OWNER's EXTERNAL channel, MEMBER added to channel_members — visible via branch 2. */
  EXTERNAL_MEMBER: "c0020000-0000-0000-0000-000000000000",
  /** OWNER's GROUP in JOINED workspace — visible to MEMBER via branch 3 (workspace member). */
  GROUP_WORKSPACE_MEMBER: "c0030000-0000-0000-0000-000000000000",
  /** OWNER's AGENT_COLLAB in POD_VISIBLE workspace — must NOT leak to BYSTANDER. */
  COLLAB_POD_VISIBLE: "c0040000-0000-0000-0000-000000000000",
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────

let dbAvailable = false;

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

/** Query channels visible to `userId` through the predicate directly. */
async function visibleChannelIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(channelVisibilityWhere(userId));
  return new Set(rows.map((r) => r.id));
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("channelVisibilityWhere", () => {
  beforeAll(async () => {
    dbAvailable = await checkDb();
    if (!dbAvailable) return;

    // Clean leftovers from a prior run (ordered for FK safety).
    await db.delete(channelMembers).execute();
    await db.delete(channels).execute();
    await db.delete(workspaceMembers).execute();
    await db.delete(workspaces).execute();
    await db.delete(users).execute();

    // Seed users.
    for (const [key, id] of Object.entries(USERS)) {
      await db
        .insert(users)
        .values({
          id,
          email: `${key.toLowerCase()}@test.synap`,
          userType: "human",
        })
        .onConflictDoNothing();
    }

    // Seed workspaces.
    await db.insert(workspaces).values([
      { id: WORKSPACES.JOINED, name: "Joined WS", ownerId: USERS.OWNER },
      {
        id: WORKSPACES.POD_VISIBLE,
        name: "Pod-Visible WS",
        ownerId: USERS.OWNER,
        settings: { workspaceVisibility: "pod_visible" },
      },
    ]);

    // Seed workspace memberships.
    await db.insert(workspaceMembers).values([
      {
        id: randomUUID(),
        workspaceId: WORKSPACES.JOINED,
        userId: USERS.OWNER,
        role: "owner",
      },
      {
        id: randomUUID(),
        workspaceId: WORKSPACES.JOINED,
        userId: USERS.MEMBER,
        role: "editor",
      },
    ]);

    // ── Seed channels ────────────────────────────────────────────────────────

    // Branch 1: Owner's personal channel.
    await db.insert(channels).values({
      id: CHANNEL.PERSONAL_OWNED,
      userId: USERS.OWNER,
      channelType: ChannelType.PERSONAL,
      status: ChannelStatus.ACTIVE,
    });

    // Branch 2: EXTERNAL channel where MEMBER is an explicit channel_member
    // but NOT the channel owner.
    await db.insert(channels).values({
      id: CHANNEL.EXTERNAL_MEMBER,
      userId: USERS.OWNER,
      workspaceId: WORKSPACES.JOINED,
      channelType: ChannelType.EXTERNAL,
      status: ChannelStatus.ACTIVE,
    });
    await db.insert(channelMembers).values({
      id: randomUUID(),
      channelId: CHANNEL.EXTERNAL_MEMBER,
      memberId: USERS.MEMBER,
      memberKind: ChannelMemberKind.HUMAN,
      role: ChannelMemberRole.MEMBER,
      addedBy: USERS.OWNER,
    });

    // Branch 3a: GROUP channel in JOINED workspace — visible to MEMBER
    // (workspace member) even though MEMBER is not the owner and not
    // an explicit channel_member.
    await db.insert(channels).values({
      id: CHANNEL.GROUP_WORKSPACE_MEMBER,
      userId: USERS.OWNER,
      workspaceId: WORKSPACES.JOINED,
      channelType: ChannelType.GROUP,
      status: ChannelStatus.ACTIVE,
    });

    // Branch 3b: AGENT_COLLAB channel in POD_VISIBLE workspace.
    // OWNER is a member of the workspace, BYSTANDER is NOT.
    // The old userVisibleWhere predicate leaked this to BYSTANDER
    // because pod_visible workspaces were in the union.
    await db.insert(channels).values({
      id: CHANNEL.COLLAB_POD_VISIBLE,
      userId: USERS.OWNER,
      workspaceId: WORKSPACES.POD_VISIBLE,
      channelType: ChannelType.AGENT_COLLAB,
      status: ChannelStatus.ACTIVE,
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(channelMembers).execute();
    await db.delete(channels).execute();
    await db.delete(workspaceMembers).execute();
    await db.delete(workspaces).execute();
    await db.delete(users).execute();
  });

  // ── Tests ──────────────────────────────────────────────────────────────────

  it("owner sees channel they created", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.OWNER);
    expect(ids.has(CHANNEL.PERSONAL_OWNED)).toBe(true);
  });

  it("non-owner does not see channel owned by another user", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.MEMBER);
    expect(ids.has(CHANNEL.PERSONAL_OWNED)).toBe(false);
  });

  it("explicit channel member sees channel they were added to", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.MEMBER);
    expect(ids.has(CHANNEL.EXTERNAL_MEMBER)).toBe(true);
  });

  it("workspace member sees shared channel in their workspace", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.MEMBER);
    expect(ids.has(CHANNEL.GROUP_WORKSPACE_MEMBER)).toBe(true);
  });

  it("bystander does not see channel in pod-visible workspace they do not belong to", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.BYSTANDER);
    expect(ids.has(CHANNEL.COLLAB_POD_VISIBLE)).toBe(false);
  });

  it("stranger sees zero channels", async () => {
    if (!dbAvailable) return;
    const ids = await visibleChannelIds(USERS.BYSTANDER);
    expect(ids.size).toBe(0);
  });
});
