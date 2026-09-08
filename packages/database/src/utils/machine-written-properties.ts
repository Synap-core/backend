/**
 * Machine-written property definitions — the read-only declaration and the
 * pass that converges it onto pods that were already seeded.
 *
 * WHY THIS FILE EXISTS
 *
 * A closed-choice (`select`) property is editable by default, and that is right
 * for a task's status — a human owns it. It is wrong for the six enums below: a
 * job, an ingestion pipeline or the AI writes them, and the schema merely
 * DECLARES them to the user. Left editable, a user can mark a failed deployment
 * "success" and the record then lies about what happened.
 *
 * The declaration must live on the SCHEMA (`uiHints.readOnly`), not in a
 * per-surface deny-list: relay's `isSchemaReadOnly` and `browser/`'s
 * `InlinePropertyEditor` are two of N editors and they fork the moment a second
 * list exists.
 *
 * WHY A CONVERGENCE PASS AND NOT A SEED EDIT
 *
 * The general property-def path in `ensure-system-profiles.ts` is CREATE-ONLY:
 *
 *     const existing = await propertyDefRepo.getBySlug(slug, undefined, null);
 *     if (existing) { createdPropertyDefs.set(slug, existing.id); }  // no update
 *     else { create }
 *
 * so adding `readOnly: true` to the seed literals alone would reach ZERO
 * existing pods — the exact failure `.claude/rules/backend-rules.md` documents
 * ("intent reached ZERO pods"). Instead the hint is applied by this ONE pass,
 * which runs over the ids the seeder just resolved, for freshly-created and
 * pre-existing defs ALIKE. Fresh and converged pods therefore travel the same
 * code path: there is no second, blinder writer to drift from.
 *
 * The marker asserts only what the comparator checked: the comparator reads
 * `uiHints.readOnly` and the applier writes `uiHints.readOnly`. Nothing else on
 * `uiHints` is compared, and nothing else is written — the existing hints are
 * MERGED, never replaced, so a user's label/help/format edits survive.
 */

import type { PropertyDefRepository } from "../repositories/property-def-repository.js";
import type { PropertyUIHints } from "../schema/property-defs.js";

/**
 * Property slugs a MACHINE writes and the user only reads.
 *
 * Adding a slug here is the whole change: the pass below stamps it on every pod
 * on the next boot. Each slug must be one this seeder actually declares —
 * `machine-written-properties.test.ts` fails on a slug no seeder owns, which is
 * how a typo would otherwise become a hint that silently never converges.
 */
export const MACHINE_WRITTEN_PROPERTY_SLUGS = [
  // Job outcomes — written by the runner, never by a person.
  "runStatus",
  "deployStatus",
  "lastRunStatus",
  "reportStatus",
  // Provenance — how the row got here.
  "captureMethod",
  // AI-derived.
  "sentiment",
] as const;

export type MachineWrittenPropertySlug =
  (typeof MACHINE_WRITTEN_PROPERTY_SLUGS)[number];

const MACHINE_WRITTEN_SLUG_SET: ReadonlySet<string> = new Set(
  MACHINE_WRITTEN_PROPERTY_SLUGS
);

export function isMachineWrittenPropertySlug(slug: string): boolean {
  return MACHINE_WRITTEN_SLUG_SET.has(slug);
}

/**
 * Assert `uiHints.readOnly === true` on every machine-written def the caller
 * resolved. Idempotent: a def already carrying the hint is not rewritten.
 *
 * @param resolvedDefIds slug → property_def id, as built by the seeder's
 *   create-or-resolve loop. Slugs this seeder does not own are skipped, so the
 *   same pass is safe to call from every seeder.
 * @returns the slugs whose def was actually updated (empty on a converged pod).
 */
export async function ensureMachineWrittenPropertiesReadOnly(
  propertyDefRepo: Pick<PropertyDefRepository, "getById" | "update">,
  resolvedDefIds: ReadonlyMap<string, string>
): Promise<string[]> {
  const updated: string[] = [];

  for (const slug of MACHINE_WRITTEN_PROPERTY_SLUGS) {
    const defId = resolvedDefIds.get(slug);
    if (!defId) continue;

    const existing = await propertyDefRepo.getById(defId);
    if (!existing) continue;

    const hints = (existing.uiHints ?? {}) as PropertyUIHints;
    if (hints.readOnly === true) continue;

    // MERGE — `PropertyDefRepository.update` replaces the whole jsonb column,
    // so spreading the stored hints is what keeps user configuration.
    await propertyDefRepo.update(defId, {
      uiHints: { ...hints, readOnly: true },
    });
    updated.push(slug);
  }

  return updated;
}
