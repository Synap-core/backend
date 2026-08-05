/**
 * Channel origin — "which producer brought this channel into existence".
 *
 * Stored as ONE graph edge, no new table and no new column:
 *
 *   producer --produced--> channel        (`links`, linkType "produced")
 *
 * The producer is polymorphic and reuses the existing `LinkEndpointType`
 * vocabulary. Written ONLY at channel BIRTH (the resolve-or-create paths), so a
 * channel that already existed keeps whatever origin it was born with — an
 * origin is a fact about creation, not about the latest writer.
 *
 * PRODUCER-ID CONVENTION (read this before adding a call site):
 *   • `tool`       — a real `tools` row id (Mailgun connector tool, Fireflies tool).
 *   • `capability` — the verb/skill id that ran (`skills.id`); the edge is written
 *                    with the honest `skill` endpoint type and surfaced to callers
 *                    under the coarser "capability" producer kind, because the
 *                    channel-stack contract has no separate `skill` kind.
 *   • `agent`      — an `agents` registry row id.
 *   • `source`     — a bridge with NO registry row (Discord gateway, Unipile).
 *                    The id is then the PROVIDER SLUG ("discord", "linkedin"),
 *                    not a `sources` uuid. This is deliberate: inventing a fake
 *                    uuid would be worse than an honest slug, and nothing
 *                    resolves a channel-origin producer id against `sources`.
 *
 * The coarse `channels.metadata.origin` string label is UNCHANGED and still
 * written by the paths that already wrote it — this edge is the structured
 * companion, not a replacement.
 *
 * ONE DOOR: the edge is written through `createLinks` (services/links/links-service),
 * never `db.insert(links)`.
 */

import type { LinkInput, LinkEndpointType } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { createLinks } from "../links/links-service.js";

const logger = createLogger({ module: "channel-origin" });

/** The producer kinds a channel origin can name (the channel-stack contract). */
export type ChannelProducerType = "capability" | "tool" | "source" | "agent";

export interface ChannelOrigin {
  producerType: ChannelProducerType;
  /** Polymorphic producer id — see the PRODUCER-ID CONVENTION above. */
  producerId: string;
  /** Human label cached on the edge so a read needs no second lookup. */
  producerName?: string;
}

/**
 * Map the contract's producer kind onto the `links` endpoint vocabulary.
 * "capability" is carried by the `skill` endpoint: today's capability producers
 * are builtin/declarative VERBS (`skills` rows), and pointing a `capability`
 * endpoint at a skill id would produce an edge that resolves to nothing in the
 * `capabilities` container table.
 */
export function producerEndpointType(
  producerType: ChannelProducerType
): LinkEndpointType {
  return producerType === "capability" ? "skill" : producerType;
}

/** Inverse of `producerEndpointType` — used when READING the origin edge back. */
export function producerTypeFromEndpoint(
  endpointType: string
): ChannelProducerType | null {
  switch (endpointType) {
    case "skill":
    case "capability":
      return "capability";
    case "tool":
      return "tool";
    case "source":
      return "source";
    case "agent":
      return "agent";
    default:
      return null;
  }
}

/**
 * The `producer --produced--> channel` edge for an origin. Pure — the DB write
 * is `recordChannelOrigin`, this is the shape (unit-testable without a DB).
 */
export function channelOriginLinkInputs(args: {
  channelId: string;
  workspaceId: string | null;
  origin: ChannelOrigin;
}): LinkInput[] {
  const { channelId, workspaceId, origin } = args;
  if (!origin.producerId) return [];
  return [
    {
      workspaceId,
      fromType: producerEndpointType(origin.producerType),
      fromId: origin.producerId,
      toType: "channel",
      toId: channelId,
      linkType: "produced",
      metadata: {
        // The declared producer kind, kept verbatim so a read never has to
        // guess whether a `skill` endpoint meant "capability".
        producerKind: origin.producerType,
        ...(origin.producerName ? { producerName: origin.producerName } : {}),
      },
    },
  ];
}

/**
 * Record a channel's origin edge. Idempotent (the unique edge index makes a
 * repeat insert a no-op) and NON-FATAL: an origin is observability metadata, so
 * a failure must never break the inbound sensor path that just landed a message.
 */
export async function recordChannelOrigin(args: {
  channelId: string;
  workspaceId: string | null;
  origin: ChannelOrigin | undefined;
}): Promise<void> {
  if (!args.origin) return;
  const inputs = channelOriginLinkInputs({
    channelId: args.channelId,
    workspaceId: args.workspaceId,
    origin: args.origin,
  });
  if (inputs.length === 0) return;
  try {
    await createLinks(inputs);
  } catch (err) {
    logger.warn(
      { err, channelId: args.channelId, origin: args.origin },
      "channel-origin: produced-edge write failed (non-fatal)"
    );
  }
}
