/**
 * What a saved view shows, in one sentence, from what the view row itself
 * carries (its layout and its `config`). Pod admin does not draw views (it runs
 * the pod; the app is where work is done), so `/open/view` has to say what the
 * view IS: a generated view has no description, and an empty card teaches
 * nothing.
 *
 * It reads only what the pipeline and dashboard ops write: `config.profileSlug`
 * and a dashboard's `config.blocks[].config.profileSlug`. A view that names no
 * kind says so by leaving "of <kind>" out, never by guessing one.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import type { openT } from "../copy";

type T = ReturnType<typeof openT>;

export interface ViewShape {
  type?: string | null;
  config?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function slugOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function blocksOf(config: Record<string, unknown> | null): unknown[] {
  return Array.isArray(config?.blocks) ? (config.blocks as unknown[]) : [];
}

/** The kind a view is over: its own, else the first widget that names one. */
export function viewKind(config: unknown): string | null {
  const own = record(config);
  const direct = slugOf(own?.profileSlug);
  if (direct) return direct;
  for (const block of blocksOf(own)) {
    const slug = slugOf(record(record(block)?.config)?.profileSlug);
    if (slug) return slug;
  }
  return null;
}

/** How many widgets a dashboard holds. */
export function widgetCount(config: unknown): number {
  return blocksOf(record(config)).length;
}

export function describeView(view: ViewShape, t: T): string {
  const kind = viewKind(view.config);
  const noun = kind ? humanizeToken(kind) : null;
  const layout = view.type?.trim() || null;

  if (layout === "pipeline" && noun) {
    return t("view.shows.pipeline", { noun });
  }
  if (layout === "bento") {
    const n = widgetCount(view.config);
    return noun
      ? t("view.shows.dashboardOver", { n, noun })
      : t("view.shows.dashboard", { n });
  }
  if (layout) {
    const name = humanizeToken(layout);
    return noun
      ? t("view.shows.layoutOver", { layout: name, noun })
      : t("view.shows.layout", { layout: name });
  }
  return t("view.shows.unknown");
}
