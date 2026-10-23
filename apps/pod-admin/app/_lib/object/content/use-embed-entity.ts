"use client";

import { trpc } from "../../../../lib/trpc";
import { entityEmbedRead, type EmbedEntityRead } from "./markdown-model";

/**
 * An embedded record, read through `entities.get` — the viewer's own floor,
 * the same door `/open/entity/:id` reads. A record this person cannot see
 * comes back `hidden` and its title is never shown.
 */
export function useEmbedEntity(id: string): EmbedEntityRead {
  const query = trpc.entities.get.useQuery({ id }, { retry: false });
  return entityEmbedRead({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
    retry: () => void query.refetch(),
  });
}
