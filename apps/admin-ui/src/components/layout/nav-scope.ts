/**
 * Nav scope categorization
 *
 * Two categories:
 *  - "pod"  → page concerns the data pod itself (infra, sovereignty, inventory).
 *             The workspace selector is shown but muted; it doesn't filter the page.
 *  - "lens" → page is workspace-aware. "All workspaces" shows aggregate; picking a
 *             workspace narrows the view.
 *
 * Single source of truth — driven by route prefix. Add new routes here when you
 * add a new page so the WorkspaceSwitcher knows how to behave.
 */

export type NavScope = "pod" | "lens";

const POD_PATHS: readonly string[] = [
  "/",
  "/pod-services",
  "/jobs",
  "/secrets",
  "/workspaces",
  "/users",
  "/trusted-issuers",
  "/openclaw",
  "/intelligence",
];

const LENS_PATHS: readonly string[] = [
  "/workspace",
  "/events",
  "/documents",
  "/entities",
  "/proposals",
  "/connections",
  "/api-keys",
];

/**
 * Resolve a pathname to its scope. Falls back to "pod" for unknown routes
 * (safer default — won't pretend a page is workspace-aware when it isn't).
 */
export function pathScope(pathname: string): NavScope {
  if (pathname === "/") return "pod";

  // Lens has higher specificity for paths like /workspaces/:id which would
  // otherwise match /workspaces (pod). Workspace detail is technically lens
  // (URL carries a specific workspace), so check it first.
  if (pathname.startsWith("/workspaces/")) return "lens";

  if (LENS_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return "lens";
  }
  if (POD_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return "pod";
  }
  return "pod";
}
