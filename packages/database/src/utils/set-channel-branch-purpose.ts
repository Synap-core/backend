/**
 * setChannelBranchPurpose — THE ONE DOOR for MUTATING an existing channel's
 * firewall role (`channels.branchPurpose`).
 *
 * FIREWALL (non-negotiable): the `client-comms` role is IMMUTABLE once set.
 * Reclassifying a client-comms channel to `team` (or null) would route bot/AI
 * output straight into a real client's conversation. This helper is the single
 * app-layer chokepoint enforcing that; a `BEFORE UPDATE` trigger on the column
 * is the DB-layer floor (migration 0169) that holds even if this is bypassed.
 *
 * A CI tripwire (`__tripwires__/branch-purpose-one-door.test.ts`) bans
 * `.set({ branchPurpose })` anywhere except this file — so the invariant can
 * never silently re-scatter across call sites again.
 *
 * INSERTs are NOT routed here: a fresh row can only go NULL→role and can never
 * reclassify an existing client, so `.values({ branchPurpose })` stays inline.
 *
 * Legal transitions: null→client-comms, team→client-comms, client-comms→
 * client-comms (no-op), and every non-client-comms transition. Only
 * client-comms → anything-else is refused.
 */

import { db } from "../client-pg.js";
import { channels } from "../schema/channels.js";
import { eq } from "drizzle-orm";

export class ChannelFirewallImmutableError extends Error {
  readonly channelId: string;
  constructor(channelId: string) {
    super(
      "Cannot reclassify a client-comms channel — the firewall label is immutable."
    );
    this.name = "ChannelFirewallImmutableError";
    this.channelId = channelId;
  }
}

export async function setChannelBranchPurpose(args: {
  channelId: string;
  branchPurpose: string | null;
}): Promise<void> {
  const current = await db.query.channels.findFirst({
    where: eq(channels.id, args.channelId),
    columns: { branchPurpose: true },
  });
  if (
    current?.branchPurpose === "client-comms" &&
    args.branchPurpose !== "client-comms"
  ) {
    throw new ChannelFirewallImmutableError(args.channelId);
  }
  try {
    await db
      .update(channels)
      .set({ branchPurpose: args.branchPurpose, updatedAt: new Date() })
      .where(eq(channels.id, args.channelId));
  } catch (err) {
    // The DB trigger (0169) is the floor beneath the check above. If a
    // concurrent write flipped the row to client-comms between our read and
    // this UPDATE (TOCTOU), the trigger raises SQLSTATE 23514 — translate it to
    // the same typed error so every caller's existing catch maps it to 403.
    if ((err as { code?: string })?.code === "23514") {
      throw new ChannelFirewallImmutableError(args.channelId);
    }
    throw err;
  }
}
