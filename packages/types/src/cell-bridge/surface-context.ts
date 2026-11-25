/**
 * What a frame is ABOUT, and the brand it draws in (frame contract v3).
 *
 * Every frame that runs stored code (a stored HTML page, a module cell, a
 * renderer bundle cell) sits on something: an entity, a project, a session.
 * The host knows that anchor, the space and project it belongs to, the goal
 * a session serves, and the project's brand; the frame asks for them with one
 * call:
 *
 *   window.synap.context() → Promise<SurfaceContext>
 *
 * which posts `synap:context` and resolves with the matching
 * `synap:context:result` (`sdk.ts`). A module frame also receives the same
 * fields in its `synap:init` context (`CellFrameInitContext`,
 * `surfaceContextInitFields`).
 *
 * The brand is CSS: Synap's own `--synap-*` names at the brand's values, built
 * by the pod from its ONE brand door (`resolveBrand` + the `synap-css` token
 * projection) with `brandFrameCss`, and written AFTER the host's tokens
 * (`frameTokensWithBrand`), so a name the brand does not set keeps the
 * host's value. No brand (no project, or a project with no token set) is
 * `brand: null`, never a failure.
 *
 * Pure, like the rest of this leaf: no DOM, no fetch.
 */

/**
 * The object a frame is anchored to. Structurally the same as
 * `@synap-core/types/surfaces` `SurfaceAnchor` (kind: entity, profile,
 * workspace, project, track, playbook, session); a host that renders a
 * document or a view with no other anchor names that body itself
 * (`document`, `view`).
 */
export interface SurfaceContextAnchor {
  kind: string;
  id: string;
}

/** The project's brand, as CSS the host writes after its own tokens. */
export interface SurfaceContextBrand {
  /** The brand identity's id (the record the brand door chose). */
  id: string;
  /** The brand token set's hash: a new one means new values. */
  hash: string;
  /** `--synap-*` declarations at the brand's values (`brandFrameCss`). */
  css: string;
}

/** Everything a frame may know about where it is (frame contract v3). */
export interface SurfaceContext {
  anchor: SurfaceContextAnchor | null;
  workspaceId: string | null;
  projectId: string | null;
  /** The goal (track) the anchor serves, when it serves one. */
  goalId: string | null;
  /** The host's filters on what the frame shows (a bound view's), JSON only. */
  filters: Record<string, unknown>;
  brand: SurfaceContextBrand | null;
  /** The language the host speaks (`@synap-core/types/i18n` `Locale`). */
  locale: string;
  theme: "light" | "dark";
}

/** The fields of {@link SurfaceContext}, in order: what the contract version pins. */
export const SURFACE_CONTEXT_FIELDS = [
  "anchor",
  "workspaceId",
  "projectId",
  "goalId",
  "filters",
  "brand",
  "locale",
  "theme",
] as const satisfies ReadonlyArray<keyof SurfaceContext>;

/** Frame → host: "where am I?" (`window.synap.context()`). */
export const FRAME_CONTEXT_TYPE = "synap:context";
/** Host → frame: the answer, with the same `id`. */
export const FRAME_CONTEXT_RESULT_TYPE = "synap:context:result";

/** What a frame reads when its host gives no context. */
export const FRAME_NO_CONTEXT = "This frame has no context here.";

/** The largest brand CSS a context carries (a token set is a few KB). */
export const SURFACE_CONTEXT_MAX_BRAND_CHARS = 64_000;
/** The largest filters a context carries, as JSON. */
export const SURFACE_CONTEXT_MAX_FILTERS_CHARS = 8_000;

const MAX_ID = 200;
const NAME = /^--synap-[a-z0-9-]+$/;
/** A value that could leave its declaration (or its element) is dropped. */
const UNSAFE_VALUE = /[;{}<>\n\r\\]/;

const shortString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * A context as plain, bounded data, or null when it is not one. A host reads
 * the pod's answer through this before handing it to a frame, so a frame
 * never receives more than the contract's fields.
 */
export function parseSurfaceContext(data: unknown): SurfaceContext | null {
  if (!isPlainRecord(data)) return null;
  const nullableId = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : shortString(v) ? v : undefined;

  let anchor: SurfaceContextAnchor | null = null;
  if (data.anchor !== null && data.anchor !== undefined) {
    if (
      !isPlainRecord(data.anchor) ||
      !shortString(data.anchor.kind) ||
      !shortString(data.anchor.id)
    )
      return null;
    anchor = { kind: data.anchor.kind, id: data.anchor.id };
  }
  const workspaceId = nullableId(data.workspaceId);
  const projectId = nullableId(data.projectId);
  const goalId = nullableId(data.goalId);
  if (workspaceId === undefined || projectId === undefined) return null;
  if (goalId === undefined) return null;

  let filters: Record<string, unknown> = {};
  if (data.filters !== undefined && data.filters !== null) {
    if (!isPlainRecord(data.filters)) return null;
    let json: string;
    try {
      json = JSON.stringify(data.filters);
    } catch {
      return null;
    }
    if (json.length > SURFACE_CONTEXT_MAX_FILTERS_CHARS) return null;
    filters = JSON.parse(json) as Record<string, unknown>;
  }

  let brand: SurfaceContextBrand | null = null;
  if (data.brand !== null && data.brand !== undefined) {
    const b = data.brand;
    if (
      !isPlainRecord(b) ||
      !shortString(b.id) ||
      typeof b.hash !== "string" ||
      b.hash.length > MAX_ID ||
      typeof b.css !== "string" ||
      b.css.length > SURFACE_CONTEXT_MAX_BRAND_CHARS
    )
      return null;
    brand = { id: b.id, hash: b.hash, css: b.css };
  }

  const theme = data.theme === "light" ? "light" : "dark";
  const locale =
    typeof data.locale === "string" &&
    /^[a-z]{2}(-[A-Za-z]{2})?$/.test(data.locale)
      ? data.locale
      : "en";
  return {
    anchor,
    workspaceId,
    projectId,
    goalId,
    filters,
    brand,
    locale,
    theme,
  };
}

/** The `--synap-*` declarations the brand door projects (`format=synap-css`). */
export interface BrandFrameDeclarations {
  /** Both modes. */
  vars: Record<string, string>;
  /** Light mode only. */
  light: Record<string, string>;
  /** Dark mode only. */
  dark: Record<string, string>;
}

function declarationList(record: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (!NAME.test(name) || typeof value !== "string") continue;
    const v = value.trim();
    if (!v || UNSAFE_VALUE.test(v)) continue;
    out.push(`${name}:${v}`);
  }
  return out;
}

/**
 * A brand's declarations as the CSS a frame wears, written after the host's
 * tokens (`frameTokensWithBrand`):
 *
 *   :root{vars, and the `theme` mode's values}
 *   :root[data-theme="light"]{light}
 *   :root[data-theme="dark"]{dark}
 *
 * A frame whose root carries the mode marker (a module frame, which flips it
 * on `synap:theme`) takes the marked mode's values; a page frame, which has
 * no marker, takes `theme`'s. Each rule is at least as specific as the token
 * layer's and comes after it, so the brand's value wins where it sets one and
 * Synap's stays everywhere else. Only `--synap-*` names, and no value that
 * could leave its declaration. Empty when the brand sets nothing.
 */
export function brandFrameCss(
  declarations: BrandFrameDeclarations,
  theme: "light" | "dark"
): string {
  const vars = declarationList(declarations.vars ?? {});
  const light = declarationList(declarations.light ?? {});
  const dark = declarationList(declarations.dark ?? {});
  const rules: string[] = [];
  const root = [...vars, ...(theme === "light" ? light : dark)];
  if (root.length > 0) rules.push(`:root{${root.join(";")}}`);
  if (light.length > 0)
    rules.push(`:root[data-theme="light"]{${light.join(";")}}`);
  if (dark.length > 0)
    rules.push(`:root[data-theme="dark"]{${dark.join(";")}}`);
  return rules.join("\n");
}

/**
 * THE token CSS of a frame: the host's tokens, then the brand's (a project's
 * values for Synap's names). Every host builds a frame's tokens through this
 * one composer, from whichever host tokens it has (`frameTokensCss`, the
 * values the host computes; `@synap-core/design-tokens`
 * `buildFrameTokensCss`, the canonical layer plus the host's theme overlay).
 * Safe to inline into a `<style>`: a `</` cannot end the element.
 */
export function frameTokensWithBrand(
  hostTokens: string,
  brandCss?: string | null
): string {
  const host = hostTokens.replace(/<\//g, "<\\/");
  if (!brandCss || !brandCss.trim()) return host;
  const brand = brandCss.replace(/<\//g, "<\\/");
  return host ? `${host}\n${brand}` : brand;
}

/**
 * The context fields a module frame's `synap:init` carries beside its own
 * (`CellFrameInitContext`): the anchor, project, goal, filters and brand.
 */
export function surfaceContextInitFields(context: SurfaceContext): {
  anchor: SurfaceContextAnchor | null;
  projectId: string | null;
  goalId: string | null;
  filters: Record<string, unknown>;
  brand: SurfaceContextBrand | null;
} {
  return {
    anchor: context.anchor,
    projectId: context.projectId,
    goalId: context.goalId,
    filters: context.filters,
    brand: context.brand,
  };
}
