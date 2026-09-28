/**
 * Space brief convergence — the THREE-WAY stamp (founder decision 2026-09-28).
 *
 * A template seeds a space's brief (`settings.onboarding`); the user may edit
 * it afterwards. On every reconcile, each TEMPLATE-SEEDED field is compared
 * three ways — the stored value, the template's value, and the marker
 * `settings.onboardingSeed.fields[field]` (hash of what this applier last
 * wrote):
 *
 *   stored == seed  → untouched by the user → take the template's value, restamp
 *   stored != seed  → the user edited it    → leave it; CONFLICT only when the
 *                                             template also moved
 *   no seed, no stored value → write the template's value, stamp
 *   no seed, stored value    → a brief written before the stamp existed:
 *                              adopt (stamp) when it equals the template, else
 *                              leave it and report — never a stamp this pass
 *                              did not earn
 *
 * BACKEND-RULES INVARIANTS (Template→installed convergence):
 *   (1) The marker asserts only what the comparator checked: one hash PER
 *       FIELD, over exactly the value this applier writes for that field.
 *   (2) The compared set IS the written set: both loops walk
 *       `SPACE_BRIEF_SEEDED_FIELDS`, and the write projects nothing else
 *       (tripwire: space-brief-seed.test.ts, parity with the canonical
 *       `SPACE_BRIEF_TEMPLATE_FIELDS` in `@synap-core/types/space-brief`).
 *
 * `rules` is NOT a seeded field: rule refs belong to the rule applier, and each
 * rule row carries its own seed (`metadata.rule.seed`).
 */

import { createHash } from "crypto";
import type {
  SpaceBriefSeed,
  WorkspaceSpaceBrief,
  WorkspaceSpaceBriefAnchor,
} from "../schema/workspaces.js";
import {
  seedKindTitleKey,
  seedRefAliasIndex,
  type SeedRefShape,
} from "./seed-refs.js";

/**
 * Mirror of `SPACE_BRIEF_TEMPLATE_FIELDS` (`@synap-core/types/space-brief`) —
 * this package cannot import it (build cycle). Parity is a test-only import.
 */
export const SPACE_BRIEF_SEEDED_FIELDS = [
  "purpose",
  "goal",
  "framing",
  "expertise",
  "collect",
  "openingQuestions",
  "doneWhen",
  "anchors",
  "fetch",
] as const satisfies ReadonlyArray<keyof WorkspaceSpaceBrief>;

export type SpaceBriefSeededField = (typeof SPACE_BRIEF_SEEDED_FIELDS)[number];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Hash of one field's value; `undefined` for an absent field. */
export function hashBriefField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The value the applier writes for each seeded field: exactly the template's
 * own field, with `anchors[].seedRef` resolved to `entityId` when the caller
 * could resolve it. Unknown template keys are dropped — the type is the SSOT.
 */
export function projectTemplateBrief(
  template: WorkspaceSpaceBrief | null | undefined,
  resolveSeedRef?: (seedRef: string) => string | undefined
): Partial<Pick<WorkspaceSpaceBrief, SpaceBriefSeededField>> {
  const out: Partial<Pick<WorkspaceSpaceBrief, SpaceBriefSeededField>> = {};
  if (!template || typeof template !== "object") return out;
  for (const field of SPACE_BRIEF_SEEDED_FIELDS) {
    const value = template[field];
    if (value === undefined || value === null) continue;
    if (field === "anchors" && Array.isArray(value)) {
      out.anchors = (value as WorkspaceSpaceBriefAnchor[]).map((a) => {
        if (a.entityId || !a.seedRef || !resolveSeedRef) return a;
        const entityId = resolveSeedRef(a.seedRef);
        return entityId ? { ...a, entityId } : a;
      });
      continue;
    }
    (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

export type BriefFieldOutcome =
  | "written" // absent, no seed → template value written + stamped
  | "updated" // untouched since last write → template's new value + restamp
  | "removed" // untouched, and the template dropped the field
  | "adopted" // stored equals template → stamped (no value change)
  | "kept"; // user-owned value, template unchanged → nothing to report

export interface BriefFieldConflict {
  field: SpaceBriefSeededField;
  /** `edited` = the user changed a value the template since changed too;
   *  `unstamped` = a value written before the stamp existed differs from the
   *  template, so this pass cannot tell template from user. */
  reason: "edited" | "unstamped";
}

export interface SpaceBriefConvergence {
  /** The brief to store; `null` when nothing changes (no write needed). */
  next: WorkspaceSpaceBrief | null;
  /** The marker to store alongside `next` (or alone, when only stamps move). */
  nextSeed: SpaceBriefSeed | null;
  outcomes: Partial<Record<SpaceBriefSeededField, BriefFieldOutcome>>;
  conflicts: BriefFieldConflict[];
}

function readSeed(raw: unknown): SpaceBriefSeed {
  const fields: Record<string, string> = {};
  const f = (raw as { fields?: unknown } | null | undefined)?.fields;
  if (f && typeof f === "object") {
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (typeof v === "string") fields[k] = v;
    }
  }
  return { v: 1, fields };
}

/**
 * PURE. Decide, field by field, what the reconcile writes. Never overwrites a
 * value the user changed; never stamps a value it did not compare.
 */
export function convergeSpaceBrief(input: {
  stored: WorkspaceSpaceBrief | null | undefined;
  seed: unknown;
  /** The applied template projection (`projectTemplateBrief`). */
  template: Partial<Pick<WorkspaceSpaceBrief, SpaceBriefSeededField>>;
}): SpaceBriefConvergence {
  const stored = (
    input.stored && typeof input.stored === "object" ? input.stored : {}
  ) as Record<string, unknown>;
  const seed = readSeed(input.seed);
  const next: Record<string, unknown> = { ...stored };
  const nextFields: Record<string, string | undefined> = { ...seed.fields };
  const outcomes: SpaceBriefConvergence["outcomes"] = {};
  const conflicts: BriefFieldConflict[] = [];
  let valueChanged = false;
  let seedChanged = false;

  for (const field of SPACE_BRIEF_SEEDED_FIELDS) {
    const t = (input.template as Record<string, unknown>)[field];
    const hT = hashBriefField(t);
    const hS = hashBriefField(stored[field]);
    const hSeed = seed.fields[field];

    if (hSeed === undefined) {
      if (hS === undefined) {
        if (hT === undefined) continue;
        next[field] = t;
        nextFields[field] = hT;
        outcomes[field] = "written";
        valueChanged = seedChanged = true;
      } else if (hS === hT) {
        nextFields[field] = hT;
        outcomes[field] = "adopted";
        seedChanged = true;
      } else if (hT !== undefined) {
        conflicts.push({ field, reason: "unstamped" });
      }
      continue;
    }

    if (hS === hSeed) {
      // Untouched since this applier wrote it: the template owns it.
      if (hT === hSeed) continue;
      if (hT === undefined) {
        delete next[field];
        delete nextFields[field];
        outcomes[field] = "removed";
      } else {
        next[field] = t;
        nextFields[field] = hT;
        outcomes[field] = "updated";
      }
      valueChanged = seedChanged = true;
      continue;
    }

    // The user changed it (including removing it).
    if (hS !== undefined && hS === hT) {
      nextFields[field] = hT;
      outcomes[field] = "adopted";
      seedChanged = true;
    } else if (hT === hSeed) {
      outcomes[field] = "kept";
    } else {
      conflicts.push({ field, reason: "edited" });
    }
  }

  return {
    next: valueChanged ? (next as WorkspaceSpaceBrief) : null,
    nextSeed: seedChanged ? { v: 1, fields: nextFields } : null,
    outcomes,
    conflicts,
  };
}

/**
 * Build the `seedRef → entityId` resolver for one template's seeds, through the
 * ONE seed ref ladder (`seedRefAliasIndex`: refKey | kind:title | unique bare
 * title). `liveIdByKindTitle` maps `${type}:${title}` of the space's live
 * entities — the same key the create path finds its seeds by.
 */
export function seedRefResolver(
  seeds: ReadonlyArray<SeedRefShape>,
  liveIdByKindTitle: ReadonlyMap<string, string>
): (seedRef: string) => string | undefined {
  const aliasesFor = seedRefAliasIndex(seeds);
  const byAlias = new Map<string, string>();
  for (const seed of seeds) {
    const id = liveIdByKindTitle.get(seedKindTitleKey(seed));
    if (!id) continue;
    for (const alias of aliasesFor(seed)) byAlias.set(alias, id);
  }
  return (seedRef) => byAlias.get(seedRef);
}
