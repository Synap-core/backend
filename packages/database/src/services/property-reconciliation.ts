/**
 * Property reconciliation — the pure classify + apply-decision core.
 *
 * THE GAP THIS CLOSES. An AI proposes entity properties with free-form labels
 * (`Geo`, `Score`, `Funding`, `Segment`, `Vertical`) that don't match the target
 * kind's property-def slugs. On approve those keys are stored VERBATIM in the
 * `properties` JSONB (see property-validation-service.ts — unknown keys are kept,
 * tagged `unmodeled`, never dropped) but become un-queryable and invisible to
 * every property-def-driven view.
 *
 * On APPROVE, each proposed key is reconciled against the target kind's effective
 * property-def slugs, with per-field user control:
 *   - matched (key === a def slug)                        → store as today.
 *   - remap  (no exact def, high-confidence fuzzy match)  → store under the def slug.
 *   - new    (no def, no confident suggestion)            → accept as a first-class
 *                                                            field (a def is created
 *                                                            by the API caller).
 *
 * This module is PURE (no db, no side effects): it classifies keys and computes
 * what to write + which defs to create. The API layer owns the actual def-creation
 * door and the best-effort fallback (store verbatim, never lose data) — see
 * services/proposals/reconcile-proposal-properties.ts.
 *
 * Fuzzy matching is NOT re-implemented here: it reuses `closestWithDistance`
 * (did-you-mean.ts), the same case/separator-folded Levenshtein the write-path
 * `unmodeled` receipt already uses.
 */

import { closestWithDistance } from "./did-you-mean.js";

/** A property-def value type, as the create door accepts it. */
export type PropertyDefValueType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "date"
  | "secret"
  | "entity_id";

/**
 * A per-field reviewer decision, keyed by the PROPOSED property key.
 *   - keep   → take this key as its own field. If it matches an existing def slug
 *              it is stored there (matched); otherwise it becomes a NEW field and
 *              a def is created for it. This is the DEFAULT for genuinely-new keys.
 *   - remap  → store the value under `toSlug` (an existing def slug, or a novel
 *              slug the reviewer chose — a def is created if it does not exist).
 *   - refuse → drop the key entirely (do NOT store). Lets a reviewer reject ONE
 *              new field without rejecting the whole proposal.
 */
export type PropertyDecision =
  | { action: "keep" }
  | { action: "remap"; toSlug: string }
  | { action: "refuse" };

/** Keyed by the proposed property key. */
export type PropertyDecisionMap = Record<string, PropertyDecision>;

/**
 * The DEFAULT auto-remap confidence threshold. When NO explicit decision is
 * given, a proposed key is auto-remapped onto the closest existing slug only if
 * the case/separator-folded edit distance is ≤ this value. Distance 0 is a pure
 * label-vs-slug/casing match (`Geo`→`geo`, `dueDate`→`due-date`) — unambiguous.
 * Distance 1 is a single-character typo (`fundin`→`funding`). Anything looser is
 * left as a NEW field by default (the suggestion is still surfaced so the reviewer
 * can opt into it), because silently rewriting a 2+ edit difference risks
 * collapsing two genuinely-distinct fields.
 */
export const AUTO_REMAP_MAX_FOLDED_DISTANCE = 1;

export type PropertyClass = "matched" | "remap" | "new";

export interface ReconciledKey {
  /** The original proposed property key. */
  key: string;
  /** How the key was classified after decisions + defaults were applied. */
  class: PropertyClass;
  /** The value being reconciled (carried so the API layer can re-map on def-create failure). */
  value: unknown;
  /**
   * The slug the value is stored under, or `null` when the key was refused
   * (dropped). For `new` this is the slugified key; for `remap` the target slug;
   * for `matched` the original key.
   */
  finalSlug: string | null;
  /** Whether the API layer should create a property def for `finalSlug`. */
  createDef: boolean;
  /** The closest existing slug, when one was within suggestion budget. */
  suggestion?: string;
  /** Whether the outcome came from an explicit reviewer decision or the default. */
  source: "explicit" | "default";
}

export interface ReconcilePropertiesResult {
  /**
   * The OPTIMISTIC final property bag — every kept key stored under its
   * `finalSlug`, refused keys dropped. "Optimistic" because it assumes every
   * `createDef` succeeds; the API layer overrides a new-key back to its ORIGINAL
   * verbatim key when its def-creation fails (never lose the value).
   */
  properties: Record<string, unknown>;
  /** Per-key classification + storage detail (for def creation + telemetry). */
  reconciled: ReconciledKey[];
  /** New defs to create (deduped by slug), in first-seen order. */
  defsToCreate: Array<{
    slug: string;
    label: string;
    valueType: PropertyDefValueType;
  }>;
}

/**
 * Normalize a free-form label to a property-def slug (`/^[a-z0-9-]+$/`, the slug
 * regex property-defs.create enforces). `Geo`→`geo`, `Funding Amount`→`funding-amount`,
 * `Score!!`→`score`. Returns `""` when nothing slug-able remains (caller keeps
 * the value under its original key in that case).
 */
export function slugifyPropertyKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Infer a def value type from a JS value (defaults to string). */
export function inferValueType(value: unknown): PropertyDefValueType {
  if (value instanceof Date) return "date";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "string";
}

/**
 * Classify every proposed property key and compute the reconciled bag + the defs
 * to create. Pure — no db, no side effects.
 *
 * @param properties  The proposed property bag (verbatim from the proposal).
 * @param slugs       The target kind's effective property-def slugs (this
 *                    workspace's lens), from `getEffectiveProperties`.
 * @param decisions   Optional per-field reviewer decisions (keyed by proposed key).
 * @param reservedKeys Keys that live on the entity ROW, not the property bag
 *                    (e.g. `title`) — passed through untouched, never a def.
 */
export function reconcileProposedProperties(args: {
  properties: Record<string, unknown>;
  slugs: readonly string[];
  decisions?: PropertyDecisionMap;
  reservedKeys?: ReadonlySet<string>;
}): ReconcilePropertiesResult {
  const { properties, slugs, decisions, reservedKeys } = args;
  const slugSet = new Set(slugs);
  const reconciled: ReconciledKey[] = [];
  const outProps: Record<string, unknown> = {};
  const defsBySlug = new Map<
    string,
    { slug: string; label: string; valueType: PropertyDefValueType }
  >();

  for (const [key, value] of Object.entries(properties)) {
    // Reserved entity-column keys (title) pass through untouched.
    if (reservedKeys?.has(key)) {
      outProps[key] = value;
      reconciled.push({
        key,
        class: "matched",
        value,
        finalSlug: key,
        createDef: false,
        source: "default",
      });
      continue;
    }

    const exactMatch = slugSet.has(key);
    const match = closestWithDistance(key, slugs);
    const decision = decisions?.[key];

    // ── Explicit reviewer decision ──────────────────────────────────────────
    if (decision) {
      if (decision.action === "refuse") {
        reconciled.push({
          key,
          class: "new",
          value,
          finalSlug: null,
          createDef: false,
          source: "explicit",
          ...(match ? { suggestion: match.candidate } : {}),
        });
        continue;
      }
      if (decision.action === "remap") {
        const toSlug = decision.toSlug;
        outProps[toSlug] = value;
        const createDef = !slugSet.has(toSlug);
        if (createDef && toSlug) {
          if (!defsBySlug.has(toSlug))
            defsBySlug.set(toSlug, {
              slug: toSlug,
              label: key,
              valueType: inferValueType(value),
            });
        }
        reconciled.push({
          key,
          class: "remap",
          value,
          finalSlug: toSlug,
          createDef,
          source: "explicit",
          ...(match ? { suggestion: match.candidate } : {}),
        });
        continue;
      }
      // decision.action === "keep": take this key as its own field. Matched keys
      // stay matched; anything else becomes a NEW first-class field (slugified),
      // IGNORING any fuzzy suggestion — the reviewer explicitly declined a remap.
      const keepSlug = exactMatch ? key : slugifyPropertyKey(key) || key;
      const keepIsModeled = slugSet.has(keepSlug);
      const keepCreateDef = !keepIsModeled && /^[a-z0-9-]+$/.test(keepSlug);
      outProps[keepSlug] = value;
      if (keepCreateDef && !defsBySlug.has(keepSlug))
        defsBySlug.set(keepSlug, {
          slug: keepSlug,
          label: key,
          valueType: inferValueType(value),
        });
      reconciled.push({
        key,
        class: keepIsModeled ? "matched" : "new",
        value,
        finalSlug: keepSlug,
        createDef: keepCreateDef,
        source: "explicit",
        ...(match ? { suggestion: match.candidate } : {}),
      });
      continue;
    }

    // ── No explicit decision — apply defaults ───────────────────────────────
    if (exactMatch) {
      outProps[key] = value;
      reconciled.push({
        key,
        class: "matched",
        value,
        finalSlug: key,
        createDef: false,
        source: "default",
      });
      continue;
    }

    // High-confidence fuzzy match → auto-remap onto the existing slug.
    if (match && match.distance <= AUTO_REMAP_MAX_FOLDED_DISTANCE) {
      outProps[match.candidate] = value;
      reconciled.push({
        key,
        class: "remap",
        value,
        finalSlug: match.candidate,
        createDef: false,
        source: "default",
        suggestion: match.candidate,
      });
      continue;
    }

    // Genuinely new → accept as a first-class field (default = keep + create def).
    const newSlug = slugifyPropertyKey(key);
    if (newSlug && /^[a-z0-9-]+$/.test(newSlug) && !slugSet.has(newSlug)) {
      outProps[newSlug] = value;
      if (!defsBySlug.has(newSlug))
        defsBySlug.set(newSlug, {
          slug: newSlug,
          label: key,
          valueType: inferValueType(value),
        });
      reconciled.push({
        key,
        class: "new",
        value,
        finalSlug: newSlug,
        createDef: true,
        source: "default",
        ...(match ? { suggestion: match.candidate } : {}),
      });
      continue;
    }

    // Slugify collapsed onto an existing slug, or produced nothing slug-able:
    // store verbatim under the ORIGINAL key (today's behavior — no rename, no
    // duplicate def).
    outProps[key] = value;
    reconciled.push({
      key,
      class: newSlug && slugSet.has(newSlug) ? "matched" : "new",
      value,
      finalSlug: key,
      createDef: false,
      source: "default",
      ...(match ? { suggestion: match.candidate } : {}),
    });
  }

  return {
    properties: outProps,
    reconciled,
    defsToCreate: [...defsBySlug.values()],
  };
}
