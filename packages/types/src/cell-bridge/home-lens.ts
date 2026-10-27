/**
 * `lifecycle.home` lists every space the viewer sees; a page in one space must
 * see only that space — its card and its needs-you part (the total becomes
 * that part; unknown stays unknown). A port of the desktop host's
 * `lensIntentAnswer` (browser `cells/createViewFrameHandlers.ts`), so both
 * hosts narrow the same way.
 *
 * An ALLOWLIST, never a spread: a pod-level field the read grows later (a
 * pod-wide count) must not reach a space's page. With no space lens the
 * answer passes unchanged (the page reads what the viewer reads).
 */
export function narrowHomeToSpace(
  answer: unknown,
  workspaceId: string | null
): unknown {
  if (!workspaceId) return answer;
  if (
    !answer ||
    typeof answer !== "object" ||
    !Array.isArray((answer as { spaces?: unknown }).spaces)
  ) {
    return answer;
  }
  const home = answer as {
    spaces: Array<{ workspaceId?: unknown }>;
    needsYou?: {
      total: number | null;
      truncated?: boolean | null;
      bySpace?: Array<{
        workspaceId?: unknown;
        count: number | null;
        truncated?: boolean | null;
      }>;
    };
  };
  const bySpace = home.needsYou?.bySpace;
  // Only a KNOWN split that lacks the space says zero. No split at all (or
  // an unknown total) says nothing about this space: unknown, never 0.
  const part = Array.isArray(bySpace)
    ? (bySpace.find((p) => p.workspaceId === workspaceId) ?? null)
    : null;
  const total = part
    ? part.count
    : Array.isArray(bySpace) && home.needsYou?.total !== null
      ? 0
      : null;
  // The space's OWN cap, never the pod's.
  const truncated = part ? part.truncated === true : false;
  return {
    spaces: home.spaces.filter((s) => s.workspaceId === workspaceId),
    ...(home.needsYou
      ? { needsYou: { total, truncated, bySpace: part ? [part] : [] } }
      : {}),
  };
}
