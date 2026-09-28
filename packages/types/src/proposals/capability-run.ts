/**
 * CAPABILITY-RUN TITLES — what a proposal to run a core ENTITY verb is called.
 *
 * A proposal to run `entity.delete` used to be titled "Run entity.delete": the
 * reviewer saw a tool id and nothing about WHICH object it would delete — the
 * target lived only in `parameters.entityId` (observed 2026-09-28, nine GRP
 * question retirements that all read the same). A run of a core entity verb is
 * not "running a tool" from the reviewer's point of view; it IS the action on
 * the object, so it is titled like one: `Delete Question "GRP #3: Numbers"`.
 *
 * ONE rule, three readers: the pod's write-time summary
 * (`describeCapabilityRun`), the pod's read-time re-derivation for rows filed
 * before this existed (`enrichProposalsForDisplay`), and the review card's
 * title (`useProposalPresentation`, browser + relay). Every word goes through
 * the vocabulary door (`buildObjectActionTitle`) — no label table here.
 *
 * PURE and dependency-free at runtime, published as its own LEAF subpath
 * (`@synap-core/types/proposals/capability-run`) for the same reason as
 * `./intent` and `./attention`: the `./proposals` barrel is not Hermes-safe.
 */

import {
  buildObjectActionTitle,
  resolveActionLabel,
  resolveObjectNoun,
} from "../vocabulary/index.js";

/**
 * Verbs of the shape `entity.<action>` that act on ONE existing entity named by
 * `parameters.entityId`. `create` (no entity yet) and `query` (a read, never
 * proposed as an action on an object) are not.
 */
const ENTITY_VERB = /^entity\.([a-z][a-z_]*)$/;
const NOT_AN_OBJECT_ACTION = new Set(["create", "query"]);
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntityVerbRunTarget {
  /** The action token (`delete`, `update`, …) — resolved by the vocabulary. */
  action: string;
  /** The entity the run acts on (`parameters.entityId`). */
  entityId: string;
}

/**
 * The (action, entity) a capability run acts on, or `null` when this run is
 * not a core entity verb on one existing entity.
 */
export function entityVerbRunTarget(
  verbId: string | null | undefined,
  parameters: Record<string, unknown> | null | undefined
): EntityVerbRunTarget | null {
  if (typeof verbId !== "string") return null;
  const m = ENTITY_VERB.exec(verbId);
  if (!m || NOT_AN_OBJECT_ACTION.has(m[1]!)) return null;
  const entityId = parameters?.entityId;
  if (typeof entityId !== "string" || !UUID_SHAPE.test(entityId)) return null;
  return { action: m[1]!, entityId };
}

/** What the reviewer is allowed to know about the target — both optional. */
export interface EntityVerbRunSubject {
  /** The entity's kind (profile slug), e.g. `question`. */
  kind?: string | null;
  /** The entity's display name, ALREADY floored to what the reader may see. */
  name?: string | null;
}

/**
 * `Delete Question "GRP #3: Numbers"`; `Delete Question` when the name is not
 * visible; `Delete entity` when nothing about the target is. Never the raw id.
 */
export function describeEntityVerbRun(
  action: string,
  subject?: EntityVerbRunSubject | null
): string {
  const kind = subject?.kind?.trim() || null;
  const name = subject?.name?.trim() || null;
  if (!kind && !name) {
    return `${resolveActionLabel(action, "imperative")} ${resolveObjectNoun(
      "entity"
    ).toLowerCase()}`;
  }
  return buildObjectActionTitle({
    action,
    objectKind: kind ?? "entity",
    objectName: name,
  });
}

/**
 * True when a stored summary is exactly the generated tool-id shape
 * (`Run <verbId>`) the pod wrote before this rule existed. Only THAT string is
 * ever re-derived — a summary a person or agent wrote is never rewritten.
 */
export function isGeneratedCapabilityRunSummary(
  summary: string | null | undefined,
  verbId: string | null | undefined
): boolean {
  return typeof verbId === "string" && summary === `Run ${verbId}`;
}

/**
 * The run's reason, when the caller put it where a run has room for one: the
 * run door takes no top-level `reasoning`, so agents pass it inside
 * `parameters`. Hoisted so the reviewer reads WHY without opening the payload.
 */
export function capabilityRunReasoning(
  parameters: Record<string, unknown> | null | undefined
): string | undefined {
  const r = parameters?.reasoning;
  return typeof r === "string" && r.trim() ? r.trim() : undefined;
}
