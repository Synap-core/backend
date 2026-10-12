import type { NextConfig } from "next";
import { consoleRedirects } from "./lib/console-nav";

/**
 * Pod Console is a dedicated operator origin. Browser API configuration is
 * injected at request time by the root layout, never baked into this reusable
 * Next image via NEXT_PUBLIC_*.
 */
const nextConfig: NextConfig = {
  output: "standalone",
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
