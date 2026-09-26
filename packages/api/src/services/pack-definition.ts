/**
 * Packs never create a workspace of their own (founder decision D8,
 * 2026-09-25).
 *
 * A PACK (today: a package tagged `suite` — the-arch, enterprise-os,
 * content-creation, every `--from-project` export) is a bundle over DOMAINS: it
 * lists the workspace templates it needs as `require` dependencies, the resolver
 * installs any that are missing, and the pack's own layers (its playbooks,
 * rules, and any profile/view it still authors) are LAYERED onto its PRIMARY
 * domain — the first `require`d workspace — exactly like a compose overlay, and
 * recorded in that workspace's `settings.installedPacks`. It is never
 * materialized as a standalone "suite" workspace (the stray workspace every
 * pack install used to leave behind).
 *
 * Existing suite workspaces are left alone: a pod that already holds a
 * workspace stamped with the pack's slug keeps reconciling it as before (the
 * resolver's `found` branch and the idempotent create both reuse it). Nothing
 * is deleted.
 *
 * Project-scope methods in a pack land in the primary domain too:
 * `playbooks.create` is a workspace procedure, so there is no pod-wide create
 * door yet (a project's track can use a method from any workspace its members
 * can see).
 */

/** The authored pack signal. Mirrors `SUITE_TAG` / `isSuite` (@synap-core/marketplace). */
export const PACK_TAG = "suite";

/** Is this package definition a pack (never its own workspace)? */
export function isPackDefinition(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const d = def as { _meta?: { tags?: unknown }; tags?: unknown };
  const tags = d._meta?.tags ?? d.tags;
  return Array.isArray(tags) && tags.includes(PACK_TAG);
}

/**
 * The pack's PRIMARY domain: the first workspace it `require`s (declared order)
 * that resolved to a live workspace. `null` ⇒ none resolved — the caller must
 * surface it, never fall back to creating a workspace.
 */
export function primaryPackDomain(
  declared: ReadonlyArray<{
    slug: string;
    kind?: string;
    relation?: string;
  }>,
  resolved: ReadonlyArray<{ slug: string; workspaceId?: string }>
): { slug: string; workspaceId: string } | null {
  for (const dep of declared) {
    if ((dep.kind ?? "workspace") !== "workspace") continue;
    if ((dep.relation ?? "require") !== "require") continue;
    const hit = resolved.find((r) => r.slug === dep.slug && r.workspaceId);
    if (hit?.workspaceId)
      return { slug: dep.slug, workspaceId: hit.workspaceId };
  }
  return null;
}
