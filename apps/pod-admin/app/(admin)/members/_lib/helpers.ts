/**
 * Helpers shared across the People tab.
 *
 * This file used to also export `studioDeepLinkForWorkspace` /
 * `studioDeepLinkForWorkspaceSettings`, which built `hub.synap.live?ws=<id>`
 * from `NEXT_PUBLIC_SYNAP_HUB_URL`. All three are gone: that target is the
 * deprecated fluid web app, it sits behind a second login on a different auth
 * stack, and it never read `?ws` at all — so the workspace you clicked from
 * was silently dropped. Exits now go through `openIn()` (`lib/open-in.ts`),
 * the one door, which only emits destinations whose receiver has been read.
 */

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
