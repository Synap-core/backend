"use client";

import { trpc } from "../../../../lib/trpc";
import { isUuid } from "../../../../lib/format";
import {
  cellInstanceEmbedRead,
  type EmbedCellInstanceRead,
} from "./markdown-model";

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";
const FIVE_MINUTES = 5 * 60_000;

/**
 * A cell embed that names only an instance, read through
 * `cellInstances.get` — the viewer's own floor (members of a shared space
 * see its instances). An instance this person cannot see, or an id that is
 * not one, comes back `hidden`.
 */
export function useCellInstance(instanceId: string): EmbedCellInstanceRead {
  const lookup = isUuid(instanceId);
  const query = trpc.cellInstances.get.useQuery(
    { id: lookup ? instanceId : PLACEHOLDER_UUID },
    { enabled: lookup, retry: false, staleTime: FIVE_MINUTES }
  );
  if (!lookup) return { state: "hidden" };
  return cellInstanceEmbedRead({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
    retry: () => void query.refetch(),
  });
}
