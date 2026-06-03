/**
 * Deep structuring for prose imports.
 *
 * The canonical "decompose a note into a graph" path — the single source of
 * truth behind both `ImportOrchestrator.submitBatch` (the live product import)
 * and the `/import/analyze` REST route. Where `aiEnrichImportItems` does shallow
 * 1-file→1-typed-entity classification (correct for csv/bookmark rows), this
 * runs each prose note through the Intelligence Service's multi-entity
 * `structure` extraction and MERGES the per-note results into one deduplicated
 * graph: N notes → M typed entities (project/task/company/decision/…) + their
 * relations, with cross-note duplicates collapsed.
 *
 * Output is composite operations, directly consumable as a `data.operations`
 * payload for an `import.graph` proposal.
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";
import type { ImportItem } from "./import-items.js";

/** Minimal shape of the intelligence client's structure() we depend on. */
export interface StructureCapableClient {
  structure(input: {
    text: string;
    hints?: {
      availableProfiles?: Array<{
        slug: string;
        displayName: string;
        description?: string;
        propertyHints?: string;
      }>;
      existingEntityNames?: string[];
    };
    timeoutMs?: number;
  }): Promise<{
    entities: Array<{
      tempId: string;
      profileSlug: string;
      title: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence: number;
    }>;
    relations: Array<{
      sourceTempId: string;
      targetTempId: string;
      relationType: string;
    }>;
  } | null>;
}

export interface DeepStructureStats {
  itemsProcessed: number;
  itemsFailed: number;
  entityCount: number;
  relationCount: number;
  duplicatesMerged: number;
  documentCount: number;
  /** Source-note provenance entities created (one per processed note). */
  sourceDocCount: number;
  byType: Record<string, number>;
}

export interface DeepStructureResult {
  operations: CompositeProposalOperation[];
  stats: DeepStructureStats;
}

interface DeepStructureOptions {
  /** Typed profile hints for the structuring model (from buildAvailableProfiles). */
  availableProfiles?: Array<{
    slug: string;
    displayName: string;
    description?: string;
    propertyHints?: string;
  }>;
  /** Slugs the workspace actually has — anything else falls back to "note". */
  validSlugs: Set<string>;
  /** Max concurrent structure calls (IS is a single shared model — keep modest). */
  concurrency?: number;
  /** Per-note structure timeout in ms (default 60000 — long notes are slow). */
  timeoutMs?: number;
  /** Preserve each note as a source document + link extracted entities (default true). */
  includeProvenance?: boolean;
}

interface DeepStructureDeps {
  logger: { warn: (obj: unknown, msg: string) => void };
}

const normTitle = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);

/**
 * Run each prose item through multi-entity structure extraction and merge the
 * results into one deduplicated composite graph. Per-item failures (timeouts,
 * IS errors) are logged and skipped — the import proceeds with what succeeded.
 */
export async function deepStructureImportItems(
  items: ImportItem[],
  client: StructureCapableClient,
  opts: DeepStructureOptions,
  deps: DeepStructureDeps
): Promise<DeepStructureResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  // Long prose notes routinely exceed the 25s default — raise it for imports,
  // and retry once (the IS returns null on timeout/transient failure) so a
  // single slow note doesn't silently drop from the graph.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const includeProvenance = opts.includeProvenance ?? true;

  // 1. Extract per-item (concurrency-limited).
  const extracted: Array<Awaited<
    ReturnType<StructureCapableClient["structure"]>
  > | null> = new Array(items.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      if (!item.body || !item.body.trim()) continue;
      const call = () =>
        client.structure({
          text: item.body,
          hints: { availableProfiles: opts.availableProfiles },
          timeoutMs,
        });
      try {
        let res = await call();
        if (!res) res = await call(); // one retry on null (timeout/transient)
        extracted[i] = res;
      } catch (err) {
        deps.logger.warn(
          { err, title: item.title },
          "deep import: structure extraction failed for item"
        );
        extracted[i] = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );

  // 2. Merge + dedup across items into one graph.
  const refByKey = new Map<string, string>(); // profileSlug|normTitle → ref
  const operations: CompositeProposalOperation[] = [];
  const byType: Record<string, number> = {};
  let refCounter = 0;
  let duplicatesMerged = 0;
  let documentCount = 0;
  let sourceDocCount = 0;
  let itemsProcessed = 0;
  let itemsFailed = 0;

  for (let i = 0; i < items.length; i++) {
    const res = extracted[i];
    if (!res || !Array.isArray(res.entities)) {
      if (items[i].body?.trim()) itemsFailed++;
      continue;
    }
    itemsProcessed++;
    const localToRef = new Map<string, string>(); // note-local tempId → graph ref

    // Provenance: preserve the original note as a versioned-document entity that
    // every entity extracted from it links back to (source of truth + traceable).
    let srcRef: string | undefined;
    if (includeProvenance && items[i].body?.trim()) {
      srcRef = `src${i}`;
      operations.push({
        op: "create_entity",
        ref: srcRef,
        profileSlug: "note",
        title: items[i].title || "Imported note",
        content: items[i].body, // → versioned document on materialize
      });
      sourceDocCount++;
    }

    for (const e of res.entities) {
      const rawTitle = String(e.title ?? items[i].title ?? "Untitled");
      const titleIsBody = rawTitle.length > 120; // fallback "whole note" entity
      const title =
        rawTitle.split("\n")[0].slice(0, 80).trim() ||
        items[i].title ||
        "Untitled";
      const slug = opts.validSlugs.has(e.profileSlug) ? e.profileSlug : "note";
      const key = `${slug}|${normTitle(title)}`;

      const existing = refByKey.get(key);
      if (existing) {
        duplicatesMerged++;
        localToRef.set(e.tempId, existing);
        continue;
      }

      const ref = `e${refCounter++}`;
      refByKey.set(key, ref);
      localToRef.set(e.tempId, ref);

      const op: Extract<CompositeProposalOperation, { op: "create_entity" }> = {
        op: "create_entity",
        ref,
        profileSlug: slug,
        title,
        properties: e.properties ?? {},
      };
      // Long body (a list/note that didn't decompose) → versioned document;
      // otherwise keep the short description on the entity.
      const longBody = titleIsBody
        ? rawTitle
        : typeof e.description === "string" &&
            shouldMaterializeAsDocument(e.description)
          ? e.description
          : undefined;
      if (longBody) {
        op.content = longBody;
        documentCount++;
      } else if (e.description) {
        op.description = String(e.description).slice(0, 2000);
      }
      operations.push(op);
      byType[slug] = (byType[slug] ?? 0) + 1;
    }

    // Provenance links: source note → each entity extracted from it. A
    // cross-note duplicate therefore links back to EVERY note it appeared in.
    if (srcRef) {
      for (const entRef of new Set(localToRef.values())) {
        operations.push({
          op: "create_relation",
          type: "references",
          sourceRef: srcRef,
          targetRef: entRef,
        });
      }
    }

    for (const rel of res.relations ?? []) {
      const sourceRef = localToRef.get(rel.sourceTempId);
      const targetRef = localToRef.get(rel.targetTempId);
      if (!sourceRef || !targetRef || sourceRef === targetRef) continue;
      operations.push({
        op: "create_relation",
        type: rel.relationType || "relates_to",
        sourceRef,
        targetRef,
      });
    }
  }

  return {
    operations,
    stats: {
      itemsProcessed,
      itemsFailed,
      entityCount: operations.filter((o) => o.op === "create_entity").length,
      relationCount: operations.filter((o) => o.op === "create_relation")
        .length,
      duplicatesMerged,
      documentCount,
      sourceDocCount,
      byType,
    },
  };
}
