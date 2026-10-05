/**
 * Brand resolution — the ONE rule for "which brand applies?" (Content × Brand
 * C2, lens model 2026-10-05). Pure and dependency-free.
 *
 * A brand is resolved in TWO steps:
 *
 *   1. The brand SPACE — the pod's Brand Library workspace (`pickBrandWorkspace`).
 *      A Brand space is a DOMAIN, installed once; projects do not get their own.
 *      First hit wins: the given workspace when it IS a Brand Library, else the
 *      brand source it DECLARES; then a library playing the `brand` provider
 *      role; then the oldest library.
 *   2. The brand IDENTITY inside that space (`pickBrandIdentity`). Brands differ
 *      by PROJECT, not by space: "the brand for Architech" is the Brand space
 *      filtered to the Architech project.
 *        - project given → that project's brand identity (`project`); none ⇒
 *          `no-brand-for-project`, never another project's brand.
 *        - no project → the identity flagged `default-brand` (`default-flag`);
 *          else the ONLY identity in the space (`only-brand`); else
 *          `no-default-brand`.
 *      The kit's colors/fonts/assets/voice/rules are the brand rows of the SAME
 *      project as the chosen identity (an identity in no project ⇒ the rows in
 *      no project).
 *
 * WHO RUNS IT: only the pod (`resolveBrand` in synap-backend
 * `services/brand/brand-kit-service.ts`), because its inputs are not visible to
 * a client — the floor (`userVisibleWhere` also admits workspaces the caller
 * OWNS without a member row), the oldest-first order, and project membership
 * (`projectLensWhere`). Clients ask the pod through `trpc.brand.resolve`
 * (`useBrandWorkspace` in `@synap-core/hooks`) and the IS through
 * `GET /api/hub/brand/kit`, so ONE implementation literally runs. It lives here
 * so the rule and its constants have one home that every repo can read.
 */

/** The capability a Brand Library workspace advertises. */
export const BRAND_LIBRARY_CAPABILITY = "brand.library";
/** The source domain a workspace uses to declare / provide its brand. */
export const BRAND_SOURCE_DOMAIN = "brand";

/** How the brand IDENTITY was chosen. */
export type BrandResolvedVia = "project" | "default-flag" | "only-brand";

/** Why there is no brand — a TYPED absence, never a failed read. */
export type BrandAbsenceReason =
  "no-brand-space" | "no-brand-for-project" | "no-default-brand";

/**
 * The boolean `brand-identity` property that names the brand used when no
 * project is selected (`brand-library.yaml`).
 */
export const BRAND_DEFAULT_FLAG_PROPERTY = "default-brand";

export type BrandResolution =
  | {
      ok: true;
      /** The Brand space. */
      brandWorkspaceId: string;
      /** The chosen `brand-identity` entity. */
      brandIdentityId: string;
      /** The project whose brand this is; null = the brand in no project. */
      projectId: string | null;
      resolvedVia: BrandResolvedVia;
    }
  | {
      ok: false;
      reason: BrandAbsenceReason;
      /** A human sentence, safe to show a user or an agent as-is. */
      message: string;
      /** The Brand space when one exists (null for `no-brand-space`). */
      brandWorkspaceId: string | null;
      /** The project asked about, if any. */
      projectId: string | null;
    };

/** The settings slice the picker reads. */
export interface BrandCandidateWorkspace {
  id: string;
  settings: {
    workspaceCapabilities?: unknown;
    sourceRoles?: unknown;
    defaultSources?: unknown;
  } | null;
}

function isBrandProvider(w: BrandCandidateWorkspace): boolean {
  const caps = w.settings?.workspaceCapabilities;
  return Array.isArray(caps) && caps.includes(BRAND_LIBRARY_CAPABILITY);
}

function playsBrandProviderRole(w: BrandCandidateWorkspace): boolean {
  const roles = w.settings?.sourceRoles;
  if (!roles || typeof roles !== "object") return false;
  const role = (roles as Record<string, unknown>)[BRAND_SOURCE_DOMAIN];
  return role === "provider" || role === "provider-consumer";
}

function declaredBrandSource(w: BrandCandidateWorkspace): string | undefined {
  const sources = w.settings?.defaultSources;
  if (!sources || typeof sources !== "object") return undefined;
  const s = sources as Record<string, unknown>;
  for (const key of [BRAND_SOURCE_DOMAIN, BRAND_LIBRARY_CAPABILITY]) {
    const entry = s[key];
    if (entry && typeof entry === "object") {
      const id = (entry as { workspaceId?: unknown }).workspaceId;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

/** Providers playing the `brand` role first; otherwise the given order is kept. */
function preferRole(
  providers: BrandCandidateWorkspace[]
): BrandCandidateWorkspace | undefined {
  return providers.find(playsBrandProviderRole) ?? providers[0];
}

/**
 * PURE: the Brand SPACE over already-floored inputs, or null when no visible
 * workspace is a Brand Library.
 *
 * @param visible      every workspace the caller can see, oldest first.
 * @param workspaceId  the caller's active/given workspace, if any.
 */
export function pickBrandWorkspace(input: {
  visible: BrandCandidateWorkspace[];
  workspaceId?: string;
}): string | null {
  const byId = new Map(input.visible.map((w) => [w.id, w]));
  const providers = input.visible.filter(isBrandProvider);
  const providerIds = new Set(providers.map((w) => w.id));

  if (input.workspaceId) {
    const given = byId.get(input.workspaceId);
    if (given && providerIds.has(given.id)) return given.id;
    const declared = given ? declaredBrandSource(given) : undefined;
    if (declared && providerIds.has(declared)) return declared;
  }

  return preferRole(providers)?.id ?? null;
}

/** One brand row of the Brand space, with the projects it belongs to. */
export interface BrandSpaceRow {
  id: string;
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  /** The projects the row `belongs_to_project` (empty = in no project). */
  projectIds: readonly string[];
}

export type BrandIdentityPick =
  | {
      ok: true;
      brandIdentityId: string;
      projectId: string | null;
      resolvedVia: BrandResolvedVia;
      /** Exactly the rows the kit is built from: the identity + its project's rows. */
      kitRows: BrandSpaceRow[];
    }
  | {
      ok: false;
      reason: Exclude<BrandAbsenceReason, "no-brand-space">;
      message: string;
    };

export const BRAND_ABSENCE_MESSAGES: Record<BrandAbsenceReason, string> = {
  "no-brand-space":
    "There is no Brand space yet — install the Brand Library to give your work a brand.",
  "no-brand-for-project":
    "This project has no brand identity in your Brand space yet.",
  "no-default-brand":
    "Several brands live in your Brand space — pick a project, or mark one brand as the default.",
};

const NO_IDENTITY_MESSAGE = "Your Brand space has no brand identity yet.";

const IDENTITY_RANK: Record<string, number> = { active: 0, draft: 1 };

function identityStatus(row: BrandSpaceRow): string {
  const v = row.properties["brand-status"];
  return typeof v === "string" && v.trim() ? v.trim() : "active";
}

/**
 * PURE: the brand IDENTITY inside the Brand space, and the rows its kit is
 * built from (see the module header). Eligible identities are the
 * non-archived `brand-identity` rows, `active` before `draft`, then by id —
 * so the pick never depends on read order.
 */
export function pickBrandIdentity(input: {
  rows: readonly BrandSpaceRow[];
  projectId?: string;
}): BrandIdentityPick {
  const identities = input.rows
    .filter(
      (r) =>
        r.profileSlug === "brand-identity" && identityStatus(r) !== "archived"
    )
    .sort(
      (a, b) =>
        (IDENTITY_RANK[identityStatus(a)] ?? 2) -
          (IDENTITY_RANK[identityStatus(b)] ?? 2) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  const flagged = (r: BrandSpaceRow) => {
    const v = r.properties[BRAND_DEFAULT_FLAG_PROPERTY];
    return v === true || v === "true";
  };

  let identity: BrandSpaceRow | undefined;
  let projectId: string | null;
  let resolvedVia: BrandResolvedVia;

  if (input.projectId) {
    const inProject = identities.filter((r) =>
      r.projectIds.includes(input.projectId!)
    );
    identity = inProject.find(flagged) ?? inProject[0];
    if (!identity) {
      return {
        ok: false,
        reason: "no-brand-for-project",
        message: BRAND_ABSENCE_MESSAGES["no-brand-for-project"],
      };
    }
    projectId = input.projectId;
    resolvedVia = "project";
  } else {
    identity = identities.find(flagged);
    resolvedVia = "default-flag";
    if (!identity && identities.length === 1) {
      identity = identities[0];
      resolvedVia = "only-brand";
    }
    if (!identity) {
      return {
        ok: false,
        reason: "no-default-brand",
        message: identities.length
          ? BRAND_ABSENCE_MESSAGES["no-default-brand"]
          : NO_IDENTITY_MESSAGE,
      };
    }
    projectId = [...identity.projectIds].sort()[0] ?? null;
  }

  const chosen = identity;
  const kitRows = input.rows.filter((r) =>
    r.profileSlug === "brand-identity"
      ? r === chosen
      : projectId
        ? r.projectIds.includes(projectId)
        : r.projectIds.length === 0
  );
  return {
    ok: true,
    brandIdentityId: chosen.id,
    projectId,
    resolvedVia,
    kitRows,
  };
}
