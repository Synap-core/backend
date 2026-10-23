/**
 * `GET /invite/:token` on the POD host → the pod's console invite page.
 *
 * A pod-local invitation is accepted on the pod's console (pod-admin
 * `app/invite/[token]`). The Control Plane builds the invite email's link from
 * the pod ROW, never from the invite body. For a pod on its own domain the row
 * holds only the PROVEN pod host (registration's custom-domain proof); the
 * console host its installer named is unproven, so the CP links here instead,
 * and the pod — which knows its console through the one door,
 * `configuredPodAdminBase` — sends the browser on.
 *
 * The token is a capability: `redactSecretPath` masks `/invite/<token>` in
 * every log sink, and the redirect carries it only to this pod's own console.
 */

import type { Hono } from "hono";
import { configuredPodAdminBase } from "./pod-admin-config.js";

export function registerInviteBounce(app: Hono): void {
  app.get("/invite/:token", (c) => {
    const admin = configuredPodAdminBase();
    if (!admin.ok) {
      return c.json(
        {
          error: "Pod Console is not configured",
          code: admin.code,
          remediation: "configure_pod_admin_url",
        },
        503
      );
    }
    const target = new URL(
      `/invite/${encodeURIComponent(c.req.param("token"))}`,
      admin.base
    );
    return c.redirect(target.toString(), 302);
  });
}
