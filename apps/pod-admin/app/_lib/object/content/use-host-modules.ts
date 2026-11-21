"use client";

/**
 * The host modules a module frame runs on (React, its DOM, the JSX runtimes,
 * the kit and the tokens), read from the pod's installed renderer bundle
 * (`renderers.hostModules`, decision c91d26dc). Pod admin never hands a frame
 * its OWN React: the set is one build, so the frame holds one React instance
 * whatever version the console runs.
 *
 * The set is megabytes, so it is read once per page life and kept in a
 * module-level cache keyed by its `setSha256`. Every later read sends that
 * sha (`knownSetSha256`) and the pod answers `notModified` while the set is
 * the same: a round trip, not a download.
 *
 * States, never folded into each other:
 *   loading  the read is in flight
 *   ready    the modules, from this answer or the cache it confirmed
 *   none     the pod has no renderer bundle (NOT_FOUND `NO_RENDERER_BUNDLE`)
 *   failed   any other failure, or an answer that is not a usable set: a
 *            failed read is never "none"
 */

import { useState } from "react";
import type { CellFrameHostModules } from "@synap-core/types/cell-bridge";
import { trpc } from "../../../../lib/trpc";

export interface HostModuleSet {
  setSha256: string;
  modules: CellFrameHostModules;
  kitExports: readonly string[];
}

export type HostModulesState =
  | { state: "loading" }
  | ({ state: "ready" } & HostModuleSet)
  | { state: "none" }
  | { state: "failed"; retry?: () => void };

/** The one set this page has read (module scope: shared by every frame). */
let cached: HostModuleSet | null = null;

/** The cached set, if any (tests and the read's `knownSetSha256`). */
export function cachedHostModules(): HostModuleSet | null {
  return cached;
}

/** Drop the cache (tests). */
export function forgetHostModules(): void {
  cached = null;
}

const REQUIRED = [
  "react",
  "reactDom",
  "reactDomClient",
  "jsxRuntime",
  "tokensCss",
] as const;
const OPTIONAL = ["jsxDevRuntime", "kit"] as const;

/** One module's source: a string, or `{ source }` (the stored row's shape). */
function sourceOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const source = (value as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return undefined;
}

/**
 * The pod's `modules` as the frame's host modules, or null when a required
 * one is missing: a set without React cannot draw anything, and is a broken
 * answer, not an empty one.
 */
export function hostModulesFromWire(
  modules: unknown
): CellFrameHostModules | null {
  if (!modules || typeof modules !== "object") return null;
  const wire = modules as Record<string, unknown>;
  const out: Partial<CellFrameHostModules> = {};
  for (const key of REQUIRED) {
    const source = sourceOf(wire[key]);
    if (!source) return null;
    out[key] = source;
  }
  for (const key of OPTIONAL) {
    const source = sourceOf(wire[key]);
    if (source) out[key] = source;
  }
  return out as CellFrameHostModules;
}

/** The read's own state, as `useQuery` hands it. */
export interface HostModulesQuery {
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null | undefined;
  data: unknown;
  retry?: () => void;
}

/**
 * The read's answer → the state a frame draws from. A full answer is
 * remembered (the cache); `notModified` is answered from the cache only when
 * it names the cached set.
 */
export function hostModulesState(query: HostModulesQuery): HostModulesState {
  const failed: HostModulesState = {
    state: "failed",
    ...(query.retry ? { retry: query.retry } : {}),
  };
  if (query.error) {
    return query.error.data?.code === "NOT_FOUND" ? { state: "none" } : failed;
  }
  if (query.isLoading) return { state: "loading" };
  const answer = query.data as
    | {
        notModified?: unknown;
        setSha256?: unknown;
        modules?: unknown;
        kitExports?: unknown;
      }
    | null
    | undefined;
  if (!answer || typeof answer.setSha256 !== "string") return failed;
  if (answer.notModified === true) {
    return cached && cached.setSha256 === answer.setSha256
      ? { state: "ready", ...cached }
      : failed;
  }
  const modules = hostModulesFromWire(answer.modules);
  if (!modules) return failed;
  const kitExports = Array.isArray(answer.kitExports)
    ? answer.kitExports.filter((k): k is string => typeof k === "string")
    : [];
  if (!cached || cached.setSha256 !== answer.setSha256) {
    cached = { setSha256: answer.setSha256, modules, kitExports };
  }
  return { state: "ready", ...cached };
}

/**
 * The installed set's host modules. `enabled: false` reads nothing (a cell
 * that needs no frame). The sha sent is the one cached when this frame
 * mounted, so the query's key stays the same for its life.
 */
export function useHostModules(enabled = true): HostModulesState {
  const [known] = useState(() => cached?.setSha256);
  const query = trpc.renderers.hostModules.useQuery(
    known ? { knownSetSha256: known } : {},
    { enabled, retry: false, staleTime: Infinity }
  );
  if (!enabled) return { state: "loading" };
  return hostModulesState({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
    retry: () => void query.refetch(),
  });
}
