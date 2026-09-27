/**
 * STAGE SPACE — which space a track step's work lands in (concepts.md:
 * "Track owns no space: each step names its domain"). ONE rule, read by the
 * browser track page, the relay track page and the pod's own resolver
 * (`services/tracks/stage-domain.ts`).
 *
 * `stage.domain` is a space TEMPLATE slug, never a space id, so a method stays
 * portable across pods. A space's template identity is the promoted
 * `workspaces.package_slug` column, else the older `settings.packageSlug`
 * stamp (rows that predate the column carry only the stamp) — exactly the
 * pod's `coalesce(package_slug, settings->>'packageSlug')`.
 *
 * Precedence among spaces installed from the slug: one the project already
 * uses wins; else the first listed (the pod lists earliest-installed first).
 * The pod narrows its candidates further (visible, a domain home, writable)
 * before this pick; a reader applies the pick to what it can see.
 */
import { humanizeToken } from "../vocabulary/index.js";

/** The fields of a space row the identity read needs (structural). */
export interface SpaceIdentityRow {
  id: string;
  name?: string | null;
  /** The promoted column (`workspaces.package_slug`). */
  packageSlug?: unknown;
  /** The legacy stamp lives at `settings.packageSlug`. */
  settings?: unknown;
}

/**
 * The space's template slug: the column, else `settings.packageSlug`, else
 * null. Mirrors SQL `coalesce` — only an ABSENT column falls through.
 */
export function workspaceTemplateSlug(row: {
  packageSlug?: unknown;
  settings?: unknown;
}): string | null {
  if (typeof row.packageSlug === "string") return row.packageSlug;
  const settings = row.settings;
  if (settings && typeof settings === "object") {
    const stamp = (settings as Record<string, unknown>).packageSlug;
    if (typeof stamp === "string") return stamp;
  }
  return null;
}

/**
 * The precedence, alone: among candidate space ids (in listed order), one the
 * project already uses wins; else the first. `null` when there is none.
 */
export function pickStageSpace(
  candidateIds: readonly string[],
  usedSpaceIds: ReadonlySet<string>
): { id: string; alreadyUsed: boolean } | null {
  const used = candidateIds.find((id) => usedSpaceIds.has(id));
  if (used !== undefined) return { id: used, alreadyUsed: true };
  const first = candidateIds[0];
  return first === undefined ? null : { id: first, alreadyUsed: false };
}

export type StageSpace =
  /** An installed space the step's work lands in — a door. */
  | { kind: "space"; id: string; name: string }
  /** The step names a template no visible space was installed from. */
  | { kind: "missing"; label: string };

/**
 * A step's space for a reader. `null` OMITS the space: the step names no
 * domain, or the spaces list is not read (a failed or pending read never
 * claims "missing").
 */
export function resolveStageSpace(
  domain: string | null | undefined,
  spaces: readonly SpaceIdentityRow[] | null,
  usedSpaceIds: ReadonlySet<string> = new Set()
): StageSpace | null {
  const slug = domain?.trim();
  if (!slug) return null;
  if (spaces === null) return null;
  const installed = spaces.filter((s) => workspaceTemplateSlug(s) === slug);
  const pick = pickStageSpace(
    installed.map((s) => s.id),
    usedSpaceIds
  );
  if (!pick) return { kind: "missing", label: humanizeToken(slug) };
  const row = installed.find((s) => s.id === pick.id)!;
  return {
    kind: "space",
    id: row.id,
    name: row.name?.trim() || humanizeToken(slug),
  };
}
