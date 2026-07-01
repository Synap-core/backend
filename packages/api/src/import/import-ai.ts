/**
 * AI enrichment for the deterministic import pipeline.
 *
 * The import path (import-items.ts) is FAITHFUL and deterministic: it mirrors
 * what the user already organized, with no LLM. This module adds an OPTIONAL,
 * best-effort AI pass on top: it routes import items through the Intelligence
 * Service's bulk-structuring endpoint to recover a REAL typed profile + extracted
 * typed properties for each note (instead of the flat "note" default).
 *
 * It is intentionally additive and non-destructive:
 *   - It only sets `typeHint` (gated downstream against real workspace profiles)
 *     and GAP-FILLS metadata (existing frontmatter always wins).
 *   - It never throws: on any IS failure it returns items UNCHANGED so the
 *     deterministic proposal still builds. AI is an enhancement, not a dependency.
 *   - It maps each note to its single PRIMARY entity only (note → 1 typed
 *     entity). Body→document and the wikilink graph stay intact and are still
 *     built deterministically by buildImportProposal.
 *
 * Future enhancement: merge AI sub-entities + AI relations to fully decompose a
 * note into a small graph. Out of scope for this version to keep the clean
 * note→1-typed-entity mapping.
 */

import type { ImportItem } from "./import-items.js";
import type { StructuredFollowUp } from "@synap/intelligence-client";

/** Minimal structural shape of the IS bulk-structuring client we depend on. */
export interface BulkStructureClient {
  structureBulk(
    input: {
      items: Array<{
        clientId: string;
        text?: string;
        html?: string;
        url?: string;
        context?: string;
        sourceHint?: string;
      }>;
      hints?: {
        availableProfiles?: Array<{
          slug: string;
          displayName: string;
          description?: string;
          propertyHints?: string;
        }>;
      };
      concurrency?: number;
    },
    signal?: AbortSignal
  ): AsyncIterable<BulkStructureEvent>;
}

interface BulkEntity {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  confidence: number;
}

type BulkStructureEvent =
  | { type: "item-start"; clientId: string }
  | {
      type: "item-complete";
      clientId: string;
      result: {
        entities: BulkEntity[];
        relations: Array<{
          sourceTempId: string;
          targetTempId: string;
          relationType: string;
        }>;
        followUp: string | StructuredFollowUp | null;
      };
    }
  | { type: "item-error"; clientId: string; error: string }
  | { type: "batch-complete"; totalCompleted: number; totalErrored: number }
  | { type: "error"; message: string };

/**
 * Pick the PRIMARY entity for an import item from the AI's extracted entities.
 *
 * Strategy: highest confidence wins. Ties broken by title similarity to the
 * item's own title (exact lowercase match > substring inclusion), so the entity
 * that actually represents the note (vs. an incidental mentioned sub-entity) is
 * chosen. Returns undefined when there are no entities.
 */
function pickPrimaryEntity(
  entities: BulkEntity[],
  itemTitle: string
): BulkEntity | undefined {
  if (!entities.length) return undefined;
  const wanted = itemTitle.trim().toLowerCase();
  const score = (e: BulkEntity): number => {
    const t = (e.title ?? "").trim().toLowerCase();
    if (t && t === wanted) return 2;
    if (t && wanted && (t.includes(wanted) || wanted.includes(t))) return 1;
    return 0;
  };
  return [...entities].sort((a, b) => {
    const c = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (c !== 0) return c;
    return score(b) - score(a);
  })[0];
}

/**
 * Best-effort AI enrichment of import items via the IS bulk-structuring client.
 *
 * Mutates and returns the SAME `items` array (so call sites can use either the
 * return value or the original reference). For each item the AI structured, sets
 * `typeHint` to the primary entity's profile slug and gap-fills `metadata` with
 * the primary entity's properties (existing keys win).
 *
 * Never throws: on any IS error (thrown or yielded `{type:"error"}`) returns the
 * items UNCHANGED with `aiTyped: 0` and `aiFailed: items.length`.
 *
 * @returns the (possibly enriched) items plus counts of how many were AI-typed
 *          and how many failed.
 */
export async function aiEnrichImportItems(
  items: ImportItem[],
  isClient: BulkStructureClient,
  hints: {
    availableProfiles?: Array<{
      slug: string;
      displayName: string;
      description?: string;
      propertyHints?: string;
    }>;
  },
  opts?: {
    signal?: AbortSignal;
    logger?: { warn: (...args: unknown[]) => void };
  }
): Promise<{ items: ImportItem[]; aiTyped: number; aiFailed: number }> {
  if (!items.length) return { items, aiTyped: 0, aiFailed: 0 };

  const input = {
    items: items.map((item, i) => ({
      clientId: String(i),
      text: `${item.title}\n\n${item.body}`.trim(),
      sourceHint: "Obsidian vault note",
    })),
    hints,
  };

  const resultByClientId = new Map<string, BulkEntity[]>();
  let aiFailed = 0;

  try {
    for await (const event of isClient.structureBulk(input, opts?.signal)) {
      if (event.type === "item-complete") {
        resultByClientId.set(event.clientId, event.result.entities ?? []);
      } else if (event.type === "item-error") {
        aiFailed++;
      } else if (event.type === "error") {
        // Stream-level failure: abandon AI, fall back to deterministic.
        opts?.logger?.warn(
          { message: event.message },
          "aiEnrichImportItems: IS stream error, using deterministic import"
        );
        return { items, aiTyped: 0, aiFailed: items.length };
      }
    }
  } catch (err) {
    opts?.logger?.warn(
      { err },
      "aiEnrichImportItems: structureBulk threw, using deterministic import"
    );
    return { items, aiTyped: 0, aiFailed: items.length };
  }

  let aiTyped = 0;
  items.forEach((item, i) => {
    const entities = resultByClientId.get(String(i));
    if (!entities) return;
    const primary = pickPrimaryEntity(entities, item.title);
    if (!primary) return;
    item.typeHint = primary.profileSlug;
    // Gap-fill: AI-extracted properties fill holes, but real frontmatter wins.
    item.metadata = { ...(primary.properties ?? {}), ...item.metadata };
    aiTyped++;
  });

  return { items, aiTyped, aiFailed };
}
