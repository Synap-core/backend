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
      availableWorkspaces?: Array<{
        id: string;
        name: string;
        description?: string;
      }>;
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
    targetWorkspaceId?: string | null;
  } | null>;
}

export interface DeepStructureStats {
  itemsProcessed: number;
  itemsFailed: number;
  entityCount: number;
  relationCount: number;
  duplicatesMerged: number;
  /** Entities linked to a pre-existing graph entity instead of created. */
  linkedToExisting: number;
  documentCount: number;
  /** Source-note provenance entities created (one per processed note). */
  sourceDocCount: number;
  /** The workspace the model most often suggested these notes belong in. */
  suggestedWorkspaceId?: string;
  byType: Record<string, number>;
  /** Wikilinks resolved to a batch entity or existing workspace entity. */
  wikilinkLinksResolved: number;
  /** Wikilinks with no match in the batch or workspace — skipped silently. */
  wikilinkLinksUnresolved: number;
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
  /** The user's workspaces — lets the model suggest where entities belong. */
  availableWorkspaces?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  /** Slugs the workspace actually has — anything else falls back to "note". */
  validSlugs: Set<string>;
  /** Max concurrent structure calls (IS is a single shared model — keep modest). */
  concurrency?: number;
  /** Per-note structure timeout in ms (default 60000 — long notes are slow). */
  timeoutMs?: number;
  /** Preserve each note as a source document + link extracted entities (default true). */
  includeProvenance?: boolean;
  /**
   * Resolve an extracted entity against the LIVE graph. Return an existing
   * entity id for a confident match (→ link instead of create), else null.
   * Omitted → no merge (every entity is created).
   */
  resolveExisting?: (
    profileSlug: string,
    title: string
  ) => Promise<string | null>;
  /**
   * Entity names found in EARLIER chunks of a larger import, pre-seeded into the
   * `existingEntityNames` hint so this chunk unifies entities it has not itself
   * seen. Used by `analyzeLarge` (cross-chunk dedup); omitted for a single call.
   */
  seedExistingNames?: string[];
}

interface DeepStructureDeps {
  logger: { warn: (obj: unknown, msg: string) => void };
}

/** Canonical title normalization — shared by within-batch dedup AND the
 *  graph-merge resolver so "same entity" means the same thing in both. */
export const normTitle = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);

/** Minimal search surface needed for graph-merge resolution. */
export interface EntitySearch {
  searchCollection(
    collection: string,
    query: string,
    opts: { userId: string; workspaceId?: string; limit?: number }
  ): Promise<{
    results: Array<{
      document?: { id?: string; title?: string; entityType?: string };
    }>;
  }>;
}

/**
 * Build a `resolveExisting` that links an extracted entity to a LIVE workspace
 * entity only on a CONFIDENT match (exact normalized title + same profileSlug).
 * Conservative by design — a wrong merge is worse than a duplicate. Returns null
 * on any search failure (no merge). Shared by submitBatch + /import/analyze.
 */
export function makeGraphResolver(
  search: EntitySearch,
  ctx: { userId: string; workspaceId?: string }
): (profileSlug: string, title: string) => Promise<string | null> {
  return async (profileSlug, title) => {
    try {
      const sr = await search.searchCollection("entities", title, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        limit: 3,
      });
      const want = normTitle(title);
      for (const r of sr.results) {
        const doc = r.document;
        if (
          doc?.id &&
          normTitle(doc.title) === want &&
          (doc.entityType ?? "note") === profileSlug
        ) {
          return doc.id;
        }
      }
    } catch {
      /* search unavailable → no merge */
    }
    return null;
  };
}

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

  // 1. Extract in WAVES, accumulating entity names as `existingEntityNames`
  //    hints. This gives later notes awareness of entities already found, so the
  //    SAME entity mentioned in different notes is unified (cross-note
  //    connectivity) rather than fragmented — the graph connects across notes
  //    via shared entities. Concurrent within a wave; waves run in order.
  const extracted: Array<Awaited<
    ReturnType<StructureCapableClient["structure"]>
  > | null> = new Array(items.length).fill(null);
  const seenTitles = new Set<string>();
  // Pre-seed with entity names from earlier chunks (cross-chunk dedup): later
  // chunks get awareness of entities found before this call started.
  if (opts.seedExistingNames)
    for (const n of opts.seedExistingNames) seenTitles.add(normTitle(n));
  const wsVotes = new Map<string, number>(); // targetWorkspaceId → count
  for (let start = 0; start < items.length; start += concurrency) {
    const waveHint = Array.from(seenTitles).slice(0, 120);
    const wave: number[] = [];
    for (let k = start; k < Math.min(start + concurrency, items.length); k++)
      wave.push(k);
    await Promise.all(
      wave.map(async (i) => {
        const item = items[i];
        if (!item.body || !item.body.trim()) return;
        const call = () =>
          client.structure({
            text: item.body,
            hints: {
              availableProfiles: opts.availableProfiles,
              existingEntityNames: waveHint,
              availableWorkspaces: opts.availableWorkspaces,
            },
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
      })
    );
    // Feed this wave's entity names forward + tally workspace suggestions.
    for (const i of wave) {
      const r = extracted[i];
      if (!r) continue;
      if (r.entities)
        for (const e of r.entities)
          if (e.title) seenTitles.add(normTitle(e.title));
      if (r.targetWorkspaceId)
        wsVotes.set(
          r.targetWorkspaceId,
          (wsVotes.get(r.targetWorkspaceId) ?? 0) + 1
        );
    }
  }

  // Dominant workspace the model suggested these notes belong in (if any).
  let suggestedWorkspaceId: string | undefined;
  let topVotes = 0;
  for (const [wid, votes] of wsVotes) {
    if (votes > topVotes) {
      topVotes = votes;
      suggestedWorkspaceId = wid;
    }
  }

  // 2. Merge + dedup across items into one graph.
  const refByKey = new Map<string, string>(); // profileSlug|normTitle → ref
  const operations: CompositeProposalOperation[] = [];
  const byType: Record<string, number> = {};
  let refCounter = 0;
  let duplicatesMerged = 0;
  let linkedToExisting = 0;
  let documentCount = 0;
  let sourceDocCount = 0;
  let itemsProcessed = 0;
  let itemsFailed = 0;

  // Maps normTitle(item.title) → srcRef for the wikilink resolution pass below.
  // Populated as provenance entities are created so that ordering is stable and
  // the same normTitle logic is reused (no second normalizer).
  const srcRefByNormTitle = new Map<string, string>();

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
      // Register for wikilink resolution — links target notes by their filename/title.
      srcRefByNormTitle.set(normTitle(items[i].title), srcRef);
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

      // Merge into the EXISTING graph: a confident title+type match against the
      // live workspace links to that entity (existingEntityId) instead of
      // creating a duplicate — the vault grows ONE graph, not islands.
      const existingId = opts.resolveExisting
        ? await opts.resolveExisting(slug, title)
        : null;
      if (existingId) {
        operations.push({
          op: "create_entity",
          ref,
          profileSlug: slug,
          title,
          existingEntityId: existingId,
        });
        linkedToExisting++;
        continue;
      }

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

  // 3. Wikilink resolution pass — emit `references` relations from each source
  //    note's provenance entity to the target note's provenance entity (or an
  //    existing workspace entity matched via resolveExisting). This preserves
  //    the full Obsidian link graph that extractWikilinks() already parsed.
  //
  //    Dedup set is pre-seeded with relations already emitted (provenance links)
  //    so we never emit a duplicate op for the same (source, target) pair.
  let wikilinkLinksResolved = 0;
  let wikilinkLinksUnresolved = 0;

  if (includeProvenance && srcRefByNormTitle.size > 0) {
    // Pre-seed the dedup set from ops already emitted so far.
    const emittedRelationKeys = new Set<string>();
    for (const op of operations) {
      if (op.op === "create_relation") {
        emittedRelationKeys.add(`${op.sourceRef}|${op.targetRef}`);
      }
    }

    // Memoize workspace lookups: hub notes are linked from many notes, and
    // without this each occurrence fires a separate resolveExisting search.
    const resolvedExistingByKey = new Map<string, string | null>();

    // For each item that has a provenance entity, resolve its wikilinks.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.links || item.links.length === 0) continue;
      const srcRef = srcRefByNormTitle.get(normTitle(item.title));
      if (!srcRef) continue; // item had no body → no provenance entity → skip

      for (const link of item.links) {
        const targetKey = normTitle(link.targetName);

        // (a) Resolve against the batch's own provenance title map.
        let targetRef = srcRefByNormTitle.get(targetKey) ?? null;

        // (b) If not in the batch and resolveExisting is available, try the
        //     live workspace. We search as profileSlug="note" — the provenance
        //     entities are always notes and wikilinks target notes by filename.
        //     A hit returns the real entity id; we reference it directly in the
        //     op (the materializer handles ref→id resolution for existing ids).
        if (!targetRef && opts.resolveExisting) {
          let existingId = resolvedExistingByKey.get(targetKey);
          if (existingId === undefined) {
            existingId = await opts.resolveExisting("note", link.targetName);
            resolvedExistingByKey.set(targetKey, existingId);
          }
          if (existingId) {
            // Use a synthetic ref that encodes the existing id so the
            // materializer can resolve it. The convention for existingEntityId
            // ops is already used elsewhere in this file (see linkedToExisting).
            const existingRef = `existing_wl_${existingId}`;
            // Only emit the anchor op once per unique existing entity.
            if (!refByKey.has(`existing_wl|${existingId}`)) {
              refByKey.set(`existing_wl|${existingId}`, existingRef);
              operations.push({
                op: "create_entity",
                ref: existingRef,
                profileSlug: "note",
                title: link.targetName,
                existingEntityId: existingId,
              });
            }
            targetRef = refByKey.get(`existing_wl|${existingId}`) ?? null;
          }
        }

        if (!targetRef || targetRef === srcRef) {
          // Self-link or genuinely unresolved — skip silently, count it.
          wikilinkLinksUnresolved++;
          continue;
        }

        const dedupKey = `${srcRef}|${targetRef}`;
        if (emittedRelationKeys.has(dedupKey)) continue;
        emittedRelationKeys.add(dedupKey);

        operations.push({
          op: "create_relation",
          type: "references",
          sourceRef: srcRef,
          targetRef,
        });
        wikilinkLinksResolved++;
      }
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
      linkedToExisting,
      documentCount,
      sourceDocCount,
      suggestedWorkspaceId,
      byType,
      wikilinkLinksResolved,
      wikilinkLinksUnresolved,
    },
  };
}
