/**
 * recordToolDemand — the ONE door that records "someone wants a tool Synap
 * cannot connect yet".
 *
 * Demand is a `tool_request` ENTITY (system profile, pod-wide), one per
 * normalized tool name per user. Three producers write it: onboarding's tools
 * step (`onboarding.recordTools`), a `market.search` miss (the `tool.request`
 * builtin verb), and a blocked agent. None of them writes `tool_request` any
 * other way.
 *
 * IDENTITY FIRST: the natural key is `tr_normalized_key`. An existing record is
 * resolved before any write; a repeat of the same source is a no-op, a new
 * source is merged into `tr_sources` through the governed update door. A tool
 * name carries no strong identity signal (email/phone/url), so this key match
 * is the dedup — never a title match.
 *
 * GOVERNANCE: every write goes through `entities.create` / `entities.update`
 * (checkPermissionOrPropose). A human caller executes; a caller carrying
 * `agentUserId` proposes. Nothing here decides execute-vs-propose.
 *
 * FORWARDING (decision D2): an applied write enqueues the pod's
 * `tool-demand-forward` job, which sends the normalized key (no user id, no
 * content) to the Control Plane. The daily cron is the backstop, so a failed
 * enqueue is logged, not fatal.
 */

import {
  and,
  db,
  entities,
  eq,
  isNull,
  drizzleSql,
  profileSlugScopeCondition,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  normalizeToolName,
  TOOL_DEMAND_FORWARD_QUEUE,
} from "@synap-core/types/tools";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

const logger = createLogger({ module: "tool-demand" });

/** Where a demand came from. Stored on `tr_sources`. */
export const TOOL_DEMAND_SOURCES = [
  "onboarding",
  // The tools list outside onboarding (e.g. Settings → Add a connection).
  "settings",
  "market_search_miss",
  "blocked_agent",
] as const;
export type ToolDemandSource = (typeof TOOL_DEMAND_SOURCES)[number];

/** Mirrors `tr_status` in ensure-system-profiles. */
export type ToolRequestStatus = "wanted" | "installable" | "connected";

interface GovernedWriteResult {
  status?: string;
  id?: string | null;
  proposalId?: string | null;
  reviewUrl?: string | null;
  message?: string;
}

/**
 * The governed entities caller (`entitiesRouter.createCaller(ctx)`). Structural,
 * so the tRPC router and the builtin verb can both pass theirs.
 */
export interface ToolDemandCaller {
  create(input: {
    profileSlug: string;
    title: string;
    properties: Record<string, unknown>;
    agentUserId?: string;
    reasoning?: string;
  }): Promise<unknown>;
  update(input: {
    id: string;
    properties: Record<string, unknown>;
    agentUserId?: string;
    reasoning?: string;
  }): Promise<unknown>;
}

export interface RecordToolDemandResult {
  /**
   * created / updated — applied now; proposed — queued for review;
   * already-recorded — the record already carries this source (no write);
   * invalid-name — nothing usable after normalization (no write);
   * refused — the governed door returned neither applied nor proposed.
   */
  status:
    | "created"
    | "updated"
    | "proposed"
    | "already-recorded"
    | "invalid-name"
    | "refused";
  normalizedKey: string | null;
  entityId: string | null;
  proposalId?: string;
  reviewUrl?: string;
  message?: string;
}

async function findExistingToolRequest(userId: string, key: string) {
  // The kind-aware scope door, identity-wide (tool_request is pod-scope).
  const kindScope = await profileSlugScopeCondition(
    db,
    "tool_request",
    await resolveFacetVisibilityScope(userId, undefined)
  );
  const [row] = await db
    .select({ id: entities.id, properties: entities.properties })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        kindScope,
        isNull(entities.deletedAt),
        drizzleSql`${entities.properties}->>'tr_normalized_key' = ${key}`
      )
    )
    .limit(1);
  return row ?? null;
}

async function enqueueForward(): Promise<void> {
  try {
    const { getBoss } = await import("@synap/jobs");
    await getBoss().send(
      TOOL_DEMAND_FORWARD_QUEUE,
      {},
      { singletonKey: TOOL_DEMAND_FORWARD_QUEUE, singletonSeconds: 60 }
    );
  } catch (err) {
    logger.warn(
      { err },
      "tool-demand-forward enqueue failed — the daily cron will forward it"
    );
  }
}

function asResult(raw: unknown): GovernedWriteResult {
  return (raw ?? {}) as GovernedWriteResult;
}

export async function recordToolDemand(params: {
  caller: ToolDemandCaller;
  userId: string;
  toolName: string;
  source: ToolDemandSource;
  /** The authoring agent — makes the governed door propose. */
  agentUserId?: string;
}): Promise<RecordToolDemandResult> {
  const { caller, userId, source } = params;
  const key = normalizeToolName(params.toolName);
  if (!key) {
    return {
      status: "invalid-name",
      normalizedKey: null,
      entityId: null,
      message: `"${params.toolName}" has no letters or digits to name a tool by`,
    };
  }
  const agent = params.agentUserId ? { agentUserId: params.agentUserId } : {};

  const existing = await findExistingToolRequest(userId, key);
  if (existing) {
    const props = (existing.properties ?? {}) as Record<string, unknown>;
    const sources = Array.isArray(props.tr_sources)
      ? (props.tr_sources as unknown[]).filter(
          (s): s is string => typeof s === "string"
        )
      : [];
    if (sources.includes(source)) {
      return {
        status: "already-recorded",
        normalizedKey: key,
        entityId: existing.id,
      };
    }
    const updated = asResult(
      await caller.update({
        id: existing.id,
        properties: {
          tr_sources: Array.from(new Set([...sources, source])),
        },
        ...agent,
        reasoning: `Tool demand for "${key}" also came from ${source}`,
      })
    );
    if (updated.status === "proposed") {
      return {
        status: "proposed",
        normalizedKey: key,
        entityId: existing.id,
        ...(updated.proposalId ? { proposalId: updated.proposalId } : {}),
        ...(updated.reviewUrl ? { reviewUrl: updated.reviewUrl } : {}),
      };
    }
    await enqueueForward();
    return { status: "updated", normalizedKey: key, entityId: existing.id };
  }

  const created = asResult(
    await caller.create({
      profileSlug: "tool_request",
      title: params.toolName.trim().slice(0, 200),
      // The normalized key, the status and where it came from — nothing typed
      // by a caller beyond the tool name (the title stays on the pod).
      properties: {
        tr_normalized_key: key,
        tr_status: "wanted" satisfies ToolRequestStatus,
        tr_sources: [source],
      },
      ...agent,
      reasoning: `A tool Synap cannot connect yet was requested (${source})`,
    })
  );

  if (created.status === "created" && created.id) {
    await enqueueForward();
    return { status: "created", normalizedKey: key, entityId: created.id };
  }
  if (created.status === "proposed") {
    return {
      status: "proposed",
      normalizedKey: key,
      entityId: null,
      ...(created.proposalId ? { proposalId: created.proposalId } : {}),
      ...(created.reviewUrl ? { reviewUrl: created.reviewUrl } : {}),
    };
  }
  return {
    status: "refused",
    normalizedKey: key,
    entityId: null,
    message: created.message ?? `Governed create returned ${created.status}`,
  };
}
