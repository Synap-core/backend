"use client";

/**
 * Which renderer draws an object in pod admin: the ONE resolution
 * (`resolveObjectRenderer`, `@synap-core/types/renderer-resolution`), fed
 * with what only this host knows.
 *
 *   installed      the pod's frame cells (`renderers.status`)
 *   effective      the kind's bindings (`profiles.getEffectiveRenderers`),
 *                  for an entity slot; a view reads none
 *   localFallback  the installed bundle's DEFAULT for the slot or view type,
 *                  when that cell is installed; else nothing. Pod admin has
 *                  no built-in renderer of its own: when nothing resolves,
 *                  the page draws its identity card.
 *
 * Pod admin never re-derives the precedence: `resolveForPodAdmin` is the
 * adapter the hook calls, and its test runs every `RENDERER_RESOLUTION_CASES`
 * case through it.
 *
 * States: loading · failed (the status read failed: never "nothing to
 * draw") · resolved (a cell, or nothing, each with `readFailed` when the
 * bindings read failed).
 *
 * A pod with no frame cell that could draw the subject (a self-hosted pod
 * with no bundle, a view type no installed cell declares) resolves to
 * nothing as soon as the status answers: the bindings are not read, and
 * the page draws its own content with no skeleton.
 */

import {
  resolveObjectRenderer,
  type EffectiveRenderersRead,
  type InstalledRenderer,
  type RendererCellRef,
  type RendererResolution,
  type RendererResolutionCaseInput,
  type RendererSubject,
} from "@synap-core/types/renderer-resolution";
import { trpc } from "../../../../lib/trpc";

/** `renderers.status`, as pod admin reads it. */
export interface RenderersStatus {
  bundle: {
    slug: string;
    version: string;
    setSha256: string;
    reactVersion: string;
  } | null;
  /**
   * The bundle's defaults, by the bundle's cell KEY (`board`); the cell is
   * `cell:<bundle.slug>:<key>` (`bundleCellKey`). `{}` with no bundle.
   */
  defaults: {
    "entity-card"?: string;
    "entity-detail"?: string;
    views?: Record<string, string>;
  };
  installed: readonly InstalledRenderer[];
}

const isStr = (v: unknown): v is string => typeof v === "string";

function readInstalled(row: unknown): InstalledRenderer | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!isStr(r.key) || (r.runtime !== "frame" && r.runtime !== "direct"))
    return null;
  return {
    key: r.key,
    runtime: r.runtime,
    contentKind: isStr(r.contentKind) ? r.contentKind : null,
    viewTypes: Array.isArray(r.viewTypes) ? r.viewTypes.filter(isStr) : [],
  };
}

/**
 * The pod's answer, checked. Null when it is not a status at all: a broken
 * answer is a failed read, never "no bundle".
 */
export function readRenderersStatus(data: unknown): RenderersStatus | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.installed)) return null;
  const b = d.bundle as Record<string, unknown> | null | undefined;
  const bundle =
    b && isStr(b.slug) && isStr(b.setSha256)
      ? {
          slug: b.slug,
          version: isStr(b.version) ? b.version : "",
          setSha256: b.setSha256,
          reactVersion: isStr(b.reactVersion) ? b.reactVersion : "",
        }
      : null;
  const raw = (d.defaults ?? {}) as Record<string, unknown>;
  const views: Record<string, string> = {};
  if (raw.views && typeof raw.views === "object") {
    for (const [type, key] of Object.entries(
      raw.views as Record<string, unknown>
    )) {
      if (isStr(key)) views[type] = key;
    }
  }
  return {
    bundle,
    defaults: {
      ...(isStr(raw["entity-card"])
        ? { "entity-card": raw["entity-card"] }
        : {}),
      ...(isStr(raw["entity-detail"])
        ? { "entity-detail": raw["entity-detail"] }
        : {}),
      views,
    },
    installed: d.installed
      .map(readInstalled)
      .filter((r): r is InstalledRenderer => r !== null),
  };
}

/** A bundle cell's type key, from the bundle's slug and the cell's key. */
export function bundleCellKey(slug: string, key: string): string {
  return `cell:${slug}:${key}`;
}

/**
 * The host's fallback for a subject: the installed bundle's default cell for
 * its slot (or its view type), only when that cell is installed. Pod admin
 * has no built-in, so it is never "builtin".
 */
export function bundleFallback(
  status: RenderersStatus,
  subject: RendererSubject
): RendererCellRef | null {
  if (!status.bundle) return null;
  const name =
    subject.kind === "view"
      ? status.defaults.views?.[subject.viewType]
      : status.defaults[subject.slot];
  if (!name) return null;
  const key = bundleCellKey(status.bundle.slug, name);
  return status.installed.some((c) => c.key === key)
    ? { kind: "cell", cellKey: key, props: {} }
    : null;
}

/**
 * The adapter: this host's inputs → the one resolution. What the hook calls,
 * and what the delegation test runs every shared case through.
 */
export function resolveForPodAdmin(
  input: RendererResolutionCaseInput
): RendererResolution {
  return resolveObjectRenderer({
    subject: input.subject,
    effective: input.effective,
    installed: (key) => input.installed.find((c) => c.key === key),
    host: {
      selfKeys: input.selfKeys,
      localFallback: () => input.localFallback,
    },
  });
}

/**
 * Whether any installed cell could draw `subject` here: for a view, a frame
 * cell that declares its type (or the bundle's default for it); for an entity
 * slot, any frame cell (a binding or an override may name any of them).
 * False → nothing can resolve to a cell pod admin runs, so nothing is read
 * further and nothing waits.
 */
export function couldDrawHere(
  status: RenderersStatus,
  subject: RendererSubject
): boolean {
  const frames = status.installed.filter((c) => c.runtime === "frame");
  if (frames.length === 0) return false;
  if (subject.kind === "entity") return true;
  return (
    frames.some((c) => c.viewTypes.includes(subject.viewType)) ||
    bundleFallback(status, subject) !== null
  );
}

/** A read's state, as `useQuery` hands it. */
export interface ReadLike {
  isLoading: boolean;
  error: unknown;
  data: unknown;
}

export type ObjectRendererState =
  | { state: "loading" }
  | { state: "failed"; retry?: () => void }
  | {
      state: "resolved";
      resolution: RendererResolution;
      status: RenderersStatus;
      /** Re-read the bindings (a resolution with `readFailed`). */
      retry?: () => void;
    };

/**
 * The reads → what to draw. The status read failing (or answering something
 * that is not a status) is FAILED; the bindings read failing still resolves,
 * marked `readFailed` by the resolution itself.
 */
export function objectRendererState(input: {
  subject: RendererSubject;
  status: ReadLike;
  /** Only for an entity slot; a view reads no bindings. */
  effective?: ReadLike;
  retry?: () => void;
}): ObjectRendererState {
  const failed: ObjectRendererState = {
    state: "failed",
    ...(input.retry ? { retry: input.retry } : {}),
  };
  if (input.status.error) return failed;
  if (input.status.isLoading) return { state: "loading" };
  const status = readRenderersStatus(input.status.data);
  if (!status) return failed;
  if (!couldDrawHere(status, input.subject)) {
    return {
      state: "resolved",
      resolution: { kind: "none", readFailed: false },
      status,
      ...(input.retry ? { retry: input.retry } : {}),
    };
  }
  let effective: EffectiveRenderersRead | undefined;
  if (input.subject.kind === "entity" && input.effective) {
    if (input.effective.error) effective = { state: "failed" };
    else if (input.effective.isLoading) return { state: "loading" };
    else effective = { state: "ok", result: input.effective.data };
  }
  const resolution = resolveForPodAdmin({
    subject: input.subject,
    effective,
    installed: status.installed,
    localFallback: bundleFallback(status, input.subject),
  });
  return {
    state: "resolved",
    resolution,
    status,
    ...(input.retry ? { retry: input.retry } : {}),
  };
}

/** Which renderer draws `subject`, read on the viewer's own floor. */
export function useObjectRenderer(
  subject: RendererSubject,
  lens: { workspaceId: string | null }
): ObjectRendererState {
  const status = trpc.renderers.status.useQuery(undefined, { retry: false });
  const entity = subject.kind === "entity" ? subject : null;
  // The bindings are read only when a cell here could draw the entity.
  const parsed = readRenderersStatus(status.data);
  const worthReading =
    entity !== null && parsed !== null && couldDrawHere(parsed, subject);
  const effective = trpc.profiles.getEffectiveRenderers.useQuery(
    {
      profileSlug: entity?.profileSlug ?? "",
      contentKind: entity?.slot ?? "entity-detail",
      workspaceId: lens.workspaceId,
      ...(entity ? { subjectId: entity.entityId } : {}),
    },
    { enabled: worthReading, retry: false }
  );
  return objectRendererState({
    subject,
    status,
    ...(entity ? { effective } : {}),
    retry: () => {
      void status.refetch();
      if (entity) void effective.refetch();
    },
  });
}
