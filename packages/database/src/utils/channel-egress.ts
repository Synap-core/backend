/**
 * Channel Egress write helper.
 *
 * Enqueues a channel-AGNOSTIC outbound action onto the `channel_egress` outbox.
 * An external adapter later pulls pending rows and executes them. This helper
 * is a pure data-layer insert:
 *   - NO network I/O.
 *   - Imports NOTHING provider-specific.
 * Keeping the data layer clean is the whole point of the egress migration.
 *
 * Nothing calls this yet — Wave A infra only.
 */

import { getDb } from "../client-pg.js";
import { channelEgress } from "../schema/channel-egress.js";

/**
 * The kinds of outbound action the egress outbox can carry.
 * Provider-agnostic — a target system decides how to execute each.
 */
export type ChannelEgressKind =
  | "post_message"
  | "rename_channel"
  | "pin_message"
  | "scheduled_event";

export interface EnqueueChannelEgressInput {
  /** Which external system the target belongs to (e.g. a chat platform). */
  externalSource: string;
  /** Target id within that system (e.g. a channel id). */
  externalId: string;
  /** The action to perform. */
  kind: ChannelEgressKind;
  /** Kind-specific payload. */
  payload: Record<string, unknown>;
  /** Optional — for audit / scoping only. */
  workspaceId?: string | null;
}

/**
 * Insert a single pending egress row and return its id.
 */
export async function enqueueChannelEgress(
  input: EnqueueChannelEgressInput
): Promise<{ id: string }> {
  const database = await getDb();

  const [row] = await database
    .insert(channelEgress)
    .values({
      externalSource: input.externalSource,
      externalId: input.externalId,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      workspaceId: input.workspaceId ?? null,
    })
    .returning({ id: channelEgress.id });

  return { id: row.id };
}
