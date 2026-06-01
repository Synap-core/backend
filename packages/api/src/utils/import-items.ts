/**
 * Source-agnostic import model.
 *
 * Every importable source (Obsidian, Apple Notes, a folder of files, Notion, …)
 * normalizes to the SAME shape: a list of ImportItems. An ImportItem is anything
 * with a title, an optional hierarchy path, key/value metadata, body text, and
 * cross-references to other items by name.
 *
 * Downstream of this type, NOTHING is source-specific: the proposal builder, the
 * endpoint, and the materializer all speak ImportItem. Source-specific parsing
 * lives ONLY in adapters (see import-adapters.ts).
 *
 * This is deterministic FAITHFUL ingestion — it mirrors what the user already
 * organized. It is deliberately NOT the AI capture path (capture.structure),
 * which is for turning ONE blob of unstructured text into entities. Importing N
 * already-structured items must be cheap and predictable, so no LLM here.
 * AI-driven *restructuring* of an imported corpus is a separate later step.
 */

export interface ImportLink {
  /** Target item name as referenced by the source (without #anchor or |alias). */
  targetName: string;
  /** Optional display alias, when the source supports it. */
  alias?: string;
}

export interface ImportItem {
  /** Display title of the item. */
  title: string;
  /** Hierarchy path segments (e.g. folders), outermost first. May be empty. */
  path: string[];
  /** Structured key/value metadata (e.g. frontmatter). */
  metadata: Record<string, unknown>;
  /** Free-form body content. */
  body: string;
  /** Outgoing references to other items, by name. */
  links: ImportLink[];
  /** Free-form labels (e.g. tags). */
  labels: string[];
  /**
   * Caller-supplied type hint for this item, if the source knows it
   * (e.g. frontmatter `type`). Takes precedence over path-derived typing.
   */
  typeHint?: string;
}

// ── Proposal (source-agnostic) ────────────────────────────────────────────────

export interface ProposedType {
  /** kebab/lower slug, e.g. "project". */
  slug: string;
  displayName: string;
  /** Why this type was inferred — for the review UI. */
  source: "type-hint" | "path" | "default";
  /** Metadata keys observed across items of this type. */
  metadataKeys: string[];
  itemCount: number;
}

export interface ProposedItem {
  tempId: string;
  typeSlug: string;
  title: string;
  /** metadata merged with body content. */
  properties: Record<string, unknown>;
  /** Original source location, for traceability. */
  sourceRef: string;
  labels: string[];
}

export interface ProposedReference {
  sourceTempId: string;
  /** Resolved tempId when the link matched an item in this batch. */
  targetTempId?: string;
  /** Raw target name, kept when unresolved (target outside the batch). */
  targetName: string;
  relationType: string;
  resolved: boolean;
}

export interface ImportProposal {
  types: ProposedType[];
  items: ProposedItem[];
  references: ProposedReference[];
  stats: {
    itemCount: number;
    typeCount: number;
    referenceCount: number;
    unresolvedReferences: number;
  };
}

/** Normalize an arbitrary label into a type slug. */
export function toSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Decide an item's type slug. Precedence:
 *   1. explicit typeHint (source knows the type)
 *   2. outermost path segment (folder-as-category convention)
 *   3. "note" default
 */
function typeForItem(item: ImportItem): {
  slug: string;
  source: ProposedType["source"];
} {
  if (item.typeHint && item.typeHint.trim()) {
    return { slug: toSlug(item.typeHint), source: "type-hint" };
  }
  if (item.path.length > 0) {
    return { slug: toSlug(item.path[0]), source: "path" };
  }
  return { slug: "note", source: "default" };
}

/**
 * Build a governed, source-agnostic structure proposal from import items.
 * Deterministic and pure: same input → same proposal, no LLM, no DB.
 *
 * @param items Normalized import items (produced by a source adapter).
 * @param relationType Relation type for links (default "references").
 */
export function buildImportProposal(
  items: ImportItem[],
  relationType = "references"
): ImportProposal {
  const proposedItems: ProposedItem[] = [];
  const tempIdByName = new Map<string, string>(); // lowercased title → tempId
  const typeAgg = new Map<
    string,
    {
      displayName: string;
      source: ProposedType["source"];
      keys: Set<string>;
      count: number;
    }
  >();

  items.forEach((item, i) => {
    const { slug, source } = typeForItem(item);
    const tempId = `t${i + 1}`;
    const metadata =
      item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const properties: Record<string, unknown> = {
      ...metadata,
      ...(item.body ? { content: item.body } : {}),
    };
    proposedItems.push({
      tempId,
      typeSlug: slug,
      title:
        (typeof metadata.title === "string" && metadata.title) || item.title,
      properties,
      sourceRef: [...item.path, item.title].join("/"),
      labels: item.labels,
    });

    const key = item.title.toLowerCase();
    if (!tempIdByName.has(key)) tempIdByName.set(key, tempId);

    const agg =
      typeAgg.get(slug) ??
      (() => {
        const a = {
          displayName: titleCase(slug),
          source,
          keys: new Set<string>(),
          count: 0,
        };
        typeAgg.set(slug, a);
        return a;
      })();
    agg.count++;
    for (const k of Object.keys(metadata)) {
      if (k !== "title" && k !== "type") agg.keys.add(k);
    }
  });

  const references: ProposedReference[] = [];
  let unresolved = 0;
  items.forEach((item, i) => {
    const sourceTempId = `t${i + 1}`;
    for (const link of item.links) {
      const targetTempId = tempIdByName.get(link.targetName.toLowerCase());
      const resolved = Boolean(targetTempId);
      if (!resolved) unresolved++;
      references.push({
        sourceTempId,
        ...(targetTempId ? { targetTempId } : {}),
        targetName: link.targetName,
        relationType,
        resolved,
      });
    }
  });

  const types: ProposedType[] = [...typeAgg.entries()].map(([slug, a]) => ({
    slug,
    displayName: a.displayName,
    source: a.source,
    metadataKeys: [...a.keys].sort(),
    itemCount: a.count,
  }));

  return {
    types,
    items: proposedItems,
    references,
    stats: {
      itemCount: items.length,
      typeCount: types.length,
      referenceCount: references.length,
      unresolvedReferences: unresolved,
    },
  };
}
