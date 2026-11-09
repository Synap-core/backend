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

/** One intent with the words a person may use for it (its row's own text). */
export interface IntentRow {
  slug: string;
  /** What the intent does, one sentence. `""` for a seed slug with no row. */
  statement: string;
  /** Other ways to say it ("remove background", "youtube"). */
  synonyms: string[];
}

/**
 * Every known intent WITH its statement and synonyms, for a ranker that must
 * match a person's words ("remove my background") and not only the slug's
 * (`edit_video`). Same set as {@link listIntentSlugs}: the seed first, then
 * every row; a seed slug whose row is missing still comes back, with no words.
 */
export async function listIntentRows(): Promise<IntentRow[]> {
  const rows = await db
    .select({
      slug: capabilityIntents.slug,
      statement: capabilityIntents.statement,
      synonyms: capabilityIntents.synonyms,
    })
    .from(capabilityIntents);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const slugs = [...new Set<string>([...ABSTRACT_VERBS, ...bySlug.keys()])];
  return slugs.map((slug) => {
    const row = bySlug.get(slug);
    return {
      slug,
      statement: row?.statement ?? "",
      synonyms: row?.synonyms ?? [],
    };
  });
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

/** What a pod app's run of an intent reads off its registry row. */
export interface IntentInputRow {
  /** read | write | act — anything but `read` reaches outside the pod. */
  effect: string;
  /** The ONE input shape (JSON Schema, 0368); null = apps cannot ask yet. */
  inputSchema: Record<string, unknown> | null;
}

/** The intent's row as the app intent doors read it, or null if unknown. */
export async function loadIntentInput(
  slug: string
): Promise<IntentInputRow | null> {
  const [row] = await db
    .select({
      effect: capabilityIntents.effect,
      inputSchema: capabilityIntents.inputSchema,
    })
    .from(capabilityIntents)
    .where(eq(capabilityIntents.slug, slug))
    .limit(1);
  if (!row) return null;
  const schema = row.inputSchema;
  return {
    effect: row.effect,
    inputSchema:
      schema && typeof schema === "object" && !Array.isArray(schema)
        ? schema
        : null,
  };
}
