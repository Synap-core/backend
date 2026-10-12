/**
 * The pod-admin app's origin for a pod origin — where the key-approval pages
 * live (`/approve-agent/:keyId`, `/approve-agents?keys=`). ONE rule: the setup
 * door's review URL and `agentUsers.list`'s `approveUrl` both build on it.
 *
 * `pod.<root>` → `pod-admin.<root>`; `<sub>.<root>` → `pod-admin.<root>`;
 * localhost → the local pod-admin dev server.
 */
export function toPodAdminOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    const host = u.host; // host:port
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
      return "http://localhost:4040";
    }
    if (host.startsWith("pod.")) {
      const root = host.slice("pod.".length).replace(/:\d+$/, "");
      return `${u.protocol}//pod-admin.${root}`;
    }
    // `<sub>.<root>` → swap the leading label for `pod-admin`.
    const dot = host.indexOf(".");
    const root =
      dot > 0
        ? host.slice(dot + 1).replace(/:\d+$/, "")
        : host.replace(/:\d+$/, "");
    return `${u.protocol}//pod-admin.${root}`;
  } catch {
    return origin;
  }
}

/**
 * Where a person approves a pending agent key: the pod-admin app (already
 * Kratos-authed there), not a page on the API origin. Reverse-proxy-safe: the
 * pod's PUBLIC_URL first — the request URL is the internal (often http://) one
 * behind nginx. ONE builder: the setup door's `reviewUrl` and the holder's
 * key-state answer (`/auth/key-state`) both call it.
 */
export function agentApprovalPageUrl(
  requestUrl: string,
  keyId: string,
  agentType: string
): string {
  const origin = process.env.PUBLIC_URL || new URL(requestUrl).origin;
  return `${toPodAdminOrigin(origin)}/approve-agent/${keyId}?agentType=${encodeURIComponent(agentType)}`;
}
