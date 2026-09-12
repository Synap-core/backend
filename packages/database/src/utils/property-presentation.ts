/**
 * THE ONE READER between a stored property def and the two things every
 * describing surface needs from it: its human LABEL and its closed set of
 * admissible OPTIONS.
 *
 * ── Why this file exists (measured live, 2026-09-12) ────────────────────────
 * `hub-protocol/rest/discover.ts` — THE schema door AI agents call to learn how
 * to write — read two keys that nothing in this codebase has ever written:
 *
 *   options     ← `constraints.options` ?? `uiHints.options`
 *   displayName ← `uiHints.displayName`
 *
 * The seeds (`ensure-system-profiles.ts`) write `constraints.enum` and
 * `uiHints.label`. So on the live pod, EVERY property of EVERY profile came
 * back with `options` absent and `displayName === slug`:
 *
 *   task.status             constraints.enum = [todo,in-progress,done,cancelled]   options: (absent)
 *   task.priority           constraints.enum = [low,medium,high,urgent]            options: (absent)
 *   decision.decisionStatus constraints.enum = [proposed,accepted,superseded,…]    options: (absent)
 *
 * A real client's agent read the `decision` schema, saw `status` as an
 * unconstrained string, wrote `status: "open"` and was rejected by a validator
 * quoting an enum it had never been shown. The agent did everything right; the
 * door lied to it.
 *
 * ── Precedence, and why it is this way round ────────────────────────────────
 * OPTIONS: `constraints.enum` FIRST, always. It is the STORED TRUTH (see
 * `property-enum.ts`) and — this is the load-bearing half — it is the ONLY key
 * `property-validation-service.ts` enforces. Whatever this function emits is a
 * promise about what the WRITE PATH will accept, so it must agree with the
 * validator or it is a new, quieter version of the same lie. The legacy
 * `constraints.options` / `uiHints.options` spellings stay as FALLBACKS only,
 * so a custom def already authored either way keeps working; they can never
 * outrank the key the validator reads.
 *
 * LABEL: `uiHints.displayName` → `uiHints.label` → raw slug. This is a MIRROR
 * of the SSOT, `resolvePropertyLabel` in `@synap-core/property-renderer`
 * (synap-app), which synap-backend cannot import (not a dependency; not
 * resolvable). Rungs 1–2 are identical and held identical by
 * `api/src/__tripwires__/property-label-mirror-drift.test.ts`, which runs both.
 * Rung 3 diverges ON PURPOSE: the SSOT humanizes the slug for a human; this
 * returns the raw slug, because for an agent reading a schema door the slug is
 * the token it must WRITE. 0 of 159 seeded defs reach rung 3 (all carry
 * `label`), so it only touches unlabelled custom properties.
 *
 * ⚠️ Deliberately NOT read here: `uiHints.enumValues`. That is the authoring
 * spelling, unenforced by the validator, and migration 0247 backfilled it into
 * `constraints.enum`. `readStoredEnum()` in `property-enum.ts` reads it, and
 * that fallback is scoped to the reconciler's drift comparison — see the
 * warning on that function. Emitting it from a describing surface would
 * advertise values the write path does not accept: the inverse of this bug,
 * not a fix for it.
 */

interface HintBag {
  [key: string]: unknown;
}

/** A property def as read back from the database (or a tRPC projection of one). */
export interface StoredPropertyPresentation {
  slug?: unknown;
  constraints?: unknown;
  uiHints?: unknown;
}

function asBag(value: unknown): HintBag | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as HintBag)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The closed set of admissible values for a property, or `undefined` when the
 * property is open. See the precedence note in this file's header.
 */
export function resolvePropertyOptions(
  def: StoredPropertyPresentation
): string[] | undefined {
  const constraints = asBag(def.constraints);
  const uiHints = asBag(def.uiHints);
  return (
    asStringArray(constraints?.enum) ??
    asStringArray(constraints?.options) ??
    asStringArray(uiHints?.options)
  );
}

/**
 * The human label for a property: `uiHints.displayName` → `uiHints.label` →
 * raw slug. Never returns an empty string.
 */
export function resolvePropertyLabel(def: StoredPropertyPresentation): string {
  const uiHints = asBag(def.uiHints);
  return (
    asTrimmedString(uiHints?.displayName) ||
    asTrimmedString(uiHints?.label) ||
    String(def.slug ?? "")
  );
}
