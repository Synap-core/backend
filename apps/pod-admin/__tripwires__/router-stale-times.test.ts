/**
 * The client router reuses a page it rendered for 30 s.
 *
 * Next 16 defaults `experimental.staleTimes.dynamic` to 0, and the root layout
 * is `force-dynamic`, so without this setting every navigation, Back included,
 * waited on the server and the proxy's pod checks (perf wave, 2026-11-20).
 * Reads the config Next itself loads, so dropping or renaming the key fails.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("router stale times", () => {
  it("keeps a dynamic page for 30 seconds on the client", () => {
    expect(nextConfig.experimental?.staleTimes?.dynamic).toBe(30);
  });

  it("names the build for the persisted query cache's buster", () => {
    // `lib/query-persist.ts` drops a cache written by another build; with no
    // id it would compare "dev" to "dev" across every shipped build.
    expect(nextConfig.env?.POD_ADMIN_BUILD_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
