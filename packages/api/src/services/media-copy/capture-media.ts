/**
 * Keep the image a capture reader found (a page's og:image, an oEmbed
 * thumbnail) on the entity the capture proposes — so the media-copy job can
 * copy it into the pod once the entity exists. Until now the reader returned
 * `imageUrl` to the client and nothing persisted it.
 *
 * Only for a kind whose profile DECLARES a presentation with a property media
 * source (profiles without one are untouched), and only on the proposed entity
 * that IS the captured page (a property equals the source URL), or the single
 * entity when the plan has just one. The URL goes into the declared property
 * when that is empty; otherwise it is appended to `media-urls`, never
 * overwriting a value the plan already carries.
 */

import type { ProfilePresentation } from "@synap-core/types/presentation";
import { CAPTURED_MEDIA_URLS_PROPERTY } from "./media-plan.js";

export interface CaptureProposedEntity {
  profileSlug?: string;
  properties?: Record<string, unknown>;
}

export function foldCapturedImage<T extends CaptureProposedEntity>(
  entities: T[],
  read: { imageUrl: string | null; sourceUrl: string },
  presentationFor: (profileSlug: string) => ProfilePresentation | null
): T[] {
  const imageUrl = read.imageUrl;
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return entities;
  const isThePage = (e: T) =>
    Object.values(e.properties ?? {}).some((v) => v === read.sourceUrl);
  const targets = entities.length === 1 ? entities : entities.filter(isThePage);

  return entities.map((entity) => {
    if (!targets.includes(entity) || !entity.profileSlug) return entity;
    const source = presentationFor(entity.profileSlug)?.media?.source;
    if (!source || !("property" in source)) return entity;
    const props = { ...(entity.properties ?? {}) };
    const declared = props[source.property];
    if (declared === undefined || declared === null || declared === "") {
      props[source.property] = imageUrl;
    } else if (declared !== imageUrl) {
      const prior = props[CAPTURED_MEDIA_URLS_PROPERTY];
      const list = Array.isArray(prior)
        ? prior.filter((u): u is string => typeof u === "string")
        : [];
      if (!list.includes(imageUrl)) list.push(imageUrl);
      props[CAPTURED_MEDIA_URLS_PROPERTY] = list;
    } else {
      return entity;
    }
    return { ...entity, properties: props };
  });
}
