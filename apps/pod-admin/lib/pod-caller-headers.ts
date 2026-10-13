/**
 * Who a server-side call to the pod is made FOR — the one place every fetch
 * this process sends to `POD_URL` takes its caller headers from.
 *
 * Pod-admin reaches `backend:4000` over the compose network, so without help
 * the pod sees no client address on any of these calls: its rate limiter
 * (apps/api `rate-limit-classes.ts`) read them all as IP "unknown" and every
 * operator's gate checks spent ONE shared budget. Relaying the browser's
 * address keys each call by the real client; the session cookie, where the
 * call carries one, gives a signed-in person their own budget on top.
 *
 * TRUST: these headers are believed only because nothing reaches pod-admin
 * except through Caddy (deploy/docker-compose.yml publishes no port for it),
 * and Caddy — with no `trusted_proxies` configured — REPLACES any incoming
 * X-Forwarded-For with the peer it saw. X-Real-IP is not rewritten by Caddy,
 * but the pod reads it only when X-Forwarded-For is absent, which a request
 * through Caddy never is. Behind a Cloudflare tunnel the peer is the
 * cloudflared container, so anonymous callers share its address there; the
 * session key is what separates signed-in people in that setup.
 */

const FORWARDED = ["x-forwarded-for", "x-real-ip"] as const;

/** The client-address headers of the inbound request, for an anonymous call. */
export function forwardedHeaders(incoming: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/** The session cookie plus the client address, for a call made as the person. */
export function podCallerHeaders(incoming: Headers): Record<string, string> {
  return {
    Cookie: incoming.get("cookie") ?? "",
    ...forwardedHeaders(incoming),
  };
}
