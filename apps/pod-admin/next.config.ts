import type { NextConfig } from "next";

/**
 * Pod Admin is a dedicated operator origin. Browser API configuration is
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
};

export default nextConfig;
