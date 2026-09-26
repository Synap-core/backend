/**
 * `buildProposalChanges` — flatten a proposal's request payload into the
 * before/after `ProposalReviewChange[]` diff the review card renders.
 * Extracted verbatim from proposals.ts (Wave 5 router-decomposition).
 */

import type {
  ProposalFieldDrift,
  ProposalReviewChange,
} from "@synap-core/types";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { stableStringify } from "../../utils/stable-stringify.js";
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
    documentId?: string | null;
    properties?: unknown;
  },
  /**
   * Durable before-snapshot persisted at proposal-creation time (entity updates).
   * Preferred over `current` so the diff survives approval/materialization and
   * concurrent edits. Absent on legacy proposals → `current` is used.
   */
  previousData?: ProposalPreviousData,
  options: {
    /**
     * Stamp `drift` on each update row (snapshot vs live). Only meaningful
     * BEFORE the proposal applies: once applied, the live row holds the
     * proposed value and every field would read as "changed since".
     */
    measureDrift?: boolean;
  } = {}
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
      // A recorded `null` passes through: it is "was empty", like a property's.
      const snapValue = previousData[key as keyof typeof previousData];
      if (snapValue !== undefined) return snapValue;
    }
    if (!current) return undefined;
    if (key === "title") return current.title ?? undefined;
    if (key === "description") return current.preview ?? undefined;
    if (key === "profileSlug") return current.type ?? undefined;
    return undefined;
  };

  // ── DRIFT: has the field moved since the snapshot was taken? ─────────────
  // Two sides, each either READ or ABSENT. A side is read when its record is
  // in hand: the snapshot recorded this field (a stored `null` IS a reading —
  // "was empty"), or the live row was readable and carries this column. Only
  // two readings are compared; one missing side is `unknown`, never a guess.
  const measureDrift = options.measureDrift === true && operation === "update";
  const LIVE_COLUMN: Record<string, keyof NonNullable<typeof current>> = {
    title: "title",
    description: "preview",
    profileSlug: "type",
    documentId: "documentId",
  };
  const driftOf = (
    snapshot: { read: boolean; value?: unknown },
    live: { read: boolean; value?: unknown }
  ): ProposalFieldDrift => {
    if (!snapshot.read || !live.read) return "unknown";
    return sameFieldValue(snapshot.value, live.value)
      ? "unchanged"
      : "changed_since";
  };
  const topLevelDrift = (key: string): ProposalFieldDrift => {
    const snapValue = previousData?.[key as keyof ProposalPreviousData];
    const column = LIVE_COLUMN[key];
    return driftOf(
      { read: snapValue !== undefined, value: snapValue },
      {
        read: !!current && !!column && column in current,
        value: current && column ? current[column] : undefined,
      }
    );
  };
  const liveProps =
    current?.properties && typeof current.properties === "object"
      ? (current.properties as Record<string, unknown>)
      : undefined;
  const propertyDrift = (key: string): ProposalFieldDrift =>
    driftOf(
      {
        read: !!snapshotProps && Object.hasOwn(snapshotProps, key),
        value: snapshotProps?.[key],
      },
      // The live row was read: a key it lacks is a READING ("empty now").
      { read: !!liveProps, value: liveProps?.[key] }
    );

  for (const key of ["title", "description", "profileSlug", "documentId"]) {
    if (data[key] !== undefined) {
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: beforeFor(key),
        after: data[key],
        valueType: valueTypeOf(data[key]),
        ...(measureDrift ? { drift: topLevelDrift(key) } : {}),
      });
    }
  }

  // A proposal WITH a property snapshot never reads the live row for a before:
  // a recorded key (a stored `null` = "was empty") is the snapshot's; a key the
  // snapshot did not record (a legacy capture that dropped absent keys, or a key
  // a revision added) is UNKNOWN — substituting today's value would show a
  // stale "before" with no mark. Only a proposal with NO snapshot (legacy)
  // falls back to the live value, as before.
  const beforePropFor = (key: string): unknown => {
    if (operation !== "update") return undefined;
    if (snapshotProps) {
      return Object.hasOwn(snapshotProps, key) ? snapshotProps[key] : undefined;
    }
    // A live empty is not a RECORDED empty: `null` on the wire means only the
    // latter (see `ProposalReviewChange.before`), so the live read never emits it.
    return currentProps[key] ?? undefined;
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
      ...(measureDrift ? { drift: propertyDrift(key) } : {}),
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

  // The playbook STRUCTURE keys, promoted for the same reason (see the block
  // after the allowedHosts promotion): resolved here so the fallback can skip
  // the raw copies it would otherwise also emit.
  const promotedStages = readPromotedStages(data.stages);
  const promotesScope = typeof data.scope === "string" && data.scope !== "";

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
      // Promoted below as readable rows; the raw copy would be a duplicate.
      if (key === "stages" && promotedStages) continue;
      if (key === "scope" && promotesScope) continue;
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

  // ── Playbook structure: `scope` and `stages` promoted to their own rows ────
  //
  // A playbook create/update proposal carries `description` — an entity-shape
  // key — so the loop above emits ONE row and the generic fallback never fires:
  // the reviewer approving a METHOD saw its description and nothing else, not
  // whether it is a session template or a project method (`scope`), nor the
  // stages a project will walk. Pushed AFTER the fallback for the reason the
  // allowedHosts row is: pushing earlier would suppress the fallback.
  //
  // Real content only, never a hand-written label map: the scope VALUE goes
  // through `humanizeToken` (the vocabulary door for any token); a stage row's
  // label is the stage's OWN name (content the author wrote), and its value is
  // the stage's own goal.
  if (promotesScope) {
    changes.push({
      path: "scope",
      label: labelFromPath("scope"),
      operation,
      before: undefined,
      after: humanizeToken(data.scope as string),
      valueType: "string",
    });
  }
  if (promotedStages) {
    promotedStages.forEach((stage, i) => {
      const goal = stage.goal ?? stage.description ?? null;
      changes.push({
        path: `stages.${stage.key ?? i}`,
        label:
          stage.name ??
          (stage.key
            ? humanizeToken(stage.key)
            : `${labelFromPath("stage")} ${i + 1}`),
        operation,
        before: undefined,
        after: goal,
        valueType: valueTypeOf(goal),
      });
    });
  }

  return changes;
}

/**
 * Field equality for drift: `undefined` and `null` are both "empty" (the
 * snapshot stores `null`, a live JSONB bag simply lacks the key); everything
 * else compares structurally, key order ignored.
 */
function sameFieldValue(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/** The fields of a stage the review card shows — everything else stays in `data`. */
interface PromotedStage {
  key?: string;
  name?: string;
  goal?: string;
  description?: string;
}

/**
 * A payload's `stages`, when it is a list of stage OBJECTS (a playbook's or a
 * session's phases). Anything else — absent, not an array, an array of scalars —
 * is left to the generic fallback untouched. Narrows, never trusts: `data` is
 * the stored request payload.
 */
function readPromotedStages(value: unknown): PromotedStage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((s) => s && typeof s === "object" && !Array.isArray(s))) {
    return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v : undefined;
  return value.map((raw) => {
    const s = raw as Record<string, unknown>;
    return {
      key: str(s.key),
      name: str(s.name),
      goal: str(s.goal),
      description: str(s.description),
    };
  });
}
