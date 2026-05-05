import type { NextConfig } from "next";

/**
 * Pod Admin lives on the same origin as the pod API in production
 * (served behind the pod's reverse proxy at `/admin-next` or a dedicated
 * subdomain). The dev server runs on :4040 and proxies tRPC + Kratos
 * requests through `NEXT_PUBLIC_POD_URL` so cookies stay same-origin.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  // The pod-admin shell consumes the workspace's @synap-core/api-types
  // package directly (it ships pre-built `dist/` so transpilation is not
  // required, but listing it keeps Next.js's source-map probe happy when
  // the workspace symlink is followed during dev).
  transpilePackages: ["@synap-core/api-types"],
};

export default nextConfig;
