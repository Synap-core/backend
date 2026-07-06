/**
 * ensureExternalChannel — jobs-reachable find-or-create of the canonical EXTERNAL
 * channel for (provider, externalId). Mirrors the race-safe upsert in the api-side
 * `resolveOrCreateExternalChannel` (services/connectors/inbound-recorder.ts) but
 * lives in `@synap/database` so jobs-side producers (mail-feed / event workers)
 * can create the Synap channel they post into. Both paths target the SAME partial
 * unique index on (externalSource, externalId), so they converge on one row.
 *
 * Unlike the inbound path this does NOT cache per-message metadata — it is for
 * feed/system channels created by a worker, where an optional `branchPurpose`
 * (e.g. 'team') documents the firewall role.
 */

import { getDb } from "../client-pg.js";
import { channels, ChannelType, ChannelScope } from "../schema/channels.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { setChannelBranchPurpose } from "./set-channel-branch-purpose.js";

export interface EnsureExternalChannelArgs {
  provider: string;
  externalId: string;
  userId: string;
  workspaceId?: string | null;
  title?: string;
  /** Firewall role for the channel ('team' | 'client-comms' | null). */
  branchPurpose?: string | null;
}

export async function ensureExternalChannel(
  args: EnsureExternalChannelArgs
): Promise<{ channelId: string; created: boolean }> {
  const database = await getDb();

  const findExisting = async () =>
    database.query.channels.findFirst({
      where: and(
        eq(channels.channelType, ChannelType.EXTERNAL),
        eq(channels.externalSource, args.provider),
        eq(channels.externalId, args.externalId)
      ),
      columns: { id: true, branchPurpose: true },
    });

  const existing = await findExisting();
  if (existing) {
    // Firewall alignment: if the caller designates a purpose (e.g. 'team' for a
    // feed channel) and the existing row has NONE, UPGRADE it — the mirror's
    // fail-closed allowlist only mirrors bot/AI to 'team', so a null-purpose row
    // would silently drop feed posts. NEVER override an existing non-null purpose
    // (that would let a 'client-comms' channel be reclassified as team).
    if (args.branchPurpose && existing.branchPurpose == null) {
      // Upgrade a NULL role only, via the one door (which also enforces
      // client-comms immutability — a no-op here since we gate on `== null`).
      await setChannelBranchPurpose({
        channelId: existing.id,
        branchPurpose: args.branchPurpose,
      });
    }
    return { channelId: existing.id, created: false };
  }

  // Upsert against the PARTIAL unique index (externalSource, externalId) WHERE
  // externalId IS NOT NULL — the loser of a race no-ops, then we re-SELECT.
  const [inserted] = await database
    .insert(channels)
    .values({
      userId: args.userId,
      workspaceId: args.workspaceId ?? null,
      channelType: ChannelType.EXTERNAL,
      scope: args.workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
      title: args.title ?? `${args.provider} feed`,
      externalSource: args.provider,
      externalChannelId: args.externalId,
      externalId: args.externalId,
      branchPurpose: args.branchPurpose ?? null,
    })
    .onConflictDoNothing({
      target: [channels.externalSource, channels.externalId],
      where: isNotNull(channels.externalId),
    })
    .returning({ id: channels.id });

  if (inserted) return { channelId: inserted.id, created: true };

  const survivor = await findExisting();
  if (!survivor) {
    throw new Error(
      `Failed to resolve-or-create EXTERNAL channel for ${args.provider}:${args.externalId} after conflict`
    );
  }
  return { channelId: survivor.id, created: false };
}
