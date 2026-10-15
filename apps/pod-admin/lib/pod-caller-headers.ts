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
 * TRUST: the address is believed only because nothing reaches pod-admin
 * except through Caddy (deploy/docker-compose.yml publishes no port for it),
 * and Caddy — with no `trusted_proxies` configured — REPLACES any incoming
 * X-Forwarded-For with the peer it saw. Only its FIRST entry is relayed, and
 * only when it is an IP address: the pod keys limits on that one value, so a
 * list or a word never reaches it. X-Real-IP is never relayed — Caddy does
 * not rewrite it, so it says whatever the caller wrote. Behind a Cloudflare
 * tunnel the peer is the cloudflared container, so anonymous callers share
 * its address there; the session key is what separates signed-in people in
 * that setup.
 */

import { isIP } from "node:net";

/** The client-address header of the inbound request, for an anonymous call. */
export function forwardedHeaders(incoming: Headers): Record<string, string> {
  const first = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && isIP(first) ? { "x-forwarded-for": first } : {};
}

/** The session cookie plus the client address, for a call made as the person. */
export function podCallerHeaders(incoming: Headers): Record<string, string> {
  return {
    Cookie: incoming.get("cookie") ?? "",
    ...forwardedHeaders(incoming),
  };
}
