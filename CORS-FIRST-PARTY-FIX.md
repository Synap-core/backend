# Durable fix: pods must trust their own first-party origins (CORS)

## Root cause (proven on the team pod, CT102)

The pod-admin console (`pod-admin.<root>`) is blocked by CORS calling the pod's
Kratos/API (`pod.<root>/.ory/kratos/public/*`).

Chain of facts established live:

1. `/.ory/kratos/public/*` is **handled by the backend** (Node), not routed to
   Kratos directly — Caddy's `handle_path /.ory/kratos/public/*` never matches
   (the `/.ory` path falls through to `reverse_proxy backend:4000`). Kratos
   emits perfect CORS when hit directly, but the browser never reaches it.
2. The backend's CORS allowlist = `getCorsOrigins()` = **`ALLOWED_ORIGINS` env ∪
   DB `corsAllowedOrigins`**.
3. The backend service **never receives `ALLOWED_ORIGINS`**: it uses
   `<<: *backend-env`, and that anchor has `PUBLIC_URL`/`SYNAP_BASE_DOMAIN` but
   **not** `ALLOWED_ORIGINS` (only the `realtime` service sets it). So the env
   half is always empty on the backend.
4. The DB seed (`seedDefaultCorsOrigins`) only adds **platform** origins
   (`synap.dev`, `www.synap.dev`, `app.synap.live`) — **never the pod's own
   `pod-admin.<root>` / `pod.<root>`**.

=> Nothing ever adds the pod's own console origin. Perso only worked because
that origin had been added to its DB manually. Team's DB never had it.

## Immediate fix applied to team (DB — self-persistent, verified)

Added `https://pod.team.thearchitech.xyz` + `https://pod-admin.team.thearchitech.xyz`
to the first workspace's `settings.corsAllowedOrigins`, restarted backend
(`loadCorsOrigins()` reloads the cache). Preflight + GET now return ACAO;
`pod-admin/login` → 200.

## Durable fix (one place, self-healing) — `apps/api/src/startup-hooks.ts`

Make the startup seed derive and add the pod's OWN first-party origins from
`PUBLIC_URL` (or `SYNAP_BASE_DOMAIN`). Runs every boot, idempotent → every pod
trusts its own console by default, no manual step.

```ts
/**
 * The pod's OWN first-party surfaces. Every pod must let its operator console
 * (pod-admin.<root>) and its own API host (pod.<root>) make credentialed
 * browser requests (Kratos login, tRPC). Derived from PUBLIC_URL (or
 * SYNAP_BASE_DOMAIN) so a pod always trusts itself — no manual
 * corsAllowedOrigins entry. Always https (browsers hit the pod over TLS).
 */
function firstPartyCorsOrigins(): string[] {
  let root = process.env.SYNAP_BASE_DOMAIN?.trim() || "";
  if (!root) {
    const publicUrl = process.env.PUBLIC_URL?.trim();
    if (publicUrl) {
      try {
        root = new URL(publicUrl).hostname;
      } catch {
        /* malformed */
      }
    }
  }
  root = root.replace(/^pod\./, ""); // pod.team.x -> team.x
  if (!root || root === "localhost" || !root.includes(".")) return [];
  return [`https://pod.${root}`, `https://pod-admin.${root}`];
}
```

Then in `seedDefaultCorsOrigins()`:

```ts
-    const toAdd = PLATFORM_CORS_ORIGINS.filter((o) => !current.includes(o));
+    const wanted = [...PLATFORM_CORS_ORIGINS, ...firstPartyCorsOrigins()];
+    const toAdd = wanted.filter((o) => !current.includes(o));
```

Requires a backend image rebuild + redeploy to take effect. After that the DB
hack is redundant (the seed makes it permanent for every pod).

## Secondary cleanups (optional, not required once the seed fix ships)

- `docker-compose.yml`: the backend service (via `*backend-env`) is missing
  `ALLOWED_ORIGINS`. The comment "ALLOWED_ORIGINS on the backend is the single
  source" is currently false. Add it to the anchor if the env path is intended.
- The Caddy `handle_path /.ory/kratos/public/*` silently not matching (so kratos
  traffic hits the backend) is a latent bug worth fixing, but the backend-owns-
  CORS path is fine once first-party origins are seeded.
