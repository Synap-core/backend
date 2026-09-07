/**
 * `buildProposalChanges` — flatten a proposal's request payload into the
 * before/after `ProposalReviewChange[]` diff the review card renders.
 * Extracted verbatim from proposals.ts (Wave 5 router-decomposition).
 */

import type { ProposalReviewChange } from "@synap-core/types";
import {
  labelFromPath,
  valueTypeOf,
  type ProposalPreviousData,
} from "./display.js";

/**
 * Envelope/infra keys that must never surface as a user-facing change row in the
 * generic (non-entity) fallback in `buildProposalChanges`. Mirrors the frontend
 * INFRA_KEYS set (useProposalPresentation.ts) so the two derivations agree. The
 * entity path never consults this — it only walks the explicit
 * title/description/profileSlug/documentId + `properties.*` keys.
 */
// Cross-repo duplicate: intentionally kept in sync with `INFRA_KEYS` in
// synap-app/packages/core/proposal-types/src/useProposalPresentation.ts. No
// shared package exists across the backend/frontend repo boundary for this
// constant — MUST stay byte-identical when either side changes.
const NON_ENTITY_INFRA_KEYS = new Set([
  "source",
  "sourceId",
  "_summary",
  "summary",
  "changeType",
  "operations",
  "correlationId",
  "requestId",
  "requestedEventId",
  "validatedEventId",
  "completedEventId",
  "workspaceId",
  "targetType",
  "targetId",
  "data",
  "global",
  "reasoning",
  "id",
  "documentId",
  "content",
  "title",
  "description",
  "profileSlug",
]);

export function buildProposalChanges(
  data: Record<string, unknown>,
  changeType: string,
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  },
  /**
   * Durable before-snapshot persisted at proposal-creation time (entity updates).
   * Preferred over `current` so the diff survives approval/materialization and
   * concurrent edits. Absent on legacy proposals → `current` is used.
   */
  previousData?: ProposalPreviousData
): ProposalReviewChange[] {
  const changes: ProposalReviewChange[] = [];
  const operation =
    changeType === "delete"
      ? "delete"
      : changeType === "create"
        ? "create"
        : "update";

  // Before-state lookup so update diffs show before→after (not just after).
  // Source of truth: the persisted `previousData` snapshot when present (durable),
  // otherwise the live `current` entity columns (legacy fallback).
  const snapshotProps =
    previousData?.properties && typeof previousData.properties === "object"
      ? previousData.properties
      : undefined;
  const currentProps =
    current?.properties && typeof current.properties === "object"
      ? (current.properties as Record<string, unknown>)
      : {};
  const beforeFor = (key: string): unknown => {
    if (operation !== "update") return undefined;
    if (previousData) {
      // The snapshot stores keys as title/description/profileSlug/documentId.
      const snapValue = previousData[key as keyof typeof previousData];
      if (snapValue !== undefined) return snapValue ?? undefined;
    }
    if (!current) return undefined;
    if (key === "title") return current.title ?? undefined;
    if (key === "description") return current.preview ?? undefined;
    if (key === "profileSlug") return current.type ?? undefined;
    return undefined;
  };

  for (const key of ["title", "description", "profileSlug", "documentId"]) {
    if (data[key] !== undefined) {
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: beforeFor(key),
        after: data[key],
        valueType: valueTypeOf(data[key]),
      });
    }
  }

  const beforePropFor = (key: string): unknown => {
    if (operation !== "update") return undefined;
    if (snapshotProps && key in snapshotProps) return snapshotProps[key];
    return currentProps[key];
  };

  const properties =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(properties)) {
    changes.push({
      path: `properties.${key}`,
      label: labelFromPath(key),
      operation,
      before: beforePropFor(key),
      after: value,
      valueType: valueTypeOf(value),
    });
  }

  // The ONE nested key this builder promotes (see the block after the fallback).
  // Resolved BEFORE the fallback because the fallback needs to know whether the
  // promotion will fire — not to reorder the pushes, which must stay as they are.
  const allowedHosts = (
    data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : {}
  )["allowedHosts"];
  const promotesAllowedHosts = Array.isArray(allowedHosts);

  // Generic fallback: a non-entity proposal (e.g. a flat `property_def` payload of
  // { slug, valueType, constraints, overlay, required, … }) matches none of the
  // entity-shape keys above, so `changes` is still empty and the review card would
  // render blank. Emit one change per non-infra top-level key (no "properties."
  // prefix) so the payload renders. Entity/document/composite/session payloads
  // always populate `changes` above, so this never fires for them — the entity
  // path is preserved byte-for-byte.
  if (changes.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (NON_ENTITY_INFRA_KEYS.has(key)) continue;
      if (value === undefined) continue;
      // `metadata` is NOT in NON_ENTITY_INFRA_KEYS and must not be added to it:
      // that Set is a byte-identical cross-repo duplicate of synap-app's
      // `INFRA_KEYS`, and a one-sided edit forks it. Suppress the bag HERE, and
      // only when the promoted `metadata.allowedHosts` row below will actually
      // render it — otherwise a metadata-only payload with no hosts would lose
      // its last visible key and the card would go blank, which is worse than
      // opaque. When the promotion fires, this blob is a strict duplicate of it
      // plus noise (marketSource baselines, run counters) — the exact thing the
      // promotion exists to displace.
      if (key === "metadata" && promotesAllowedHosts) continue;
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: undefined,
        after: value,
        valueType: valueTypeOf(value),
      });
    }
  }

  // ── Egress: the ONE nested key promoted to its own change row ──────────────
  //
  // A `skill.update` proposal that widens `metadata.allowedHosts` is the single
  // most consequential skill edit a reviewer can approve — it is what decides
  // which hosts the (default-deny) sandbox will let that skill reach. It reached
  // the card as NOTHING: the top-level loop only walks
  // title/description/profileSlug/documentId, and the generic fallback fires
  // only when `changes` is still empty AND would emit the whole opaque
  // `metadata` bag (marketSource baselines, run counters) as one blob.
  //
  // Pushed AFTER the fallback on purpose: pushing it before would make
  // `changes.length === 0` false and suppress the fallback entirely, silently
  // erasing every other key of a metadata-carrying payload from the card.
  //
  // So promote exactly this key, and nothing else in the bag. `before` is
  // deliberately left undefined — this builder has no skill row to read the
  // prior list from, and the card renders an unknown previous value honestly
  // rather than implying the list was empty.
  if (promotesAllowedHosts) {
    changes.push({
      path: "metadata.allowedHosts",
      // Say what the row IS, not just what it holds. Rendered with the generic
      // "~" badge among description edits, "External hosts" reads as one more
      // field; naming the sandbox allowlist is what tells the reviewer they are
      // approving an EGRESS widen. This is a builder literal describing a FIELD
      // (not an object kind / action / status), so `@synap-core/types/vocabulary`
      // does not apply — there is no domain token here to resolve.
      label: "External hosts (sandbox allowlist)",
      operation,
      before: undefined,
      after: allowedHosts,
      valueType: valueTypeOf(allowedHosts),
    });
  }

  return changes;
}
