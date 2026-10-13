"use client";

/**
 * The one client read of `/api/pod-updates`, shared by the Updates page and
 * Home's Needs-you row so both ask with the same query key (one request, one
 * answer). A failed read is an error with its HTTP status — a 404 is an older
 * pod without the endpoint, never "no updates".
 */

import { useQuery } from "@tanstack/react-query";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { parsePodUpdates, type PodUpdatesView } from "./updates-model";

export const POD_UPDATES_KEY = ["pod-updates"] as const;

export class PodUpdatesError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The view from a response, or the pod's own sentence as an error. */
export async function readPodUpdatesResponse(
  res: Response
): Promise<PodUpdatesView> {
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 401) {
    redirectToLoginIfUnauthorized({ data: { code: "UNAUTHORIZED" } });
  }
  if (!res.ok) {
    const error =
      body && typeof body === "object"
        ? (body as { error?: unknown }).error
        : undefined;
    throw new PodUpdatesError(
      typeof error === "string" ? error : `Error (${res.status})`,
      res.status
    );
  }
  const view = parsePodUpdates(body);
  if (!view) {
    throw new PodUpdatesError("The pod sent an answer we can't read.", 502);
  }
  return view;
}

export function usePodUpdates({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: POD_UPDATES_KEY,
    queryFn: async () =>
      readPodUpdatesResponse(
        await fetch("/api/pod-updates", { cache: "no-store" })
      ),
    enabled,
    staleTime: 60_000,
    // A 404 (older pod) or 403 will not heal by asking again.
    retry: (count, err) =>
      count < 1 && !(err instanceof PodUpdatesError && err.status < 500),
  });
}
