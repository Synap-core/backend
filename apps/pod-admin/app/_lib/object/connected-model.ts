/**
 * What an object is connected to, grouped by how it reads. `relations.getRelated`
 * returns the neighbouring entities; the page draws each the way its kind and
 * type read best: an image as a thumbnail, a stored HTML file as its page in the
 * frame, anything else as a door to its own page. Pure: no pod, no React.
 */

import { isHtmlPageMime } from "./content/document-model";

/** The slice of a related entity this model reads. */
export interface ConnectedEntity {
  id?: string | null;
  title?: string | null;
  type?: string | null;
  profileSlug?: string | null;
  documentId?: string | null;
  deletedAt?: Date | string | null;
  properties?: Record<string, unknown> | null;
}

export interface ConnectedItem {
  id: string;
  title: string | null;
  kind: string;
  documentId: string | null;
  mime: string | null;
}

export interface ConnectedGroups {
  /** A stored image (`image/*`): drawn as a thumbnail. */
  images: ConnectedItem[];
  /** A stored HTML file: its page runs in the frame. */
  pages: ConnectedItem[];
  /** Everything else: a door to its page. */
  others: ConnectedItem[];
}

function mimeOf(entity: ConnectedEntity): string | null {
  const mime = entity.properties?.mimeType;
  return typeof mime === "string" && mime.trim() ? mime.trim() : null;
}

/**
 * Group the neighbours of `selfId`. The object itself, a deleted neighbour, a
 * neighbour with no id and a repeat (an edge both ways) never appear. Order is
 * the pod's (newest edge first) within each group.
 */
export function connectedGroups(
  related: readonly ConnectedEntity[],
  selfId: string
): ConnectedGroups {
  const groups: ConnectedGroups = { images: [], pages: [], others: [] };
  const seen = new Set<string>([selfId]);
  for (const entity of related) {
    const id = entity.id;
    if (!id || seen.has(id) || entity.deletedAt) continue;
    seen.add(id);
    const mime = mimeOf(entity);
    const documentId = entity.documentId?.trim() || null;
    const item: ConnectedItem = {
      id,
      title: entity.title?.trim() || null,
      kind: entity.profileSlug?.trim() || entity.type?.trim() || "entity",
      documentId,
      mime,
    };
    if (documentId && mime && /^image\//i.test(mime)) groups.images.push(item);
    else if (documentId && isHtmlPageMime(mime)) groups.pages.push(item);
    else groups.others.push(item);
  }
  return groups;
}

/** Whether there is anything to draw. */
export function hasConnected(groups: ConnectedGroups): boolean {
  return groups.images.length + groups.pages.length + groups.others.length > 0;
}
