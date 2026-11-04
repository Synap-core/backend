"use client";

import { trpc } from "../../../../lib/trpc";
import { isUuid } from "../../../../lib/format";
import { objectRefRead, type ObjectRefRead } from "./markdown-model";

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";
const FIVE_MINUTES = 5 * 60_000;

/**
 * What a reference in prose names, read through `diagnose.resolveOpen` — the
 * one user-floored "what is this id" the open pages and the desktop use — and
 * its kind's icon and colour from the one cached `profiles.list`. A
 * non-uuid id is asked nothing: it names no object.
 */
export function useObjectRef(id: string): ObjectRefRead {
  const lookup = isUuid(id);
  const resolved = trpc.diagnose.resolveOpen.useQuery(
    { id: lookup ? id : PLACEHOLDER_UUID },
    { enabled: lookup, retry: false, staleTime: FIVE_MINUTES }
  );
  const slug = resolved.data?.profileSlug;
  const profiles = trpc.profiles.list.useQuery(undefined, {
    enabled: Boolean(slug),
    retry: false,
    staleTime: FIVE_MINUTES,
  });
  if (!lookup) return { state: "unknown" };
  const row = slug
    ? profiles.data?.profiles.find((p) => p.slug === slug)
    : undefined;
  return objectRefRead({
    isLoading: resolved.isLoading,
    error: resolved.error,
    data: resolved.data,
    profile: row
      ? {
          slug: row.slug,
          label: row.displayName ?? undefined,
          uiHints: row.uiHints as {
            icon?: string | null;
            color?: string | null;
          } | null,
          profileKind: row.profileKind,
        }
      : null,
    retry: () => void resolved.refetch(),
  });
}
