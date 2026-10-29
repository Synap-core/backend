/**
 * The interface the pod's HTTP server listens on.
 *
 * A server pod listens on every interface (`0.0.0.0`): its proxy or container
 * network reaches it from outside the process. A LOCAL_MODE pod is the one the
 * desktop app runs on the person's own computer, reached only by that app over
 * loopback. Bound to `0.0.0.0` it answered anyone on the same Wi-Fi (`/health`,
 * webhooks, OAuth callbacks, with `LOCAL_AUTH_TOKEN` the only wall on the rest)
 * and raised macOS's "accept incoming network connections?" prompt on first
 * run. So LOCAL_MODE always binds loopback; there is no setting to widen it.
 */
export function serverBindHostname(localMode: boolean): string {
  return localMode ? "127.0.0.1" : "0.0.0.0";
}
