/** The pod's public host when configured, else the host this page was asked on. */
export function podHostOf(h: Headers): string | undefined {
  try {
    const configured = process.env.POD_PUBLIC_URL?.trim();
    if (configured) return new URL(configured).host;
  } catch {
    // A malformed POD_PUBLIC_URL is the layout's problem to report; the
    // request's own host still names this pod.
  }
  return h.get("host") ?? undefined;
}
