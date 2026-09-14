/**
 * THE ONE READER between a stored profile row and the human-facing
 * `description` / `icon` every listing door (discover's summary + full tiers,
 * the MCP `synap_list_profiles` digest, the REST `/profiles` digest, and
 * orient's profile sample) advertises.
 *
 * ── Why this file exists (measured live, 2026-09-14) ────────────────────────
 * `profiles` has NO `description` or `icon` column (`@synap/database`
 * `schema/profiles.ts`) — both live inside `uiHints` jsonb (`{ icon, color,
 * description }`). Every door that built its wire shape from
 * `p.description ?? null` / `p.icon ?? null` was reading a key that has never
 * existed on a `Profile` row, so it always emitted `null` regardless of what
 * the profile actually carries. Measured on the live pod: `GET
 * /api/hub/discover` returned `description: null, icon: null` for all 118
 * rows, while 118/118 carry `uiHints.description` and 115/118 carry
 * `uiHints.icon`. Same class of bug `property-presentation.ts`
 * (`@synap/database`) fixed for property defs — a door reading a key nothing
 * writes.
 */

import { PROFILE_ORIGINS, type ProfileOrigin } from "@synap/database/schema";

interface HintBag {
  [key: string]: unknown;
}

/** A profile row as read back from the database (or a tRPC projection of one). */
export interface StoredProfilePresentation {
  uiHints?: unknown;
}

function asBag(value: unknown): HintBag | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as HintBag)
    : undefined;
}

function asTrimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** This profile's human-facing description: `uiHints.description`, or `null`. */
export function resolveProfileDescription(
  profile: StoredProfilePresentation
): string | null {
  return asTrimmedStringOrNull(asBag(profile.uiHints)?.description);
}

/** This profile's icon key: `uiHints.icon`, or `null`. */
export function resolveProfileIcon(
  profile: StoredProfilePresentation
): string | null {
  return asTrimmedStringOrNull(asBag(profile.uiHints)?.icon);
}

// ── Origin ───────────────────────────────────────────────────────────────────

/**
 * A profile's provenance, plus the group discover lists it under.
 *
 * `origin` is THE stored vocabulary — `profiles.origin` / `PROFILE_ORIGINS`
 * (migration 0263), never a copy. Only a stored `unknown` (the column default)
 * or an absent value falls back to scope, and only to what scope proves:
 * `system` ⇒ `core`. Nothing is inferred from a template install.
 *
 * `group` is presentation placement: `core`, `shared`, the owning `workspace`,
 * or `unknown` (a user-scoped row, a workspace row with no workspace id).
 */
export type ProfileOriginGroup = "core" | "shared" | "workspace" | "unknown";

export interface ResolvedProfileOrigin {
  origin: ProfileOrigin;
  group: ProfileOriginGroup;
  workspaceId?: string;
  templateId?: string;
  packageSlug?: string;
}

export interface StoredProfileOriginSource {
  scope?: string | null;
  workspaceId?: string | null;
  origin?: string | null;
}

/** What the caller knows about a workspace's install provenance. */
export interface WorkspaceInstallSource {
  templateId?: string | null;
  packageSlug?: string | null;
}

const isStoredOrigin = (value: unknown): value is ProfileOrigin =>
  typeof value === "string" &&
  (PROFILE_ORIGINS as readonly string[]).includes(value);

export function resolveProfileOrigin(
  profile: StoredProfileOriginSource,
  workspaceInstall?: (workspaceId: string) => WorkspaceInstallSource | undefined
): ResolvedProfileOrigin {
  const stored = isStoredOrigin(profile.origin) ? profile.origin : "unknown";
  const origin: ProfileOrigin =
    stored !== "unknown"
      ? stored
      : profile.scope === "system"
        ? "core"
        : "unknown";

  if (origin === "core" || profile.scope === "system") {
    return { origin, group: "core" };
  }
  if (profile.scope === "shared") return { origin, group: "shared" };

  const workspaceId =
    profile.scope === "workspace"
      ? asTrimmedStringOrNull(profile.workspaceId)
      : null;
  if (!workspaceId) return { origin, group: "unknown" };

  const out: ResolvedProfileOrigin = {
    origin,
    group: "workspace",
    workspaceId,
  };
  const install = workspaceInstall?.(workspaceId);
  const templateId = asTrimmedStringOrNull(install?.templateId);
  const packageSlug = asTrimmedStringOrNull(install?.packageSlug);
  if (templateId) out.templateId = templateId;
  if (packageSlug) out.packageSlug = packageSlug;
  return out;
}
