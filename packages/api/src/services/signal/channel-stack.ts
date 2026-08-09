/**
 * Channel Stack — "what is wired to THIS channel".
 *
 * The read behind the channel object's Stack facet. It answers, for one
 * channel: where did it come from (origin), what does it look like on the
 * outside (provider identity + a native deep link), which capabilities target
 * it, and which automations can actually fire for it.
 *
 * NO NEW STORE. Every fact is read from something the pod already writes:
 *   origin        ← `links` edge `producer --produced--> channel` (+ the coarse
 *                   `channels.metadata.origin` label)
 *   capabilities  ← `links` edge `capability --targets--> channel`
 *   automations   ← a matcher-faithful scan of `automations.triggerConfig`
 *   external      ← `channels.externalSource` / `externalChannelId` /
 *                   `metadata.external.*`
 *
 * DUAL FLOOR — deliberately two different predicates, matching the rest of the
 * signal service: channel FACTS are floored by `channelVisibilityWhere` (the
 * canonical channel read predicate), while automations / capabilities / links
 * are floored by `userVisibleWhere` (the canonical config-object predicate).
 * A channel the caller cannot see is a NOT_FOUND, never a partially-filled row.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  or,
  eq,
  inArray,
  isNull,
  isNotNull,
  channels,
  automations,
  capabilities,
  type AutomationTriggerConfig,
} from "@synap/database";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { getLinksFor } from "../links/links-service.js";
import {
  buildChannelDeepLink,
  readChannelExternalMetadata,
  type ChannelDeepLinkKind,
} from "../channels/channel-deep-link.js";
import {
  producerTypeFromEndpoint,
  type ChannelProducerType,
} from "../channels/channel-origin.js";
import {
  classifyChannelAutomationBinding,
  type ChannelAutomationBinding,
} from "./channel-automation-binding.js";

/** How many automations the binding scan will consider. */
const AUTOMATION_SCAN_CAP = 500;
/** How many capability edges are surfaced. */
const CAPABILITY_CAP = 50;

export interface ChannelStackOrigin {
  producerType: ChannelProducerType | null;
  producerId: string | null;
  producerName: string | null;
  /** The coarse `channels.metadata.origin` category, when the channel has one. */
  label: string | null;
}

export interface ChannelStackExternal {
  source: string | null;
  externalChannelId: string | null;
  /** CHANNEL-level native url, or null when the ids can't produce an honest one. */
  deepLink: string | null;
  deepLinkKind: ChannelDeepLinkKind | null;
}

export interface ChannelStackAutomation {
  id: string;
  name: string | null;
  /** True only for `status === "active"` — a paused binding is still reported. */
  enabled: boolean;
  binding: ChannelAutomationBinding;
  /** e.g. "external_message.received" — the trigger in one line. */
  triggerSummary: string | null;
}

export interface ChannelStackResult {
  channelId: string;
  origin: ChannelStackOrigin | null;
  external: ChannelStackExternal;
  capabilities: Array<{ id: string; name: string | null }>;
  automations: ChannelStackAutomation[];
}

/** The coarse origin LABEL some channel writers stamp at `metadata.origin`. */
function readOriginLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const label = (metadata as Record<string, unknown>).origin;
  return typeof label === "string" && label.trim() ? label : null;
}

/** One-line trigger description for the UI. */
export function summarizeAutomationTrigger(
  triggerType: string | null,
  triggerConfig: AutomationTriggerConfig | null | undefined
): string | null {
  const pattern = triggerConfig?.eventPattern;
  if (pattern) return pattern.replace(/\.\*$/, "").replace(/\.completed$/, "");
  return triggerType ?? null;
}

export async function getChannelStack(input: {
  userId: string;
  channelId: string;
}): Promise<ChannelStackResult> {
  const { userId, channelId } = input;

  // ── 1. Channel facts, floored by the canonical channel predicate ───────────
  const [channel] = await db
    .select({
      id: channels.id,
      workspaceId: channels.workspaceId,
      externalSource: channels.externalSource,
      externalChannelId: channels.externalChannelId,
      contextObjectId: channels.contextObjectId,
      metadata: channels.metadata,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), channelVisibilityWhere(userId)))
    .limit(1);

  if (!channel) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Channel not found or access denied",
    });
  }

  // ── 2. Graph edges touching the channel (ONE query, userVisibleWhere-floored
  //      inside `getLinksFor`) — the origin `produced` edge comes from here; the
  //      capability is then derived from the producer's `member_of` (below).
  const edges = await getLinksFor(userId, "channel", channelId);

  const producedEdge = edges.find(
    (e) =>
      e.linkType === "produced" &&
      e.toType === "channel" &&
      e.toId === channelId
  );
  const originLabel = readOriginLabel(channel.metadata);
  const edgeMeta = (producedEdge?.metadata ?? {}) as Record<string, unknown>;
  const producerType = producedEdge
    ? // The declared kind is cached on the edge (a `skill` endpoint carries the
      // "capability" kind); fall back to deriving it from the endpoint type.
      ((typeof edgeMeta.producerKind === "string"
        ? producerTypeFromEndpoint(edgeMeta.producerKind)
        : null) ?? producerTypeFromEndpoint(producedEdge.fromType))
    : null;

  const origin: ChannelStackOrigin | null =
    producedEdge || originLabel
      ? {
          producerType,
          producerId: producedEdge?.fromId ?? null,
          producerName:
            typeof edgeMeta.producerName === "string"
              ? edgeMeta.producerName
              : null,
          label: originLabel,
        }
      : null;

  // Capabilities the channel belongs to, DERIVED from its origin producer:
  //   channel <--produced-- tool --member_of--> capability
  // The `capability --targets--> channel` edge this once read has NO writer
  // anywhere in the codebase, so it always resolved to nothing. A channel's
  // capability is its PRODUCER's container: follow the produced edge to the tool
  // (or skill/command) that made the channel, then that part's `member_of`
  // capability container. Legacy channels whose origin is still a bare `source`
  // slug (no installed tool) have no producer node and surface no capability —
  // exactly right, since none is installed.
  const producerEndpoint = producedEdge?.fromType ?? null;
  const producerId = producedEdge?.fromId ?? null;
  const capabilityIds =
    producerId &&
    (producerEndpoint === "tool" ||
      producerEndpoint === "skill" ||
      producerEndpoint === "command")
      ? [
          ...new Set(
            (await getLinksFor(userId, producerEndpoint, producerId))
              .filter(
                (e) =>
                  e.linkType === "member_of" &&
                  e.fromType === producerEndpoint &&
                  e.fromId === producerId &&
                  e.toType === "capability"
              )
              .map((e) => e.toId)
          ),
        ].slice(0, CAPABILITY_CAP)
      : [];

  const capabilityRows =
    capabilityIds.length === 0
      ? []
      : await db
          .select({ id: capabilities.id, name: capabilities.name })
          .from(capabilities)
          .where(
            and(
              inArray(capabilities.id, capabilityIds),
              userVisibleWhere(capabilities.workspaceId, userId)
            )
          );
  const capabilityNameById = new Map(capabilityRows.map((c) => [c.id, c.name]));

  // ── 3. External identity + the channel-level deep link ─────────────────────
  const externalMeta = readChannelExternalMetadata(channel.metadata);
  const link = buildChannelDeepLink({
    source: channel.externalSource,
    externalChannelId: channel.externalChannelId,
    guildId:
      typeof externalMeta.guildId === "string" ? externalMeta.guildId : null,
    teamId:
      typeof externalMeta.teamId === "string" ? externalMeta.teamId : null,
  });

  // ── 4. Automations. MATCHER-FAITHFUL: the workspace narrow mirrors the
  //      matcher's own scope (a channel pinned to workspace W can only be seen
  //      by W's automations plus pod-wide ones; a POD-WIDE channel fans across
  //      the caller's whole visible floor, exactly as the matcher does), then
  //      the pure predicate replays pattern + filters per automation.
  const automationRows = await db
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      triggerType: automations.triggerType,
      triggerConfig: automations.triggerConfig,
    })
    .from(automations)
    .where(
      and(
        userVisibleWhere(automations.workspaceId, userId),
        // Matcher-faithful scope. The matcher fires (a) workspace automations in
        // the EVENT's workspace — here the channel's workspace, or for a pod-wide
        // channel any workspace the caller can see (userVisibleWhere bounds it) —
        // and (b) pod-wide automations that are OWNER-BOUND (`isNull(workspaceId)
        // AND createdBy = userId`, automation-trigger-matcher.ts's `podWideMatch`).
        // Without the createdBy gate the scan over-reports another user's pod-wide
        // automation as firing here, which the matcher would never do.
        or(
          channel.workspaceId
            ? eq(automations.workspaceId, channel.workspaceId)
            : isNotNull(automations.workspaceId),
          and(
            isNull(automations.workspaceId),
            eq(automations.createdBy, userId)
          )
        ),
        inArray(automations.status, ["active", "paused"]),
        eq(automations.triggerType, "event")
      )
    )
    .limit(AUTOMATION_SCAN_CAP);

  // Capability-embedded automations: `automation --member_of--> capability`
  // where the capability targets this channel. Reported REGARDLESS of trigger
  // pattern — the binding runs through the capability, not the event grammar.
  const capabilityAutomationIds = new Set<string>();
  if (capabilityIds.length > 0) {
    const memberEdges = await Promise.all(
      capabilityIds.map((capId) => getLinksFor(userId, "capability", capId))
    );
    for (const set of memberEdges) {
      for (const e of set) {
        if (
          e.linkType === "member_of" &&
          e.fromType === "automation" &&
          e.toType === "capability"
        ) {
          capabilityAutomationIds.add(e.fromId);
        }
      }
    }
  }

  const channelFacts = {
    channelId,
    boundEntityId: channel.contextObjectId,
    provider: channel.externalSource,
  };

  const out: ChannelStackAutomation[] = [];
  const seen = new Set<string>();
  for (const a of automationRows) {
    const viaCapability = capabilityAutomationIds.has(a.id);
    const binding =
      classifyChannelAutomationBinding(
        a.triggerConfig as AutomationTriggerConfig,
        channelFacts
      ) ?? (viaCapability ? "capability" : null);
    if (!binding) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      name: a.name,
      enabled: a.status === "active",
      // A capability-reached automation is labelled by that stronger, explicit
      // wiring even when its trigger config would also match workspace-wide.
      binding:
        viaCapability && binding === "workspace" ? "capability" : binding,
      triggerSummary: summarizeAutomationTrigger(
        a.triggerType,
        a.triggerConfig
      ),
    });
  }

  // Capability-embedded automations the scan above didn't reach (a different
  // trigger type, or outside the scan cap) — floored the same way.
  const missing = [...capabilityAutomationIds].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({
        id: automations.id,
        name: automations.name,
        status: automations.status,
        triggerType: automations.triggerType,
        triggerConfig: automations.triggerConfig,
      })
      .from(automations)
      .where(
        and(
          inArray(automations.id, missing),
          userVisibleWhere(automations.workspaceId, userId)
        )
      );
    for (const a of extra) {
      out.push({
        id: a.id,
        name: a.name,
        enabled: a.status === "active",
        binding: "capability",
        triggerSummary: summarizeAutomationTrigger(
          a.triggerType,
          a.triggerConfig
        ),
      });
    }
  }

  return {
    channelId,
    origin,
    external: {
      source: channel.externalSource,
      externalChannelId: channel.externalChannelId,
      deepLink: link?.url ?? null,
      deepLinkKind: link?.kind ?? null,
    },
    // Only the capabilities the caller may SEE — an edge can name a capability
    // in a workspace they're not in, and reporting its id would leak existence.
    capabilities: capabilityIds
      .filter((id) => capabilityNameById.has(id))
      .map((id) => ({ id, name: capabilityNameById.get(id) ?? null })),
    automations: out,
  };
}
