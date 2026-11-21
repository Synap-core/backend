import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";
import { consoleRedirects } from "./lib/console-nav";

/**
 * One id per build, and baked into the bundle ON PURPOSE (unlike the pod's
 * public URL, below): it names this build, so the query cache a browser kept
 * (`lib/query-persist.ts`) is dropped when a new build ships, instead of
 * hydrating old shapes into new code.
 */
const BUILD_ID = randomUUID();

/**
 * Pod Console is a dedicated operator origin. Browser API configuration is
 * injected at request time by the root layout, never baked into this reusable
 * Next image via NEXT_PUBLIC_*.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  env: { POD_ADMIN_BUILD_ID: BUILD_ID },
  experimental: {
    // How long (seconds) the client router reuses a page it already rendered.
    // The root layout is `force-dynamic` and Next 16 defaults this to 0, so
    // every navigation (Back to a page seen a second ago included) waited for
    // the server and the proxy's pod checks again. Pages read their data
    // client-side through tRPC, which keeps its own freshness, and
    // `router.refresh()` still drops this cache. Pinned by
    // `__tripwires__/router-stale-times.test.ts`.
    staleTimes: { dynamic: 30 },
  },
  // The pod-admin shell consumes the workspace's @synap-core/api-types
  // package directly (it ships pre-built `dist/` so transpilation is not
  // required, but listing it keeps Next.js's source-map probe happy when
  // the workspace symlink is followed during dev).
  transpilePackages: ["@synap-core/api-types", "@synap/governance-policy"],
  // Every page that moved keeps its old URL working. Generated from the
  // `legacy` entries in `lib/console-nav.ts` (temporary 307s while the IA is
  // dogfooded), so a move is declared once, next to the page's new address.
  async redirects() {
    return consoleRedirects();
  },
};

export default nextConfig;
