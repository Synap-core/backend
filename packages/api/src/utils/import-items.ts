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

// ── Bridge to the materializer (capture.execute) ──────────────────────────────

// ── Bridge to a graph composite proposal (the governed unit-of-work) ──────────

/**
 * Minimal shape of a composite (graph) proposal's operations, matching
 * @synap-core/types CompositeProposalData. Re-declared here (not imported) to
 * keep this util free of cross-package type coupling; the shape is asserted by
 * a test against the real type.
 */
export interface CompositeEntityOp {
  op: "create_entity";
  profileSlug: string;
  title?: string;
  properties?: Record<string, unknown>;
  /** Long-form body → materialized as a linked document on approval. */
  content?: string;
  /** Stable in-proposal handle (we use the item's tempId). */
  ref?: string;
}
export interface CompositeRelationOp {
  op: "create_relation";
  type: string;
  /** op ref (tempId) of source/target, resolved to a real id at approval. */
  sourceRef: string;
  targetRef: string;
}
export type CompositeOp = CompositeEntityOp | CompositeRelationOp;

/**
 * Convert an ImportProposal into a single GRAPH composite proposal: N
 * create_entity ops (each tagged with its tempId as `ref`) + M create_relation
 * ops referencing those tempIds. Approving this ONE proposal materializes the
 * whole graph atomically (entities first, then relations via ref→realId).
 *
 * Unresolved references (targets outside the batch) are dropped — they have no
 * op to reference and can't be materialized as relations. Count is returned.
 */
export function importProposalToComposite(proposal: ImportProposal): {
  operations: CompositeOp[];
  droppedReferences: number;
} {
  const entityOps: CompositeEntityOp[] = proposal.items.map((it) => {
    // Pull the long-form body out of properties → the op's `content` field, so
    // approval materializes a LINKED DOCUMENT (versioned) instead of inlining
    // the whole note into a property. Remaining props (frontmatter, folder) stay.
    const { content, ...restProps } = it.properties as {
      content?: unknown;
    } & Record<string, unknown>;
    return {
      op: "create_entity" as const,
      profileSlug: it.typeSlug,
      title: it.title,
      properties: restProps,
      ...(typeof content === "string" && content ? { content } : {}),
      ref: it.tempId,
    };
  });
  const resolved = proposal.references.filter((r) => Boolean(r.targetTempId));
  const relationOps: CompositeRelationOp[] = resolved.map((r) => ({
    op: "create_relation",
    type: r.relationType,
    sourceRef: r.sourceTempId,
    targetRef: r.targetTempId as string,
  }));
  return {
    operations: [...entityOps, ...relationOps],
    droppedReferences: proposal.references.length - resolved.length,
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
 * System profiles that always exist on a pod (entityScope pod/workspace).
 * Only these are safe to assign as a type during a FAITHFUL import — assigning
 * an arbitrary slug (e.g. a folder name like "5-projects") fails profile
 * validation on create and the entity falls back to a bare note, DROPPING its
 * properties (incl. content). So import only ever types as a KNOWN profile.
 */
const KNOWN_IMPORT_PROFILES = new Set<string>([
  "note",
  "task",
  "project",
  "event",
  "person",
  "contact",
  "company",
  "bookmark",
  "article",
  "website",
  "decision",
  "question",
  "research",
]);

/**
 * Decide an item's type slug for a FAITHFUL import.
 *
 * Deliberately conservative: a folder is NOT a type. Real-world vaults organize
 * by PARA/numbered buckets ("1. Daily", "5. Projects"), which make terrible
 * entity types and pollute the schema. So:
 *   1. explicit typeHint, but ONLY if it maps to an allowed profile slug
 *   2. otherwise "note" (the honest default)
 * The folder is preserved separately as a `folder` property + label (see
 * buildImportProposal), so nothing is lost — and the AI restructure step
 * (Structure Steward) can later promote folders/notes into real types via its
 * own governed proposals. Import mirrors; it does not invent types.
 *
 * The allowed-slug set:
 *   - When `validSlugs` is provided, the typeHint is gated against the REAL
 *     workspace profile slugs. This is what the AI-structured import path uses:
 *     the structuring endpoint already validates returned slugs against the
 *     workspace's availableProfiles, so an AI-assigned slug present in validSlugs
 *     is safe to trust as a real, creatable profile.
 *   - When omitted, it falls back to the static KNOWN_IMPORT_PROFILES set
 *     (the conservative deterministic-only behavior). Back-compat preserved.
 */
function typeForItem(
  item: ImportItem,
  validSlugs?: Set<string>
): {
  slug: string;
  source: ProposedType["source"];
} {
  if (item.typeHint && item.typeHint.trim()) {
    const slug = toSlug(item.typeHint);
    const allowed = validSlugs ?? KNOWN_IMPORT_PROFILES;
    if (allowed.has(slug)) {
      return { slug, source: "type-hint" };
    }
  }
  return { slug: "note", source: "default" };
}

/**
 * Build a governed, source-agnostic structure proposal from import items.
 * Deterministic and pure: same input → same proposal, no LLM, no DB.
 *
 * @param items Normalized import items (produced by a source adapter).
 * @param relationType Relation type for links (default "references").
 * @param validSlugs Optional allow-list of REAL workspace profile slugs. When
 *   provided, item typeHints are gated against it (so AI-assigned types stick);
 *   when omitted, the conservative static KNOWN_IMPORT_PROFILES gate is used.
 */
export function buildImportProposal(
  items: ImportItem[],
  relationType = "references",
  validSlugs?: Set<string>
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
    const { slug, source } = typeForItem(item, validSlugs);
    const tempId = `t${i + 1}`;
    const metadata =
      item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    // The folder path is preserved as data (not as a type): a `folder` property
    // for filtering + a label so the AI restructure step can use it as a signal.
    const folder = item.path.join("/");
    const properties: Record<string, unknown> = {
      ...metadata,
      ...(folder ? { folder } : {}),
      ...(item.body ? { content: item.body } : {}),
    };
    const labels =
      folder && !item.labels.includes(folder)
        ? [...item.labels, folder]
        : item.labels;
    proposedItems.push({
      tempId,
      typeSlug: slug,
      title:
        (typeof metadata.title === "string" && metadata.title) || item.title,
      properties,
      sourceRef: [...item.path, item.title].join("/"),
      labels,
    });

    // Index by the filename basename AND (if different) the frontmatter title,
    // so links written either way resolve. extractWikilinks already reduces
    // link targets to the basename.
    const fileKey = item.title.toLowerCase();
    if (!tempIdByName.has(fileKey)) tempIdByName.set(fileKey, tempId);
    const fmTitle =
      typeof metadata.title === "string" ? metadata.title.toLowerCase() : "";
    if (fmTitle && fmTitle !== fileKey && !tempIdByName.has(fmTitle)) {
      tempIdByName.set(fmTitle, tempId);
    }

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
