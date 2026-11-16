/**
 * Graph health: THE one rule that finds a gap between what an object SAYS and
 * what it is LINKED to, so every surface invites the missing link instead of
 * forking the check. Pure, no I/O, NO WORDS: it returns codes, hosts own the copy.
 *
 *   1. `prose-id-unlinked`: a full uuid in a text, not `selfId`, not in `linkedIds`.
 *   2. `prose-prefix-unresolved`: an 8-hex prefix + ellipsis (`887fa1ec…`).
 *   3. `media-source-empty`: a kind declares a media source and none yields
 *      (`declaredSourceYields`, the resolver's own reading), with no file
 *      neighbour. `hasOwnDocument` / `hasFileNeighbour` stand for the
 *      resolver's steps (c) own image/video document and (d) pod-held copies.
 *
 * Deliberate: an id inside a URL, a code fence or `urn:uuid:` is still flagged
 * (an id written in prose is not an edge); `[[...]]` markers and `object://<id>`
 * are skipped, they already render as doors; `textProperties` is a whitelist,
 * scanning every property would flag id-bearing fields (`asset-document-id`).
 */

import {
  declaredMediaSources,
  type ProfilePresentation,
} from "../presentation/index.js";
import { declaredSourceYields } from "../presentation/resolve-media.js";

export type GraphHealthCode =
  "prose-id-unlinked" | "prose-prefix-unresolved" | "media-source-empty";

export interface GraphHealthFinding {
  code: GraphHealthCode;
  /** The full id, or the truncated prefix, as written (lowercase). */
  value?: string;
  /** The property it was found in, or the empty declared media slot. */
  property?: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A uuid standing on its own: not inside a longer hex/word token. */
const UUID_RE = new RegExp(`(?<![0-9a-z])${UUID}(?![0-9a-z])`, "gi");
/** 8 hex + ellipsis, not the tail of a longer token. */
const PREFIX_RE = /(?<![0-9a-z-])[0-9a-f]{8}(?=…|\.\.\.)/gi;
/** Deliberate references that already render as doors. */
const OBJECT_REF_RE = new RegExp(`object://${UUID}`, "gi");

/** Blank every `[[...]]` span. Linear: an unterminated `[[` ends the search. */
function stripMarkers(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("[[", from);
    if (open < 0) break;
    const close = text.indexOf("]]", open + 2);
    if (close < 0) break;
    out += `${text.slice(from, open)} `;
    from = close + 2;
  }
  return out + text.slice(from);
}

function stripReferences(text: string): string {
  return stripMarkers(text).replace(OBJECT_REF_RE, " ");
}

function findUnlinkedReferences(input: {
  selfId: string;
  texts: readonly { property: string; text: string }[];
  linkedIds: Iterable<string>;
}): GraphHealthFinding[] {
  const known = new Set<string>([input.selfId.toLowerCase()]);
  for (const id of input.linkedIds) known.add(id.trim().toLowerCase());

  const ids: GraphHealthFinding[] = [];
  const prefixes: GraphHealthFinding[] = [];
  const seenIds = new Set<string>();
  const seenPrefixes = new Set<string>();

  for (const { property, text } of input.texts) {
    const prose = stripReferences(text);
    for (const m of prose.matchAll(UUID_RE)) {
      const id = m[0].toLowerCase();
      if (known.has(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push({ code: "prose-id-unlinked", value: id, property });
    }
    for (const m of prose.matchAll(PREFIX_RE)) {
      const prefix = m[0].toLowerCase();
      if (seenPrefixes.has(prefix)) continue;
      seenPrefixes.add(prefix);
      prefixes.push({
        code: "prose-prefix-unresolved",
        value: prefix,
        property,
      });
    }
  }
  return [...ids, ...prefixes];
}

function findEmptyMediaSource(input: {
  presentation?: ProfilePresentation | null;
  properties: Record<string, unknown> | null | undefined;
  hasOwnDocument: boolean;
  hasFileNeighbour: boolean;
}): GraphHealthFinding | null {
  const sources = declaredMediaSources(input.presentation);
  if (sources.length === 0) return null;
  if (input.hasFileNeighbour) return null;
  const props = input.properties ?? {};

  for (const source of sources) {
    if (
      declaredSourceYields(source, props, { documentId: input.hasOwnDocument })
    )
      return null;
  }

  const primary = sources[0];
  const property =
    "property" in primary
      ? primary.property
      : "entityRef" in primary
        ? primary.entityRef
        : undefined;
  return { code: "media-source-empty", property };
}

export function graphHealth(input: {
  selfId: string;
  presentation?: ProfilePresentation | null;
  properties: Record<string, unknown> | null | undefined;
  hasOwnDocument: boolean;
  linkedIds: Iterable<string>;
  hasFileNeighbour: boolean;
  textProperties: readonly string[];
}): GraphHealthFinding[] {
  const out: GraphHealthFinding[] = [];
  const media = findEmptyMediaSource(input);
  if (media) out.push(media);
  const props = input.properties ?? {};
  const texts = input.textProperties.flatMap((property) => {
    const text = props[property];
    return typeof text === "string" ? [{ property, text }] : [];
  });
  out.push(
    ...findUnlinkedReferences({
      selfId: input.selfId,
      texts,
      linkedIds: input.linkedIds,
    })
  );
  return out;
}
