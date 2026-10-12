"use client";

import { useEffect } from "react";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import type { TrpcErrorLike } from "../open-model";

/**
 * An expired cookie still passes the middleware's presence check, so every
 * read on `/open` re-auths the same way rather than reporting a load failure
 * the reader can't act on. Pass every query/mutation error the page holds.
 */
export function useReauthOnUnauthorized(...errors: TrpcErrorLike[]) {
  const first = errors.find((e) => e?.data?.code === "UNAUTHORIZED") ?? null;
  useEffect(() => {
    if (first) redirectToLoginIfUnauthorized(first);
  }, [first]);
}
