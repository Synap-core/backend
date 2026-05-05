/**
 * Helpers shared across the People tab.
 *
 * `formatRelative` mirrors the Overview implementation so the People tab
 * doesn't depend on Overview internals; both are tiny enough that
 * duplicating beats coupling.
 *
 * `studioDeepLinkForWorkspace` returns the URL Studio uses to swap into
 * a specific workspace. The shape `studio.synap.live/?ws=<id>` was
 * specified in the Phase C brief; Studio implements the `?ws=` switch
 * server-side. In dev (`NEXT_PUBLIC_STUDIO_URL`) operators can point
 * this elsewhere.
 */

export function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

const STUDIO_BASE =
  process.env.NEXT_PUBLIC_STUDIO_URL ?? "https://studio.synap.live";

export function studioDeepLinkForWorkspace(workspaceId: string): string {
  const url = new URL(STUDIO_BASE);
  url.searchParams.set("ws", workspaceId);
  return url.toString();
}

export function studioDeepLinkForWorkspaceSettings(
  workspaceId: string
): string {
  const url = new URL("/settings/workspace/general", STUDIO_BASE);
  url.searchParams.set("ws", workspaceId);
  return url.toString();
}
