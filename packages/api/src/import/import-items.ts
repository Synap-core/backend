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

import { shouldMaterializeAsDocument } from "@synap-core/types/documents";

export interface ImportLink {
  /** Target item name as referenced by the source (without #anchor or |alias). */
  targetName: string;
  /** Optional display alias, when the source supports it. */
  alias?: string;
  /**
   * Relation type for THIS link (e.g. `works_at`). Absent ⇒ the batch-wide
   * relation type passed to `buildImportProposal` (default `references`).
   */
  relationType?: string;
  /**
   * Kind of the target (profile slug). When set, the link resolves only to an
   * item of that kind with that name — a person and a company sharing a name
   * never cross-link.
   */
  targetType?: string;
  /**
   * The target is a thing this import should bring into existence when the
   * batch does not already carry it (a CSV row naming its employer). See
   * `addLinkTargetItems` — ONE item per distinct (targetType, name).
   */
  createIfMissing?: boolean;
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
   * The item's own TAGS, normalised — set only by sources that have real tags
   * (markdown/obsidian: frontmatter `tags`/`tag` ∪ inline `#tags`). Lands on the
   * entity's global `tags` property. Distinct from `labels`, which also carries
   * structural signals (the folder) and, for bookmarks, export folders.
   * Absent ⇒ the item's `tags` property is left exactly as the metadata had it.
   */
  tags?: string[];
  /**
   * Caller-supplied type hint for this item, if the source knows it
   * (e.g. frontmatter `type`). Takes precedence over path-derived typing.
   */
  typeHint?: string;
  /**
   * Role facets (Kind + Facets) this item's entity wears, e.g. a person row of
   * a contacts table → `[{ profileSlug: "contact" }]`. Carried onto the
   * composite op's `facets`, attached when the entity materializes.
   */
  facets?: Array<{ profileSlug: string; properties?: Record<string, unknown> }>;
  /**
   * An entity already in the pod that this item IS: the op links it instead of
   * creating a second one (and relations to this item land on it).
   */
  existingEntityId?: string;
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
  /** Role facets carried from the item (see ImportItem.facets). */
  facets?: ImportItem["facets"];
  /** Existing pod entity this item links to (see ImportItem.existingEntityId). */
  existingEntityId?: string;
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
  /** Role facets attached once the entity materializes. */
  facets?: Array<{ profileSlug: string; properties?: Record<string, unknown> }>;
  /** Link this existing entity instead of creating one. */
  existingEntityId?: string;
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
    // Pull the body out of properties. LONG-FORM bodies → the op's `content`
    // field, so approval materializes a LINKED DOCUMENT (versioned) instead of
    // inlining the note into a property. SHORT bodies stay in properties.content
    // (no document overhead). Same heuristic the capture pipeline uses, so both
    // surfaces agree on what becomes a document. Remaining props stay untouched.
    const { content, ...restProps } = it.properties as {
      content?: unknown;
    } & Record<string, unknown>;
    const isLongForm =
      typeof content === "string" &&
      content.length > 0 &&
      shouldMaterializeAsDocument(content);
    const properties =
      typeof content === "string" && content.length > 0 && !isLongForm
        ? { ...restProps, content }
        : restProps;
    return {
      op: "create_entity" as const,
      profileSlug: it.typeSlug,
      title: it.title,
      properties,
      ...(isLongForm ? { content: content as string } : {}),
      ref: it.tempId,
      ...(it.facets && it.facets.length > 0 ? { facets: it.facets } : {}),
      ...(it.existingEntityId ? { existingEntityId: it.existingEntityId } : {}),
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

/** Cap for the metadata block sent to structuring (IS bulk `context` max 4000). */
const METADATA_BLOCK_MAX = 3500;

/**
 * An item's frontmatter/metadata as a fenced, labelled block for the IS
 * structure `context` field — so the model sees the note's header fields,
 * which the body alone never carries. `undefined` when there is no metadata.
 * Values are JSON-encoded per key (dates → ISO strings); truncated to stay
 * under the IS bulk route's `context` cap.
 */
export function importItemMetadataBlock(item: ImportItem): string | undefined {
  const metadata =
    item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const lines = Object.entries(metadata)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (lines.length === 0) return undefined;
  let yaml = lines.join("\n");
  if (yaml.length > METADATA_BLOCK_MAX) {
    yaml = `${yaml.slice(0, METADATA_BLOCK_MAX)}\n# …truncated`;
  }
  return `Frontmatter (the note's own header fields — prefer them when mapping properties):\n\`\`\`yaml\n${yaml}\n\`\`\``;
}

/** Same-name test for link targets: case- and whitespace-insensitive. */
export function normalizeLinkTargetName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function linkTargetKey(slug: string, name: string): string {
  return `${slug}|${normalizeLinkTargetName(name)}`;
}

/**
 * Bring every `createIfMissing` link target into the batch as its own item —
 * ONE per distinct (targetType, normalised name) across ALL items, so 40 rows
 * naming the same employer yield one company, not 40. A target the batch
 * already carries (same kind, same name) is not duplicated. New items are
 * appended in first-seen order and keep the first-seen spelling as title.
 * Pure; returns a new array.
 */
export function addLinkTargetItems(items: ImportItem[]): ImportItem[] {
  const present = new Set(
    items
      .filter((it) => it.typeHint)
      .map((it) => linkTargetKey(toSlug(it.typeHint as string), it.title))
  );
  const added: ImportItem[] = [];
  for (const item of items) {
    for (const link of item.links) {
      if (!link.createIfMissing || !link.targetType) continue;
      const name = link.targetName.trim().replace(/\s+/g, " ");
      if (!name) continue;
      const key = linkTargetKey(link.targetType, name);
      if (present.has(key)) continue;
      present.add(key);
      added.push({
        title: name.slice(0, 500),
        path: [],
        metadata: {},
        body: "",
        links: [],
        labels: [],
        typeHint: link.targetType,
      });
    }
  }
  return added.length > 0 ? [...items, ...added] : items;
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
  // "slug|normalised title" → tempId, for links that name their target's kind.
  const tempIdByTypedName = new Map<string, string>();
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
      // Normalised tags (frontmatter ∪ inline) replace the raw frontmatter
      // value, which may be a string or carry `#` prefixes.
      ...(item.tags && item.tags.length > 0 ? { tags: item.tags } : {}),
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
      ...(item.facets && item.facets.length > 0 ? { facets: item.facets } : {}),
      ...(item.existingEntityId
        ? { existingEntityId: item.existingEntityId }
        : {}),
    });
    const typedKey = linkTargetKey(slug, item.title);
    if (!tempIdByTypedName.has(typedKey)) {
      tempIdByTypedName.set(typedKey, tempId);
    }

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
      const targetTempId = link.targetType
        ? tempIdByTypedName.get(linkTargetKey(link.targetType, link.targetName))
        : tempIdByName.get(link.targetName.toLowerCase());
      const resolved = Boolean(targetTempId);
      if (!resolved) unresolved++;
      references.push({
        sourceTempId,
        ...(targetTempId ? { targetTempId } : {}),
        targetName: link.targetName,
        relationType: link.relationType ?? relationType,
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
