/**
 * LENS SCOPE — where a lens page is looking: `lens(scope)`.
 *
 * Founder rule (2026-10-04): Home, a project, a track and a session are the
 * SAME page through a different lens. The scope is the only parameter, and it
 * changes exactly three things — which empty sections OMIT, the header's ONE
 * scope fact, and which source doors disappear ({@link visibleSource}).
 *
 * The scope travels in the ADDRESS ({@link encodeLensScope}), never by writing
 * the viewer's global project lens. Every kind is encoded by the ONE address
 * door (`encodeActivityScope`), so a Show-all door and a heat cell can never
 * spell one scope two ways.
 */

import {
  encodeActivityScope,
  parseActivityScope,
  type ActivityScope,
} from "../activity/heat.js";
import { isUuid } from "../property-render/structured-value.js";

export const LENS_SCOPE_KINDS = [
  "pod",
  "workspace",
  "project",
  "track",
  "session",
  "pipeline",
] as const;
export type LensScopeKind = (typeof LENS_SCOPE_KINDS)[number];

/**
 * A track and a session know their containers when the page knows them —
 * that is what lets {@link visibleSource} hide a source the scope sits INSIDE
 * (the session's own project on a session page). Absent ⇒ unknown, which only
 * ever SHOWS a source (a redundant door is cheaper than a missing one).
 */
export type LensScope =
  | { kind: "pod" }
  | {
      kind: "workspace";
      workspaceId: string;
      /**
       * The project FILTERING this space (BRIEF-lens-model: inside a space the
       * selected project is a filter — "this space × this project"). The read
       * ANDs it onto the workspace (`signals.list` composes the two). Absent ⇒
       * the whole space. Not in the address token: a Show-all door carries
       * the space; the project rides on the surface lens.
       */
      projectId?: string | null;
    }
  | { kind: "project"; projectId: string }
  | { kind: "track"; trackId: string; projectId?: string | null }
  | {
      kind: "session";
      sessionId: string;
      trackId?: string | null;
      projectId?: string | null;
    }
  /**
   * An INTENT surface — one kind's (or role's) things: "Posts", "Leads"
   * (surfaces plan). The kind is the scope; a container (a space, a project,
   * a track) narrows it, and it travels in the address with it (an intent
   * surface's "All sessions →" stays the project's posts).
   */
  | {
      kind: "pipeline";
      profileSlug: string;
      workspaceId?: string | null;
      projectId?: string | null;
      trackId?: string | null;
    };

/** The scope's own object, or null for the whole pod. */
export function lensScopeObject(
  scope: LensScope
): { kind: Exclude<LensScopeKind, "pod">; id: string } | null {
  switch (scope.kind) {
    case "pod":
      return null;
    case "workspace":
      return { kind: "workspace", id: scope.workspaceId };
    case "project":
      return { kind: "project", id: scope.projectId };
    case "track":
      return { kind: "track", id: scope.trackId };
    case "session":
      return { kind: "session", id: scope.sessionId };
    case "pipeline":
      return { kind: "pipeline", id: scope.profileSlug };
  }
}

/** The containers the scope sits INSIDE (never itself), as `kind:id` keys. */
function ancestorKeys(scope: LensScope): Set<string> {
  const keys = new Set<string>();
  if (
    (scope.kind === "track" || scope.kind === "workspace") &&
    scope.projectId
  ) {
    keys.add(`project:${scope.projectId}`);
  }
  if (scope.kind === "session" || scope.kind === "pipeline") {
    if (scope.trackId) keys.add(`track:${scope.trackId}`);
    if (scope.projectId) keys.add(`project:${scope.projectId}`);
  }
  if (scope.kind === "pipeline" && scope.workspaceId) {
    keys.add(`workspace:${scope.workspaceId}`);
  }
  return keys;
}

/**
 * WHERE a row came from — the small provenance door ("from <session>").
 * `kind` is an object-nav kind, so the door opens through the host's route
 * table like any other object.
 */
export interface LensSource {
  kind: "workspace" | "project" | "track" | "session";
  id: string;
  /** Short display name. */
  label: string;
}

/**
 * The source a row shows AT THIS SCOPE, or null.
 *
 * Hidden when it adds nothing the page does not already say:
 *   - it IS the scope (a session's row on that session's page);
 *   - the scope sits INSIDE it (the project, on one of its sessions' pages).
 *
 * Shown when it is MORE specific than the scope (which session, on a project
 * page) or unrelated to it (any source, on Home). The pod scope therefore
 * shows every source — Home is where provenance is most useful.
 */
export function visibleSource(
  row: { source: LensSource | null },
  scope: LensScope
): LensSource | null {
  const source = row.source;
  if (!source) return null;
  const own = lensScopeObject(scope);
  if (own && own.kind === source.kind && own.id === source.id) return null;
  if (ancestorKeys(scope).has(`${source.kind}:${source.id}`)) return null;
  return source;
}

/**
 * The scope as ONE address token: `pod`, `workspace:<id>`, `project:<id>`,
 * `track:<id>`, `session:<id>` — spelled by THE address door
 * (`encodeActivityScope`), so Work reads a lens page's "Show all" and a heat
 * cell with one reader. Containers do not travel — the page re-reads them
 * from the object.
 */
export function encodeLensScope(scope: LensScope): string {
  if (scope.kind === "pipeline") {
    // `pipeline:<slug>`, `@<container token>` when a container narrows it —
    // the narrowest one (track ⊂ project ⊂ space), spelled by the activity
    // door like every other container.
    const container: ActivityScope | null = scope.trackId
      ? { kind: "track", trackId: scope.trackId }
      : scope.projectId
        ? { kind: "project", projectId: scope.projectId }
        : scope.workspaceId
          ? { kind: "workspace", workspaceId: scope.workspaceId }
          : null;
    const base = `${PIPELINE_TOKEN}${scope.profileSlug}`;
    return container ? `${base}@${encodeActivityScope(container)}` : base;
  }
  if (scope.kind === "track")
    return encodeActivityScope({ kind: "track", trackId: scope.trackId });
  if (scope.kind === "session") {
    return encodeActivityScope({ kind: "session", sessionId: scope.sessionId });
  }
  return encodeActivityScope(scope);
}

/** Read an address token back. Anything else ⇒ `undefined` (no override). */
export function parseLensScope(token: unknown): LensScope | undefined {
  if (typeof token === "string" && token.startsWith(PIPELINE_TOKEN)) {
    const rest = token.slice(PIPELINE_TOKEN.length);
    const at = rest.indexOf("@");
    const profileSlug = at < 0 ? rest : rest.slice(0, at);
    if (!profileSlug) return undefined;
    if (at < 0) return { kind: "pipeline", profileSlug };
    const container = parseActivityScope(rest.slice(at + 1));
    if (!container) return undefined;
    switch (container.kind) {
      case "track":
        return { kind: "pipeline", profileSlug, trackId: container.trackId };
      case "project":
        return {
          kind: "pipeline",
          profileSlug,
          projectId: container.projectId,
        };
      case "workspace":
        return {
          kind: "pipeline",
          profileSlug,
          workspaceId: container.workspaceId,
        };
      default:
        return undefined;
    }
  }
  return parseActivityScope(token);
}

const PIPELINE_TOKEN = "pipeline:";

/**
 * The scope as the ACTIVITY door reads it (heat, Data › Landed): a pipeline
 * has no activity of its own kind — it reads its container's (the narrowest
 * one), else the whole pod. Every other kind is already an activity scope.
 */
export function lensActivityScope(scope: LensScope): ActivityScope {
  switch (scope.kind) {
    case "pod":
      return { kind: "pod" };
    case "workspace":
      return { kind: "workspace", workspaceId: scope.workspaceId };
    case "project":
      return { kind: "project", projectId: scope.projectId };
    case "track":
      return { kind: "track", trackId: scope.trackId };
    case "session":
      return { kind: "session", sessionId: scope.sessionId };
    case "pipeline":
      if (scope.trackId) return { kind: "track", trackId: scope.trackId };
      if (scope.projectId)
        return { kind: "project", projectId: scope.projectId };
      if (scope.workspaceId)
        return { kind: "workspace", workspaceId: scope.workspaceId };
      return { kind: "pod" };
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/** The fields each scope kind carries, as {@link readLensScope} reads them. */
const LENS_SCOPE_FIELDS: Record<
  LensScopeKind,
  { required: readonly string[]; optional: readonly string[] }
> = {
  pod: { required: [], optional: [] },
  workspace: { required: ["workspaceId"], optional: ["projectId"] },
  project: { required: ["projectId"], optional: [] },
  track: { required: ["trackId"], optional: ["projectId"] },
  session: {
    required: ["sessionId"],
    optional: ["trackId", "projectId"],
  },
  pipeline: {
    required: ["profileSlug"],
    optional: ["workspaceId", "projectId", "trackId"],
  },
};

/** What {@link readLensScope} answers: the scope, or the one reason it is not one. */
export type LensScopeRead =
  { ok: true; scope: LensScope } | { ok: false; reason: string };

/**
 * Read a STORED or SENT scope object (`documents.scope`, a write's input) back
 * as a {@link LensScope} — the object twin of {@link parseLensScope}, which
 * reads the address token. Strict: an unknown kind, a missing id, an id that is
 * not a UUID or an unknown field is refused with the reason, never repaired, so
 * a stored scope always reads back exactly as it was written. Containers left
 * out stay out; a `null` container is dropped (same meaning: unknown).
 */
export function readLensScope(value: unknown): LensScopeRead {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "a scope is an object with a `kind`" };
  }
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (
    typeof kind !== "string" ||
    !(LENS_SCOPE_KINDS as readonly string[]).includes(kind)
  ) {
    return {
      ok: false,
      reason: `\`kind\` is one of ${LENS_SCOPE_KINDS.join(", ")}`,
    };
  }
  const { required, optional } = LENS_SCOPE_FIELDS[kind as LensScopeKind];
  const out: Record<string, string> = { kind };
  for (const key of Object.keys(v)) {
    if (key === "kind") continue;
    if (!required.includes(key) && !optional.includes(key)) {
      return { ok: false, reason: `a ${kind} scope has no \`${key}\`` };
    }
  }
  for (const key of [...required, ...optional]) {
    const raw = v[key];
    if (raw === undefined || raw === null) {
      if (required.includes(key)) {
        return { ok: false, reason: `a ${kind} scope needs \`${key}\`` };
      }
      continue;
    }
    const valid =
      typeof raw === "string" &&
      (key === "profileSlug" ? SLUG_RE.test(raw) : isUuid(raw));
    if (!valid) {
      return {
        ok: false,
        reason:
          key === "profileSlug"
            ? "`profileSlug` is a kind's slug"
            : `\`${key}\` is a UUID`,
      };
    }
    out[key] = raw as string;
  }
  return { ok: true, scope: out as unknown as LensScope };
}

/**
 * The ids a scope NAMES (itself and every container it carries), by kind —
 * what a door checks the writer can read before it stores the scope.
 */
export function lensScopeIds(scope: LensScope): {
  workspaceIds: string[];
  projectIds: string[];
  trackIds: string[];
  sessionIds: string[];
} {
  const s = scope as Partial<
    Record<"workspaceId" | "projectId" | "trackId" | "sessionId", string | null>
  >;
  const one = (id: string | null | undefined) => (id ? [id] : []);
  return {
    workspaceIds: one(s.workspaceId),
    projectIds: one(s.projectId),
    trackIds: one(s.trackId),
    sessionIds: one(s.sessionId),
  };
}
