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

  return changes;
}
