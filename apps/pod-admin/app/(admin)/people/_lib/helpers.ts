/**
 * Helpers shared across the People tab.
 *
 * `formatRelative` mirrors the Overview implementation so the People tab
 * doesn't depend on Overview internals; both are tiny enough that
 * duplicating beats coupling. It is also imported by the Entities tab and
 * the workspace Overview tab — keep the name and signature stable.
 *
 * This file used to also export `studioDeepLinkForWorkspace` /
 * `studioDeepLinkForWorkspaceSettings`, which built `hub.synap.live?ws=<id>`
 * from `NEXT_PUBLIC_SYNAP_HUB_URL`. All three are gone: that target is the
 * deprecated fluid web app, it sits behind a second login on a different auth
 * stack, and it never read `?ws` at all — so the workspace you clicked from
 * was silently dropped. Exits now go through `openIn()` (`lib/open-in.ts`),
 * the one door, which only emits destinations whose receiver has been read.
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
