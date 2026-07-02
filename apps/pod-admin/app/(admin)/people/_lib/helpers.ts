/**
 * Helpers shared across the People tab.
 *
 * `formatRelative` mirrors the Overview implementation so the People tab
 * doesn't depend on Overview internals; both are tiny enough that
 * duplicating beats coupling.
 *
 * `studioDeepLinkForWorkspace` returns the URL Studio uses to land on a
 * specific workspace. Studio currently reads the active workspace from
 * the auth context (see `synap-app/apps/studio/components/providers/
 * SynapProvider.tsx`) — there is no `?ws=` query-param switch wired yet,
 * so we still encode the workspace id as a hint (so Studio can pick it
 * up later without the link breaking) and the operator may need to
 * switch workspaces manually inside Studio for now.
 *
 * TODO(phase-e): teach Studio to honour `?ws=<id>` by reading the param
 * in its auth provider and calling `updateWorkspaceId`. Until then, this
 * helper is best-effort: the URL opens Studio on its default workspace.
 *
 * In dev, `NEXT_PUBLIC_SYNAP_HUB_URL` points to the local Hub dev server.
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

export function formatExpiresAt(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "expired";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d left`;
}

const HUB_BASE =
  process.env.NEXT_PUBLIC_SYNAP_HUB_URL ?? "https://hub.synap.live";

export function studioDeepLinkForWorkspace(workspaceId: string): string {
  const url = new URL(HUB_BASE);
  url.searchParams.set("ws", workspaceId);
  return url.toString();
}

export function studioDeepLinkForWorkspaceSettings(
  workspaceId: string
): string {
  const url = new URL("/settings/workspace/general", HUB_BASE);
  url.searchParams.set("ws", workspaceId);
  return url.toString();
}
