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
