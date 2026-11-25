/**
 * What a connected file reads as. The graph wire sends a file neighbour as an
 * id and a name only, so its mime and document come from `entities.get`.
 * (That read omits `includeProfile`: a file kind's own media declaration is
 * ignored for thumbnails.)
 */

import type {
  ConnectionGroup,
  ConnectionItem,
} from "@synap-core/types/connections";
import type { MediaRef } from "@synap-core/types/presentation";
import { entityPageMedia } from "../../open/open-model";
import { isHtmlPageMime } from "./content/document-model";

export interface FileRead {
  entity?: {
    id?: string;
    documentId?: string | null;
    properties?: Record<string, unknown> | null;
    systemData?: unknown;
  };
}

export type NeighbourMedia =
  | { kind: "image"; media: MediaRef }
  | { kind: "page"; documentId: string }
  | { kind: "plain" };

export function neighbourMedia(id: string, read: FileRead): NeighbourMedia {
  const entity = read.entity;
  if (!entity) return { kind: "plain" };
  const props = entity.properties ?? {};
  const declared =
    typeof props.mimeType === "string" ? props.mimeType.trim() : "";
  const documentId = entity.documentId?.trim() || null;
  if (documentId && isHtmlPageMime(declared)) {
    return { kind: "page", documentId };
  }
  const { media } = entityPageMedia({ ...entity, id }, undefined);
  const mime = declared || (media?.via === "stored" ? (media.mime ?? "") : "");
  if (media && /^image\//i.test(mime)) return { kind: "image", media };
  return { kind: "plain" };
}

/** Objects drawn per group before "Show all". */
export const GROUP_CAP = 6;

/** What a group draws: everything when expanded, else its first GROUP_CAP. */
export function visibleItems(
  group: Pick<ConnectionGroup, "items">,
  { expanded }: { expanded: boolean }
): ConnectionItem[] {
  return expanded ? group.items : group.items.slice(0, GROUP_CAP);
}

/**
 * What every COLLAPSED group draws, minus hidden objects: the set previews are
 * read from, so expanding a group never changes which are read.
 */
export function collapsedItems(
  groups: readonly Pick<ConnectionGroup, "items">[],
  hiddenIds: ReadonlySet<string>
): ConnectionItem[] {
  return groups
    .flatMap((g) => visibleItems(g, { expanded: false }))
    .filter((i) => !hiddenIds.has(i.id));
}
