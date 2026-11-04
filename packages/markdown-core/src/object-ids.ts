/**
 * A BARE OBJECT ID in prose reads as the object it names (founder, 2026-11-04).
 *
 * Documents name records with markers (`[[entity:<id>|Ana]]`), but people and
 * agents often write the id alone. A RENDERER runs `linkObjectIds` on the
 * parsed tree (or `remarkObjectIds`, after `synapRemarkPlugins`): each id in
 * prose becomes an UNLABELLED reference link to `object://<id>`, the shape
 * `resolvePatternMarkers` gives `[[entity:<id>]]` with a kind nobody wrote.
 * The surface's chip then asks the one kind-agnostic resolver
 * (`diagnose.resolveOpen` / `GET /api/hub/resolve/:id`) what it is, on the
 * reader's own floor, and draws its name with its kind's icon and colour. An
 * id the reader cannot see stays the text the author wrote: it may not be an
 * object at all.
 *
 * NOT in `synapRemarkPlugins`, on purpose: plain-text readers (search, recall,
 * summaries, what an agent reads) keep the id itself. An empty link would
 * delete it from their text.
 *
 * Never touched: code and inline code, a link's or an image's words, raw HTML,
 * math, a marker still in the text (native renders split markers at draw
 * time), and an id that is part of a path, an address or a longer token
 * (`/open/<id>`, `?id=<id>`, `<id>-v2`).
 */
import type { Root } from "mdast";
import { splitInlineMarkers } from "./markers.js";

/** The scheme of a reference whose kind the author did not write. */
export const OBJECT_REF_SCHEME = "object";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** An id standing on its own: not inside a path, a query, an address or a longer token. */
const OBJECT_ID_RE = new RegExp(`(?<![\\w/:.=#?&@-])${UUID}(?![\\w/-])`, "gi");

/** Containers whose words are never prose to rewrite. */
const SKIP: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "math",
  "inlineMath",
]);

export interface ObjectIdMatch {
  id: string;
  /** Where the id starts in the text. */
  index: number;
}

/**
 * Every object id written in this text, in order: THE rule a renderer links
 * and the `bare-id` diagnostic flags. Ids inside a `[[kind:id|label]]` marker
 * are the marker's, not prose, and are skipped.
 */
export function findObjectIds(text: string): ObjectIdMatch[] {
  const out: ObjectIdMatch[] = [];
  let offset = 0;
  for (const segment of splitInlineMarkers(text)) {
    if (segment.type === "text") {
      for (const m of segment.value.matchAll(OBJECT_ID_RE)) {
        out.push({ id: m[0], index: offset + (m.index ?? 0) });
      }
      offset += segment.value.length;
    } else {
      offset += segment.raw.length;
    }
  }
  return out;
}

/** The loose node shape the walk needs (mdast nodes, directives included). */
interface WalkNode {
  type: string;
  value?: unknown;
  children?: WalkNode[];
}

/** A text value split around its ids, or null when it holds none. */
function splitText(value: string): WalkNode[] | null {
  const ids = findObjectIds(value);
  if (ids.length === 0) return null;
  const out: WalkNode[] = [];
  let last = 0;
  for (const { id, index } of ids) {
    if (index > last)
      out.push({ type: "text", value: value.slice(last, index) });
    out.push({
      type: "link",
      url: `${OBJECT_REF_SCHEME}://${id}`,
      title: null,
      children: [],
    } as WalkNode);
    last = index + id.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: WalkNode): void {
  if (SKIP.has(node.type) || !Array.isArray(node.children)) return;
  let next: WalkNode[] | null = null;
  node.children.forEach((child, i) => {
    const parts =
      child.type === "text" && typeof child.value === "string"
        ? splitText(child.value)
        : null;
    if (parts) {
      next ??= node.children!.slice(0, i);
      next.push(...parts);
      return;
    }
    walk(child);
    next?.push(child);
  });
  if (next) node.children = next;
}

/**
 * A renderer's tree with every bare object id in prose made an unlabelled
 * `object://<id>` reference link. Mutates and returns `tree`.
 */
export function linkObjectIds<T extends Root>(tree: T): T {
  walk(tree as unknown as WalkNode);
  return tree;
}

/** `linkObjectIds` as a remark plugin, for hosts that own their processor. Append it AFTER `synapRemarkPlugins`. */
export function remarkObjectIds() {
  return (tree: Root) => {
    linkObjectIds(tree);
  };
}

// ─── How a reference reads (one rule for every surface) ──────────────────────

/**
 * A reference in prose: the kind its marker names, already mapped to an open
 * kind by the surface (`doc` → `document`), or `null` when the author wrote
 * only the id (`object://<id>`).
 */
export interface ReferenceTarget {
  markerKind: string | null;
  id: string;
}

/**
 * What the reader's own lookup says about a reference — `diagnose.resolveOpen`
 * (`GET /api/hub/resolve/:id`), the one user-floored "what is this id".
 * `unknown`: the lookup ran and nothing this reader can see has the id.
 * `failed`: the lookup broke; never folded into `unknown`. `unresolved`: this
 * surface looks nothing up.
 */
export type ReferenceRead =
  | { state: "unresolved" }
  | { state: "loading" }
  | {
      state: "ready";
      /** The open route label (`entity`, `document`, `session`…). */
      type: string;
      name: string | null;
      openable: boolean;
      /** The entity's kind, when it is one (`task`, `person`…). */
      profileSlug?: string;
    }
  | { state: "unknown" }
  | { state: "failed" };

/** The resolver's answer (`OpenTarget`) and the query around it → a read. */
export function referenceRead(query: {
  isLoading: boolean;
  error: unknown;
  data:
    | {
        type?: string | null;
        displayName?: string | null;
        openable?: boolean | null;
        profileSlug?: string | null;
      }
    | null
    | undefined;
}): ReferenceRead {
  if (query.error) return { state: "failed" };
  if (query.isLoading) return { state: "loading" };
  const type = query.data?.type?.trim();
  // An answer with no type is a broken answer, not "nothing here".
  if (!type) return { state: "failed" };
  if (type === "unknown") return { state: "unknown" };
  const profileSlug = query.data?.profileSlug?.trim() || undefined;
  return {
    state: "ready",
    type,
    name: query.data?.displayName?.trim() || null,
    openable: query.data?.openable === true,
    ...(profileSlug ? { profileSlug } : {}),
  };
}

/** How a reference is drawn; the surface adds the link, the icon and the retry. */
export type ReferenceView =
  | {
      kind: "text";
      text: string;
      /** The lookup broke: the words stay, with a mark to ask again. */
      failed: boolean;
    }
  | {
      kind: "chip";
      text: string;
      /** The kind the icon and colour come from (the entity's kind first). */
      identityKind: string;
      /** The kind and id the chip opens; null when it opens nothing. */
      opens: { kind: string; id: string } | null;
      /** The name is still being looked up. */
      pending: boolean;
      failed: boolean;
    };

/**
 * THE rule for drawing a reference, on every surface.
 *
 * A BARE id is a chip only once the lookup names it: until then, and when
 * nobody this reader can see has it, it stays the text the author wrote (it
 * may not be an object at all); a broken lookup keeps the text and marks it.
 * A MARKER is always a chip on its own kind's page: its label wins, else the
 * looked-up name, else its kind's noun (never empty, never the id). A
 * labelled marker reads right without the lookup, so it carries no mark.
 */
export function referenceView(
  target: ReferenceTarget,
  label: string,
  read: ReferenceRead,
  nounFor: (kind: string) => string
): ReferenceView {
  const ready = read.state === "ready" ? read : null;
  const failed = read.state === "failed";
  if (target.markerKind === null) {
    if (!ready) return { kind: "text", text: target.id, failed };
    const identityKind = ready.profileSlug ?? ready.type;
    return {
      kind: "chip",
      text: ready.name ?? nounFor(identityKind),
      identityKind,
      opens: ready.openable ? { kind: ready.type, id: target.id } : null,
      pending: false,
      failed: false,
    };
  }
  const identityKind = ready
    ? (ready.profileSlug ?? ready.type)
    : target.markerKind;
  const own = label.trim();
  return {
    kind: "chip",
    text: own || ready?.name || nounFor(identityKind),
    identityKind,
    opens: { kind: target.markerKind, id: target.id },
    pending: !own && read.state === "loading",
    failed: !own && failed,
  };
}
