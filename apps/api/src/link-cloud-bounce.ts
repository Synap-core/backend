/**
 * `GET /admin/link-cloud` on the POD host → the pod's console "Link Synap
 * Cloud" page (join plan phase 4, decision 2 of 2026-10-23).
 *
 * The Control Plane's claim-access hop sends the browser here, twice: with the
 * identity-link assertion (`#intent=…&assertion=…`) and, at the end, with the
 * outcome (`#linked`). The CP builds this URL from the pod ROW, which holds
 * only the PROVEN pod host, so it cannot link the console directly (same rule
 * as `invite-bounce.ts`); the pod, which knows its console through
 * `configuredPodAdminBase`, sends the browser on.
 *
 * Everything the console needs travels in the URL FRAGMENT, which the browser
 * never sends to a server and carries across this 302 by itself. The query is
 * dropped: nothing the hop sends belongs in a query, so nothing can be logged
 * or forwarded from one.
 */

import type { Hono } from "hono";
import { configuredPodAdminBase } from "./pod-admin-config.js";

export function registerLinkCloudBounce(app: Hono): void {
  app.get("/admin/link-cloud", (c) => {
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
    c.header("Cache-Control", "no-store");
    const target = new URL("/link-cloud", admin.base);
    target.search = new URL(c.req.url).search;
    return c.redirect(target.toString(), 302);
  });
}
