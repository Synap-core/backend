/**
 * resolve-client-binding — the ONE home for the delivery firewall's
 * "client-comms channel → sibling team channel" resolution.
 *
 * FIREWALL: a Discord channel whose `branchPurpose === 'client-comms'` mirrors to
 * a real client's conversation. Bot/AI output must NEVER land there — it is
 * redirected to the sibling `branchPurpose === 'team'` channel (same bound
 * `contextObjectId`, else same `parentChannelId`), or suppressed entirely when no
 * team sibling exists. This helper only RESOLVES that binding; the caller
 * (discord.ts agent-turn) decides redirect-vs-suppress. Extracted verbatim from
 * the inline block so the firewall logic has exactly one home — its behavior must
 * stay byte-identical (do NOT weaken which channels are blocked or redirected).
 *
 * `isClientComms` is returned so the caller can reproduce the original three-way
 * decision (not-client-comms → act nowhere; client-comms + team → redirect;
 * client-comms + no team → suppress) — a bare team lookup cannot distinguish a
 * non-client-comms channel from a client-comms one that has no team sibling.
 */

import { db, and, eq } from "@synap/database";
import { channels } from "@synap/database/schema";

export interface ClientBinding {
  /** True iff the source channel's branchPurpose is 'client-comms'. */
  isClientComms: boolean;
  /** The bound client entity id (contextObjectId), when client-comms + entity-bound. */
  clientEntityId: string | null;
  /** Internal id of the sibling team channel, when one exists. */
  teamChannelId: string | null;
  /** External id (Discord channel id) of the sibling team channel — the redirect target. */
  teamExternalId: string | null;
}

/**
 * Resolve a channel's client-comms firewall binding. Given the internal channel
 * id, return whether it is a client-comms channel and, if so, the sibling team
 * channel (same bound entity, else same parent room).
 */
export async function resolveClientBinding(
  channelId: string
): Promise<ClientBinding> {
  const here = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: {
      branchPurpose: true,
      contextObjectId: true,
      parentChannelId: true,
    },
  });

  if (here?.branchPurpose !== "client-comms") {
    return {
      isClientComms: false,
      clientEntityId: null,
      teamChannelId: null,
      teamExternalId: null,
    };
  }

  // Sibling team channel = same bound entity, else same parent room.
  let team: { id: string; externalId: string | null } | undefined;
  if (here.contextObjectId) {
    team = await db.query.channels.findFirst({
      where: and(
        eq(channels.branchPurpose, "team"),
        eq(channels.externalSource, "discord"),
        eq(channels.contextObjectId, here.contextObjectId)
      ),
      columns: { id: true, externalId: true },
    });
  } else if (here.parentChannelId) {
    team = await db.query.channels.findFirst({
      where: and(
        eq(channels.branchPurpose, "team"),
        eq(channels.externalSource, "discord"),
        eq(channels.parentChannelId, here.parentChannelId)
      ),
      columns: { id: true, externalId: true },
    });
  }

  return {
    isClientComms: true,
    clientEntityId: here.contextObjectId ?? null,
    teamChannelId: team?.id ?? null,
    teamExternalId: team?.externalId ?? null,
  };
}
