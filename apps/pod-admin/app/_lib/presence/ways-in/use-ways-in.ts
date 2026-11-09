"use client";

/**
 * The person's ways to confirm it's them, read once per page from
 * `presence.factors` (React Query shares the read between the count, the
 * top bar and Home), as the ONE derivation (`ways-in-model.ts`).
 */
import { trpc } from "../../../../lib/trpc";
import { waysIn, type WaysIn } from "./ways-in-model";

export function useWaysIn(): { state: WaysIn; retry: () => void } {
  const read = trpc.presence.factors.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  return { state: waysIn(read), retry: () => void read.refetch() };
}
