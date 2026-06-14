/**
 * Cross-chunk graph-merge state for large imports.
 *
 * `deepStructureImportItems` dedups WITHIN a single call: its `refByKey` map,
 * `seenTitles` set, and `makeGraphResolver` live-search all reset at the call
 * boundary. For a large import we split the corpus into chunks and call the deep
 * importer once per chunk — without shared state, a person named across two
 * chunks becomes two entities. `SharedGraphResolver` is the in-memory carrier
 * that survives those boundaries so the WHOLE import dedups as one graph.
 *
 * It wraps the existing `makeGraphResolver` (live workspace search) and layers:
 *   1. `refByKey`  — entities CREATED in earlier chunks (key → synthetic ref),
 *      so a duplicate in a later chunk links to the earlier creation.
 *   2. `existingResolved` — memoized live-search results (one search per key
 *      across the whole import, not once per chunk).
 *   3. `seenTitles` — accumulated entity titles fed forward as the deep
 *      importer's `existingEntityNames` hint, giving later chunks awareness of
 *      what earlier chunks already found.
 *
 * The `key` and title normalization MUST match the deep importer exactly, so we
 * import its `normTitle` (single source of truth).
 */

import { normTitle } from "./import-deep.js";

/** Live-search delegate — same signature as `makeGraphResolver(...)` returns. */
type LiveResolve = (
  profileSlug: string,
  title: string
) => Promise<string | null>;

/** Max entity-name hints fed forward to a later chunk (matches the deep
 *  importer's own `seenTitles.slice(0, 120)` cap). */
const MAX_EXISTING_NAME_HINTS = 120;

export class SharedGraphResolver {
  /** "slug|normTitle" → synthetic ref of an entity created in an earlier chunk. */
  private readonly refByKey = new Map<string, string>();
  /** Accumulated normalized entity titles (the `existingEntityNames` hint). */
  private readonly seenTitles = new Set<string>();
  /** Memoized live-search results — "slug|normTitle" → realId | null. */
  private readonly existingResolved = new Map<string, string | null>();

  constructor(private readonly liveResolve: LiveResolve) {}

  private static key(slug: string, title: string): string {
    return `${slug}|${normTitle(title)}`;
  }

  /**
   * Resolve an extracted entity against entities created in EARLIER chunks, then
   * (memoized) against the live workspace. Returns an existing/created entity id
   * for a confident match (→ link instead of create), else null.
   *
   * The returned id may be a synthetic ref (for an earlier-chunk creation) — the
   * deep importer treats it as `existingEntityId`, and on materialize that ref
   * resolves to the real id via the cumulative ref→id map (applyLarge seeds it).
   */
  async resolveExisting(slug: string, title: string): Promise<string | null> {
    const k = SharedGraphResolver.key(slug, title);

    // 1. Created in an earlier chunk → link to that synthetic ref.
    const fromCreated = this.refByKey.get(k);
    if (fromCreated) return fromCreated;

    // 2. Live workspace — memoized so we search each key once per import.
    if (this.existingResolved.has(k)) {
      return this.existingResolved.get(k) ?? null;
    }
    const live = await this.liveResolve(slug, title);
    this.existingResolved.set(k, live);
    return live;
  }

  /**
   * Record an entity CREATED in a chunk so the next chunk dedups against it.
   * `ref` is the synthetic ref the chunk assigned to the create_entity op.
   */
  registerCreated(slug: string, title: string, ref: string): void {
    const k = SharedGraphResolver.key(slug, title);
    if (!this.refByKey.has(k)) this.refByKey.set(k, ref);
    this.seenTitles.add(normTitle(title));
  }

  /** Accumulated entity-name hints (capped), fed to the next chunk as
   *  `existingEntityNames` so it unifies entities it has not itself seen. */
  getExistingEntityNames(): string[] {
    return Array.from(this.seenTitles).slice(0, MAX_EXISTING_NAME_HINTS);
  }
}
