/**
 * The open intent registry. `ABSTRACT_VERBS` is the seed: a slug in that list
 * is known even before the table is read. Any other slug is known only when
 * `capability_intents` has the row.
 *
 * Routing only. This module does not decide propose vs auto.
 */
import { eq } from "drizzle-orm";
import { db, capabilityIntents } from "@synap/database";
import {
  ABSTRACT_VERBS,
  isAbstractVerb,
  type AbstractVerb,
} from "@synap/database/schema";

export async function listIntentSlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: capabilityIntents.slug })
    .from(capabilityIntents);
  return [...new Set<string>([...ABSTRACT_VERBS, ...rows.map((r) => r.slug)])];
}

/** Seed member, or a row in the registry. Anything else is unknown. */
export async function isKnownIntent(value: unknown): Promise<boolean> {
  if (isAbstractVerb(value)) return true;
  if (typeof value !== "string") return false;
  const rows = await db
    .select({ slug: capabilityIntents.slug })
    .from(capabilityIntents)
    .where(eq(capabilityIntents.slug, value))
    .limit(1);
  return rows.length > 0;
}

/**
 * The allow-set `deriveToolVerbs` needs. Undefined when every declared intent
 * is already in the seed — callers then skip the table, and tests that only
 * use the 13 never touch it.
 */
export async function knownIntentSetFor(
  intents: readonly unknown[]
): Promise<ReadonlySet<string> | undefined> {
  const novel = intents.some(
    (intent) => typeof intent === "string" && !isAbstractVerb(intent)
  );
  if (!novel) return undefined;
  return new Set(await listIntentSlugs());
}

export function intentError(slug: unknown): string {
  return (
    `Unknown intent ${JSON.stringify(slug)}. It is not in the intent registry. ` +
    `The seed is: ${ABSTRACT_VERBS.join(", ")}.`
  );
}

export type { AbstractVerb };
