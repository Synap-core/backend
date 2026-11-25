"use client";

/**
 * What a frame is about, and the brand it draws in (frame contract v3,
 * `@synap-core/types/cell-bridge` `SurfaceContext`), read once per frame
 * from the pod's one door (`surfaces.context`, `resolveSurfaceContext`).
 * Both of pod admin's frames read it here: a stored HTML page (`html-frame`)
 * and a module cell (`module-frame`, the renderer bundle's cells).
 *
 * Four states, never folded: no anchor (nothing to ask: the frame runs as
 * before, and `context()` answers that there is none), loading (the frame
 * waits, so it is built once with its brand), ready, and failed (the frame
 * still runs, in the console's own tokens, and `context()` answers the
 * error: a failed read is never an empty context).
 */

import type { SurfaceContext } from "@synap-core/types/cell-bridge";
import { useMemo } from "react";
import { trpc } from "../../../../lib/trpc";

/** The object a frame is anchored to. */
export interface FrameAnchor {
  kind: "entity" | "document" | "view";
  id: string;
}

export type FrameContextState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; context: SurfaceContext }
  | { state: "failed"; error: string };

/** The anchor a module frame draws, from what it is: an entity, else a view. */
export function moduleFrameAnchor(identity: {
  entityId?: string;
  viewId?: string;
}): FrameAnchor | null {
  if (identity.entityId) return { kind: "entity", id: identity.entityId };
  if (identity.viewId) return { kind: "view", id: identity.viewId };
  return null;
}

/** The brand CSS a frame writes after the console's tokens, when it has one. */
export function frameBrandCss(state: FrameContextState): string | null {
  return state.state === "ready" ? (state.context.brand?.css ?? null) : null;
}

/**
 * The host's answer to `synap:context`: the context, or the read's error.
 * Undefined when the frame has no anchor (the bridge says there is none).
 */
export function frameContextAnswer(
  state: FrameContextState
): (() => Promise<SurfaceContext>) | undefined {
  if (state.state === "ready") return async () => state.context;
  if (state.state === "failed") {
    const error = state.error;
    return async () => {
      throw new Error(error);
    };
  }
  return undefined;
}

export function useFrameContext(
  anchor: FrameAnchor | null | undefined,
  theme: "light" | "dark",
  locale?: string
): FrameContextState {
  const query = trpc.surfaces.context.useQuery(
    {
      kind: anchor?.kind ?? "entity",
      id: anchor?.id ?? "",
      theme,
      ...(locale ? { locale } : {}),
    },
    {
      enabled: !!anchor,
      // A brand changes rarely; a frame re-asks only on a new anchor or theme.
      staleTime: 5 * 60_000,
      retry: 1,
    }
  );
  const has = !!anchor;
  const failed = query.isError
    ? query.error?.message || "The frame's context could not be read."
    : null;
  const data = query.data as SurfaceContext | undefined;
  // One object per answer: a host keys its frame's bridge on it.
  return useMemo((): FrameContextState => {
    if (!has) return { state: "none" };
    if (failed !== null) return { state: "failed", error: failed };
    if (!data) return { state: "loading" };
    return { state: "ready", context: data };
  }, [has, failed, data]);
}
