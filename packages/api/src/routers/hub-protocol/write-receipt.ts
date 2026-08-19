/**
 * Hub Protocol — entity write receipt (TRANSPORT-AGNOSTIC)
 *
 * The truthful receipt (`pending | applied | partial` + per-facet outcomes +
 * warnings) and the exact-name `resolution` block used to live inside the REST
 * route (`rest/entities.ts`). That meant only HTTP callers ever saw them: MCP
 * calls the tRPC `entities.createEntity` procedure directly, so no MCP agent
 * has ever received a receipt.
 *
 * This module is the shared construction site. It takes plain values only — no
 * Hono `Context`, no headers, no status codes — so ANY transport (REST, MCP,
 * CLI, IS) can produce the IDENTICAL receipt from the same tRPC create result.
 *
 * Nothing here throws: `buildCreateResolution` is advisory and swallows every
 * failure, because the entity write has already happened by the time it runs.
 */

import type { UnmodeledProperty } from "@synap/database";
import type { ProposalEffect } from "../proposals/execution-registry.js";
import { resolveEntityByName } from "../../services/entity-resolution.js";
import { relationsRouter } from "../relations.js";
import { createHubProtocolCallerContext } from "./utils.js";
// Reuse the hub-protocol logger so the existing warn lines are byte-identical.
import { logger } from "./rest/_shared.js";

/** A single resolution suggestion / auto-connected facet (ids + names). */
export interface ResolutionSuggestion {
  id: string;
  name: string;
  profileSlug: string;
}

/** The `resolution` block attached to a create response (additive). */
export interface CreateResolutionBlock {
  /** SAME profile + SAME name → the agent should consider updating this instead. */
  existingSameProfile?: ResolutionSuggestion;
  /** DIFFERENT-profile facets we auto-connected the new entity to. */
  autoConnected: Array<ResolutionSuggestion & { relation: string }>;
  /** Everything worth a second look: the auto-connected facets (shallow). */
  suggestions: ResolutionSuggestion[];
}

/** Per-facet outcome carried on the receipt (created / reused / dropped / error). */
export interface CreateWriteReceiptFacet {
  slug: string;
  outcome: string;
  facetId?: string;
  proposalId?: string;
  error?: string;
}

/**
 * The receipt shape. Mirrors design doc §2.3 as far as the CURRENT data allows:
 * - `state`          → §2.3 `status`
 * - `facets[]`       → §2.3 per-item outcomes
 * - `warnings[]`     → §2.3 `warnings`
 * - `proposalId` / `reviewUrl` → §2.3 `review`
 * - `properties.unmodeled` → §2.3 property feedback. Keys the write invented:
 *   stored verbatim (flexible-schema back-compat) but NOT modelled, hence not
 *   queryable — each with an optional `didYouMean`. Omitted entirely when the
 *   write invented nothing, so the ordinary receipt is unchanged.
 *
 * NOT modelled (no data source behind them yet — deliberately NOT invented):
 * - `next[]` affordances — nothing produces them.
 *
 * THE FOUR STATES — mutually exclusive, and the distinction is the whole point:
 * - `pending`   → NOTHING is in storage yet and nothing will be until a human
 *                 acts. A proposal exists (`proposalId`/`reviewUrl`), or the
 *                 write was handed off to the materializer worker
 *                 (`ProposalEffect.applied === "deferred"` — the handoff is
 *                 receipted, the write is not).
 * - `applied`   → storage changed, and the STORAGE ENGINE said so (a
 *                 `RETURNING` row / an affected-row count > 0). Every declared
 *                 sub-write landed.
 * - `partial`   → storage changed for SOME sub-writes and failed for others.
 *                 The primary write landed and a non-atomic follow-up errored
 *                 (today: a facet with `outcome: "error"`). Never a claim of
 *                 rollback.
 * - `no_effect` → the operation COMPLETED SUCCESSFULLY and deliberately changed
 *                 nothing. Not a failure, not a partial, and NOT `applied`:
 *                 zero rows were written and that is the correct outcome —
 *                 an acknowledged no-op door (`ACKNOWLEDGED_NOOP_KEYS` in
 *                 `proposals/executors/catch-all.ts`: `proactive/recap`,
 *                 `bento/arrange`, `context/link`, `whiteboard/place`), a
 *                 governance advisory that only records acknowledgement, or an
 *                 idempotent re-apply whose statement reported 0 rows. It ALWAYS
 *                 has a reason behind it (`ProposalEffect.applied === "none"`
 *                 carries `reason`) — an unexplained no-op is the defect itself.
 */
export interface CreateWriteReceipt {
  state: "pending" | "applied" | "partial" | "no_effect";
  proposalId?: string;
  reviewUrl?: string;
  entityId?: string;
  proposedEntityId?: string;
  profileSlug?: string;
  effectiveWorkspaceId?: string | null;
  projectId?: string;
  source?: string;
  facets?: CreateWriteReceiptFacet[];
  warnings?: string[];
  /** Present ONLY when the write carried keys the profile does not model. */
  properties?: { unmodeled: UnmodeledProperty[] };
}

/**
 * THE ONE MAPPING from a storage-engine effect receipt (`ProposalEffect`, the
 * approval/executor vocabulary) onto the transport receipt `state` (the
 * REST/MCP/CLI vocabulary). Both halves of the same contract — this function is
 * the only place they are related, so a new `applied` value cannot silently
 * become an over-claiming `state`.
 *
 *   verified + rows > 0 → "applied"    storage changed, engine confirmed it
 *   verified + rows = 0 → "no_effect"  the statement ran and matched nothing
 *                                      (idempotent re-apply / onConflictDoNothing)
 *   deferred            → "pending"    the WRITE has not happened; only a
 *                                      handoff (`.validated` event) is receipted
 *   none                → "no_effect"  deliberately wrote nothing, with a reason
 */
export function receiptStateForEffect(
  effect: ProposalEffect
): CreateWriteReceipt["state"] {
  switch (effect.applied) {
    case "verified":
      return effect.rows > 0 ? "applied" : "no_effect";
    case "deferred":
      return "pending";
    case "none":
      return "no_effect";
  }
}

/**
 * Normalize the tRPC create result into a truthful transport receipt without
 * changing the legacy status/id envelope. The create router can materialize
 * the primary entity before a non-atomic facet follow-up fails, so callers
 * need `partial` rather than a misleading all-or-nothing success claim.
 */
export function buildCreateWriteReceipt(input: {
  result: Record<string, unknown>;
  profileSlug: string;
  effectiveWorkspaceId: string | null;
  projectId?: string;
  source?: string;
  /**
   * STORAGE-ENGINE EVIDENCE, when the caller has it (every approve branch in
   * `proposals/apply-approval.ts` now produces one). Present ⇒ it DECIDES the
   * state via `receiptStateForEffect`, because a `RETURNING`/affected-row count
   * outranks anything inferred from the optimistic result envelope. Absent ⇒
   * the legacy status/facet derivation below, unchanged.
   */
  effect?: ProposalEffect;
}): CreateWriteReceipt {
  const rawFacets = Array.isArray(input.result.facets)
    ? input.result.facets
    : [];
  const facets = rawFacets.flatMap((facet) => {
    if (!facet || typeof facet !== "object") return [];
    const row = facet as Record<string, unknown>;
    if (typeof row.slug !== "string") return [];
    return [
      {
        slug: row.slug,
        outcome:
          typeof row.outcome === "string"
            ? row.outcome
            : typeof row.status === "string"
              ? row.status
              : "unknown",
        ...(typeof row.facetId === "string" ? { facetId: row.facetId } : {}),
        ...(typeof row.proposalId === "string"
          ? { proposalId: row.proposalId }
          : {}),
        ...(typeof row.error === "string" ? { error: row.error } : {}),
      },
    ];
  });
  // Unknown-property feedback forwarded by `entities.createEntity`. Parsed
  // defensively (the result is an untyped record) and kept OUT of `warnings`,
  // which stays facet-only: an unmodeled key is advisory, not a failed step.
  const rawUnmodeled = Array.isArray(input.result.unmodeled)
    ? input.result.unmodeled
    : [];
  const unmodeled = rawUnmodeled.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== "string") return [];
    return [
      {
        key: row.key,
        ...(typeof row.didYouMean === "string"
          ? { didYouMean: row.didYouMean }
          : {}),
      },
    ];
  });

  const status = input.result.status;
  const pending = status === "proposed";
  const partial = !pending && facets.some((facet) => facet.outcome === "error");
  const warnings = facets
    .filter((facet) => facet.outcome === "dropped" || facet.outcome === "error")
    .map((facet) =>
      facet.error
        ? `Facet ${facet.slug}: ${facet.error}`
        : `Facet ${facet.slug} was ${facet.outcome}`
    );

  // Engine evidence wins; a facet error still degrades a would-be `applied`
  // to `partial` (a verified primary write + a failed follow-up is exactly
  // what `partial` means), but it can never upgrade a `no_effect`/`pending`.
  const derived: CreateWriteReceipt["state"] = pending
    ? "pending"
    : partial
      ? "partial"
      : "applied";
  const state: CreateWriteReceipt["state"] = input.effect
    ? receiptStateForEffect(input.effect) === "applied" && partial
      ? "partial"
      : receiptStateForEffect(input.effect)
    : derived;
  return {
    state,
    ...(typeof input.result.proposalId === "string"
      ? { proposalId: input.result.proposalId }
      : {}),
    ...(typeof input.result.reviewUrl === "string"
      ? { reviewUrl: input.result.reviewUrl }
      : {}),
    ...(typeof input.result.id === "string"
      ? { entityId: input.result.id }
      : {}),
    ...(typeof input.result.proposedEntityId === "string"
      ? { proposedEntityId: input.result.proposedEntityId }
      : {}),
    profileSlug: input.profileSlug,
    effectiveWorkspaceId: input.effectiveWorkspaceId,
    ...(input.projectId && !pending ? { projectId: input.projectId } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(facets.length ? { facets } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(unmodeled.length ? { properties: { unmodeled } } : {}),
  };
}

/**
 * Run exact-name resolution around a just-created entity and (a) auto-connect
 * cross-profile facets via a `same_subject` relation (governed by the SAME
 * proposal/auto path as any relation write) and (b) return an advisory block.
 *
 * ADVISORY ONLY — every failure path returns `undefined`, never throws, so the
 * underlying entity write is never blocked by resolution.
 */
export async function buildCreateResolution(params: {
  scopes: string[];
  title: string;
  profileSlug: string;
  userId: string;
  createdId?: string;
  effectiveWorkspaceId: string | null;
  /** Acting agent — bound onto the relation caller ctx so the auto-connect is
   *  attributed to (and governable as) the agent, not the operator. */
  resolvedAgentUserId?: string;
}): Promise<CreateResolutionBlock | undefined> {
  try {
    const { sameProfile, otherProfiles } = await resolveEntityByName({
      name: params.title,
      targetProfileSlug: params.profileSlug,
      userId: params.userId,
      excludeId: params.createdId,
    });

    if (!sameProfile && otherProfiles.length === 0) return undefined;

    const autoConnected: CreateResolutionBlock["autoConnected"] = [];

    // Auto-connect ONLY same-name + different-profile facets, and only when we
    // have a concrete created entity id to connect FROM (proposed entities have
    // no id yet — skip; the suggestion is still surfaced so the agent sees it).
    if (params.createdId && otherProfiles.length > 0) {
      // Agent attribution travels on the CALLER CONTEXT, not in the input:
      // `relations.create` takes no `agentUserId`/`reasoning` field, and
      // `ctx.agentUserId` is the canonical seam ("the agent acting on behalf of
      // this request" — see createHubProtocolCallerContext). Without it the
      // auto-connect would be written as the plain operator, so an MCP agent
      // create would silently author an edge under the USER's identity.
      const relCtx = await createHubProtocolCallerContext(
        params.userId,
        params.scopes,
        params.effectiveWorkspaceId ?? undefined,
        null, // sourceMessageId — not carried by the resolution path
        null, // sessionId — not carried by the resolution path
        params.resolvedAgentUserId ?? null
      );
      const relCaller = relationsRouter.createCaller(
        relCtx as Parameters<typeof relationsRouter.createCaller>[0]
      );
      for (const facet of otherProfiles) {
        try {
          await relCaller.create({
            sourceEntityId: params.createdId,
            targetEntityId: facet.id,
            type: "same_subject",
            ...(params.effectiveWorkspaceId
              ? { workspaceId: params.effectiveWorkspaceId }
              : {}),
          });
          autoConnected.push({
            id: facet.id,
            name: facet.name,
            profileSlug: facet.profileSlug,
            relation: "same_subject",
          });
        } catch (relErr) {
          // A single auto-connect failure (e.g. cross-workspace facet, missing
          // workspace) must not sink the whole resolution block.
          logger.warn(
            { relErr, facetId: facet.id, createdId: params.createdId },
            "auto-connect same_subject failed"
          );
        }
      }
    }

    // suggestions = the cross-profile facets worth a second look (shallow: the
    // same set we auto-connected, surfaced explicitly for the agent).
    const suggestions: ResolutionSuggestion[] = otherProfiles.map((e) => ({
      id: e.id,
      name: e.name,
      profileSlug: e.profileSlug,
    }));

    return {
      ...(sameProfile
        ? {
            existingSameProfile: {
              id: sameProfile.id,
              name: sameProfile.name,
              profileSlug: sameProfile.profileSlug,
            },
          }
        : {}),
      autoConnected,
      suggestions,
    };
  } catch (err) {
    logger.warn({ err }, "buildCreateResolution failed (resolution omitted)");
    return undefined;
  }
}

/**
 * THE CONSUMER CONTRACT — one call, both blocks, identical for every transport.
 *
 * Call this immediately after `entities.createEntity` returns, then merge the
 * result into whatever envelope the transport uses:
 *
 *   const { writeReceipt, resolution } = await buildCreateEntityReceipt({...});
 *   return { ...result, effectiveWorkspaceId, writeReceipt,
 *            ...(resolution ? { resolution } : {}) };
 *
 * Order matters only in that resolution runs FIRST (it performs the governed
 * `same_subject` auto-connect side effect); the receipt itself is pure.
 */
export async function buildCreateEntityReceipt(params: {
  /** The raw `entities.createEntity` tRPC result. */
  result: Record<string, unknown>;
  profileSlug: string;
  /** The workspace the write actually landed in (null = pod-wide). */
  effectiveWorkspaceId: string | null;
  /** Caller identity used for the advisory resolution reads/writes. */
  userId: string;
  scopes: string[];
  /** The title that was written — resolution matches on exact name. */
  title: string;
  projectId?: string;
  source?: string;
  resolvedAgentUserId?: string;
  /** Storage-engine evidence, when the caller has it. See `buildCreateWriteReceipt`. */
  effect?: ProposalEffect;
}): Promise<{
  writeReceipt: CreateWriteReceipt;
  resolution?: CreateResolutionBlock;
}> {
  const resolution = await buildCreateResolution({
    scopes: params.scopes,
    title: params.title,
    profileSlug: params.profileSlug,
    userId: params.userId,
    ...(typeof params.result.id === "string"
      ? { createdId: params.result.id }
      : {}),
    effectiveWorkspaceId: params.effectiveWorkspaceId,
    ...(params.resolvedAgentUserId
      ? { resolvedAgentUserId: params.resolvedAgentUserId }
      : {}),
  });

  const writeReceipt = buildCreateWriteReceipt({
    result: params.result,
    profileSlug: params.profileSlug,
    effectiveWorkspaceId: params.effectiveWorkspaceId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.effect ? { effect: params.effect } : {}),
  });

  return { writeReceipt, ...(resolution ? { resolution } : {}) };
}
