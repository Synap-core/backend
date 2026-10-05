/**
 * Brand workspace resolution — the ONE rule for "which workspace is this
 * caller's brand?" (Content × Brand C2). Pure and dependency-free.
 *
 * Resolution order, first hit wins:
 *   1. `project`     — a Brand Library workspace the project USES, when a
 *                      project is given (providers playing the `brand` role
 *                      first, else the project's own order).
 *   2. `workspace`   — the given workspace, when it IS a Brand Library
 *                      provider; else the brand source it DECLARES
 *                      (`settings.defaultSources.brand` / `["brand.library"]`)
 *                      when that names a visible provider.
 *   3. `pod-default` — a visible provider playing the `brand` role, else the
 *                      oldest visible Brand Library workspace.
 *
 * WHO RUNS IT: only the pod (`resolveBrandWorkspace` in synap-backend
 * `services/brand/brand-kit-service.ts`), because two of its inputs are not
 * visible to a client — the floor (`userVisibleWhere` also admits workspaces
 * the caller OWNS without a member row, which `workspaces.list` omits) and the
 * oldest-first order (`createdAt, id`; `workspaces.list` is sorted by name).
 * Clients ask the pod through `trpc.brand.resolve` (`useBrandWorkspace` in
 * `@synap-core/hooks`) and the IS through `GET /api/hub/brand/kit`, so ONE
 * implementation literally runs. It lives here so the rule and its constants
 * have one home that every repo can read.
 */

/** The capability a Brand Library workspace advertises. */
export const BRAND_LIBRARY_CAPABILITY = "brand.library";
/** The source domain a workspace uses to declare / provide its brand. */
export const BRAND_SOURCE_DOMAIN = "brand";

export type BrandResolvedVia = "project" | "workspace" | "pod-default";

export type BrandResolution =
  | { ok: true; brandWorkspaceId: string; resolvedVia: BrandResolvedVia }
  | { ok: false; reason: "project_not_found" | "no_brand_workspace" };

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
 * PURE resolution over already-floored inputs.
 *
 * @param visible           every workspace the caller can see, oldest first.
 * @param projectUsedIds    the project's used workspace ids (order kept), or
 *                          undefined when no project was given.
 * @param workspaceId       the caller's active/given workspace, if any.
 */
export function pickBrandWorkspace(input: {
  visible: BrandCandidateWorkspace[];
  projectUsedIds?: readonly string[];
  workspaceId?: string;
}): Extract<BrandResolution, { ok: true }> | null {
  const byId = new Map(input.visible.map((w) => [w.id, w]));
  const providers = input.visible.filter(isBrandProvider);
  const providerIds = new Set(providers.map((w) => w.id));

  if (input.projectUsedIds?.length) {
    const used = input.projectUsedIds
      .filter((id) => providerIds.has(id))
      .map((id) => byId.get(id)!);
    const hit = preferRole(used);
    if (hit)
      return { ok: true, brandWorkspaceId: hit.id, resolvedVia: "project" };
  }

  if (input.workspaceId) {
    const given = byId.get(input.workspaceId);
    if (given && providerIds.has(given.id)) {
      return { ok: true, brandWorkspaceId: given.id, resolvedVia: "workspace" };
    }
    const declared = given ? declaredBrandSource(given) : undefined;
    if (declared && providerIds.has(declared)) {
      return { ok: true, brandWorkspaceId: declared, resolvedVia: "workspace" };
    }
  }

  const fallback = preferRole(providers);
  return fallback
    ? { ok: true, brandWorkspaceId: fallback.id, resolvedVia: "pod-default" }
    : null;
}
