"use client";

import { trpc } from "../../../../lib/trpc";
import { cellEmbedRead, type EmbedCellRead } from "./markdown-model";

/**
 * An embedded cell, read through `widgetDefinitions.get` — the viewer's own
 * floor (`scopedDb`, the same door the desktop opens a cell by key through).
 * A cell this person cannot see comes back `hidden`; its source is never
 * shown.
 */
export function useEmbedCell(cellKey: string): EmbedCellRead {
  const query = trpc.widgetDefinitions.get.useQuery(
    { typeKey: cellKey },
    { retry: false }
  );
  return cellEmbedRead({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
    retry: () => void query.refetch(),
  });
}
