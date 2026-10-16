/**
 * The media copy fetches through `safePublicFetch` by default — the door that
 * resolves the hostname, refuses a private address on any hop and pins the
 * socket (DNS rebinding). The door itself is tested in
 * shared-utils/src/pinned-fetch.test.ts; this pins the SEAM: a refactor back
 * to the hostname-only `safeExternalFetch` turns this red.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  publicFetch: vi.fn(async () => {
    // The door's own TYPED refusal (a message match no longer counts).
    const { BlockedOutboundError } = await import("@synap/shared-utils");
    throw new BlockedOutboundError(
      "'rebind.example' resolves to a private or reserved address (169.254.169.254)"
    );
  }),
  externalFetch: vi.fn(),
}));

vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: h.publicFetch,
  safeExternalFetch: h.externalFetch,
}));

import { fetchExternalImage } from "../fetch-image.js";

describe("fetchExternalImage default door", () => {
  it("goes through safePublicFetch and maps its refusal to 'blocked'", async () => {
    const got = await fetchExternalImage("https://rebind.example/a.png");
    expect(got).toEqual({ ok: false, reason: "blocked" });
    expect(h.publicFetch).toHaveBeenCalledTimes(1);
    expect(h.externalFetch).not.toHaveBeenCalled();
  });
});
