"use client";

import { useQuery } from "@tanstack/react-query";
import { POD_URL } from "../../../lib/trpc";
import {
  freshFor,
  MediaSignError,
  parseSigned,
  signingPath,
  type SignedMedia,
  type SignState,
  type StoredMediaRef,
} from "./stored-media-model";

/**
 * One signing: the pod door at `podUrl + path`, with the reader's own Kratos
 * cookie. A refusal, an unreachable pod or an unusable answer THROWS a
 * `MediaSignError` — never an empty answer.
 */
export async function signStoredMedia(
  podUrl: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<SignedMedia> {
  let res: Response;
  try {
    res = await fetchImpl(`${podUrl}${path}`, { credentials: "include" });
  } catch {
    throw new MediaSignError(0);
  }
  if (!res.ok) throw new MediaSignError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MediaSignError(0);
  }
  return parseSigned(body);
}

/**
 * Sign one stored media reference for the person reading — the console's half
 * of the app's `useStoredFileUrl`. The pod's file doors read the Kratos cookie
 * (`credentials: "include"`, the same as every tRPC call this console makes to
 * `POD_URL`), so a reader gets exactly the bytes the pod would show them.
 *
 * One signing per blob per screen (the query cache is keyed by the path), and
 * it is re-signed shortly before the URL expires, so a page left open does not
 * turn into broken images. A refused or failed signing THROWS: the caller sees
 * `error`, never an empty answer it could mistake for "no image".
 */
export function useStoredMedia(
  ref: StoredMediaRef | null,
  {
    viaEntityId,
    enabled = true,
  }: { viaEntityId?: string | null; enabled?: boolean } = {}
): SignState & { refetch: () => void; podConfigured: boolean } {
  const path = ref ? signingPath(ref, viaEntityId) : null;
  const query = useQuery<SignedMedia>({
    queryKey: ["stored-media", POD_URL, path],
    enabled: enabled && Boolean(path && POD_URL),
    retry: false,
    queryFn: () => signStoredMedia(POD_URL, path!),
    staleTime: (q) => freshFor(q.state.data?.expiresAt),
    refetchInterval: (q) =>
      q.state.data ? freshFor(q.state.data.expiresAt) : false,
  });
  return {
    status: query.isError ? "error" : query.data ? "ready" : "loading",
    data: query.data,
    error: query.error,
    refetch: () => void query.refetch(),
    podConfigured: Boolean(POD_URL),
  };
}
