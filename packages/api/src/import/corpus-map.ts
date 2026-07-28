/**
 * Corpus map — Phase 0 of high-quality vault/folder import.
 *
 * Turns a list of file paths into:
 *   1. Folder intents (project, collection, chapter, journal, resource, area)
 *   2. Container create_entity ops (parents before children)
 *   3. parent_of edges between containers
 *   4. file → nearest container path (for linking leaf content later)
 *
 * Agnostic: no product/Company OS names. Heuristics are linguistic + structural
 * only. Backend never hardcodes a customer's workspace catalog.
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";

/** Soft taxonomy for folder intent — import + optional UI lens, not a hard ontology. */
export type CorpusIntent =
  | "project"
  | "collection"
  | "chapter"
  | "journal"
  | "resource"
  | "area"
  | "unknown";

export type CorpusFolderNode = {
  /** Normalized path with `/` separators, no leading/trailing slash */
  path: string;
  name: string;
  intent: CorpusIntent;
  parentPath: string | null;
  depth: number;
};

export type CorpusMap = {
  folders: CorpusFolderNode[];
  /** file path (as given) → nearest ancestor folder path that is a container */
  fileToContainerPath: Record<string, string>;
  /** intent counts for observability */
  intentCounts: Record<string, number>;
};

export type CorpusMapItem = {
  /**
   * Full path string, OR path segments (ImportItem.path is string[]).
   * Prefer pathSegments when both exist.
   */
  path?: string | string[];
  pathSegments?: string[];
  title?: string;
};

/** Build a single path string from item fields. */
export function itemPathString(it: CorpusMapItem): string {
  const segs =
    it.pathSegments && it.pathSegments.length > 0
      ? it.pathSegments
      : Array.isArray(it.path)
        ? it.path
        : null;
  if (segs && segs.length > 0) {
    const base = segs.join(SEP);
    if (it.title && !base.endsWith(it.title)) return `${base}${SEP}${it.title}`;
    return base;
  }
  if (typeof it.path === "string" && it.path.length > 0) {
    return normalizePath(it.path);
  }
  return normalizePath(it.title || "");
}

const SEP = "/";

function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function splitPath(p: string): string[] {
  const n = normalizePath(p);
  if (!n) return [];
  return n.split(SEP).filter(Boolean);
}

/**
 * Infer folder intent from name + optional parent intent.
 * Pure, deterministic, locale-light (EN/FR cues for common vault patterns).
 */
export function inferFolderIntent(
  name: string,
  parentIntent?: CorpusIntent | null
): CorpusIntent {
  const n = name.toLowerCase().trim();
  const stripped = n.replace(/^\d+[\.\-\)\s]+/, "").trim();

  if (
    /^(projects?|projets?)$/.test(stripped) ||
    /started projects|projets? (en )?cours|in[-_ ]?dev|freelance/.test(n)
  ) {
    return "area"; // container-of-projects
  }
  if (/daily|journal|journaux|diary|log$/.test(stripped)) return "journal";
  if (
    /ressource|resource|z_?ressource|library|biblioth|books?$|reading/.test(
      stripped
    )
  ) {
    return "resource";
  }
  if (/chapter|chapitre|^ch\.?\s*\d|^part\s*\d|^partie\s*\d/.test(stripped)) {
    return "chapter";
  }
  if (
    /reflexion|r[eé]flexion|research|recherche|2nd brain|second brain|brain|cheat|math|physic|econom|info$|mental|photo|writing|essai|essay|content$|posts?$/.test(
      stripped
    )
  ) {
    return "collection";
  }
  // Child of projects area or another project → treat as project instance
  if (parentIntent === "area" || parentIntent === "project") {
    if (parentIntent === "project" && /chapter|chapitre/.test(stripped)) {
      return "chapter";
    }
    // Named instance folders under Projects (WineSafe, Empire, …)
    if (stripped.length >= 2 && !/^(tmp|temp|misc|other|old)$/.test(stripped)) {
      return "project";
    }
  }
  // Book-like: parent resource/collection + chapter-ish already handled;
  // bare named folder under writings → project (series)
  if (parentIntent === "collection" || parentIntent === "resource") {
    if (/chapter|chapitre/.test(stripped)) return "chapter";
    return "project"; // series / book work
  }
  return "unknown";
}

/** Whether this intent should materialize as a container entity. */
export function isContainerIntent(intent: CorpusIntent): boolean {
  return (
    intent === "project" ||
    intent === "collection" ||
    intent === "chapter" ||
    intent === "journal" ||
    intent === "resource" ||
    intent === "area"
  );
}

/**
 * Build corpus map from file items. Folders are inferred from path prefixes.
 */
export function buildCorpusMap(items: CorpusMapItem[]): CorpusMap {
  const folderSet = new Map<string, string>(); // path → name
  for (const it of items) {
    const parts = splitPath(itemPathString(it));
    if (parts.length === 0) continue;
    // All ancestor folders of the file (exclude the file itself)
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join(SEP);
      folderSet.set(path, parts[i]);
    }
  }

  // Sort by depth so parents resolve first
  const paths = Array.from(folderSet.keys()).sort(
    (a, b) => splitPath(a).length - splitPath(b).length || a.localeCompare(b)
  );

  const intentByPath = new Map<string, CorpusIntent>();
  const folders: CorpusFolderNode[] = [];
  const intentCounts: Record<string, number> = {};

  for (const path of paths) {
    const name = folderSet.get(path) ?? path;
    const parts = splitPath(path);
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join(SEP) : null;
    const parentIntent = parentPath
      ? (intentByPath.get(parentPath) ?? null)
      : null;
    const intent = inferFolderIntent(name, parentIntent);
    intentByPath.set(path, intent);
    intentCounts[intent] = (intentCounts[intent] ?? 0) + 1;
    folders.push({
      path,
      name,
      intent,
      parentPath,
      depth: parts.length,
    });
  }

  // Nearest container ancestor for each file
  const fileToContainerPath: Record<string, string> = {};
  for (const it of items) {
    const raw = itemPathString(it);
    const parts = splitPath(raw);
    if (parts.length < 2) continue;
    // Walk up from parent folder
    for (let i = parts.length - 1; i >= 1; i--) {
      const folderPath = parts.slice(0, i).join(SEP);
      const intent = intentByPath.get(folderPath);
      if (intent && isContainerIntent(intent)) {
        fileToContainerPath[normalizePath(raw)] = folderPath;
        break;
      }
    }
  }

  return { folders, fileToContainerPath, intentCounts };
}

/**
 * Priority for structure order: containers before leaves; deeper projects
 * after their parent areas; journals/resources mid; unknown last among folders.
 */
export function containerPriority(intent: CorpusIntent): number {
  switch (intent) {
    case "area":
      return 10;
    case "project":
      return 20;
    case "resource":
      return 30;
    case "collection":
      return 40;
    case "journal":
      return 50;
    case "chapter":
      return 60;
    default:
      return 90;
  }
}

/**
 * Emit container create_entity ops + parent_of relations.
 * Parents always appear before children in the op list.
 */
export function corpusMapToOperations(
  map: CorpusMap,
  opts?: {
    /** Optional workspace pin for all containers */
    targetWorkspaceId?: string;
  }
): {
  operations: CompositeProposalOperation[];
  /** folder path → op ref */
  containerRefByPath: Record<string, string>;
} {
  const containers = map.folders
    .filter((f) => isContainerIntent(f.intent))
    .sort(
      (a, b) =>
        containerPriority(a.intent) - containerPriority(b.intent) ||
        a.depth - b.depth ||
        a.path.localeCompare(b.path)
    );

  const operations: CompositeProposalOperation[] = [];
  const containerRefByPath: Record<string, string> = {};
  let i = 0;

  for (const f of containers) {
    const ref = `c${i++}`;
    containerRefByPath[f.path] = ref;
    const op: Extract<CompositeProposalOperation, { op: "create_entity" }> = {
      op: "create_entity",
      ref,
      // notes are pod-wide by default; workspace pin optional via targetWorkspaceId
      profileSlug: "note",
      title: f.name,
      description: `Imported container (${f.intent}) from folder: ${f.path}`,
      properties: {
        corpusIntent: f.intent,
        corpusPath: f.path,
        isContainer: true,
      },
    };
    if (opts?.targetWorkspaceId) {
      op.targetWorkspaceId = opts.targetWorkspaceId;
    }
    operations.push(op);
  }

  // parent_of: parent → child (hierarchical)
  for (const f of containers) {
    if (!f.parentPath) continue;
    const parentRef = containerRefByPath[f.parentPath];
    const childRef = containerRefByPath[f.path];
    if (!parentRef || !childRef) continue;
    operations.push({
      op: "create_relation",
      type: "parent_of",
      sourceRef: parentRef,
      targetRef: childRef,
    });
  }

  return { operations, containerRefByPath };
}

/**
 * Order file items so files under container folders are processed after
 * we conceptually have parents (for linking). Sort by container priority then path.
 */
export function orderItemsByCorpusMap<T extends CorpusMapItem>(
  items: T[],
  map: CorpusMap
): T[] {
  const priorityOfFile = (it: T): number => {
    const key = normalizePath(itemPathString(it));
    const cPath = map.fileToContainerPath[key];
    if (!cPath) return 100;
    const folder = map.folders.find((f) => f.path === cPath);
    return folder ? containerPriority(folder.intent) + folder.depth : 100;
  };
  return [...items].sort(
    (a, b) =>
      priorityOfFile(a) - priorityOfFile(b) ||
      itemPathString(a).localeCompare(itemPathString(b))
  );
}

/**
 * After deep structure, link provenance note refs (srcN) to their container
 * via parent_of (container → content) so hierarchy is visible in the graph.
 */
export function linkProvenanceToContainers(
  operations: CompositeProposalOperation[],
  items: CorpusMapItem[],
  map: CorpusMap,
  containerRefByPath: Record<string, string>
): CompositeProposalOperation[] {
  const extra: CompositeProposalOperation[] = [];
  for (let i = 0; i < items.length; i++) {
    const key = normalizePath(itemPathString(items[i]));
    const cPath = map.fileToContainerPath[key];
    if (!cPath) continue;
    const cRef = containerRefByPath[cPath];
    if (!cRef) continue;
    const srcRef = `src${i}`;
    // Only link if provenance entity exists in ops
    const hasSrc = operations.some(
      (o) => o.op === "create_entity" && o.ref === srcRef
    );
    if (!hasSrc) continue;
    extra.push({
      op: "create_relation",
      type: "parent_of",
      sourceRef: cRef,
      targetRef: srcRef,
    });
  }
  return extra;
}
