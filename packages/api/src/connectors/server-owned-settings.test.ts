import { describe, expect, it } from "vitest";
import {
  preserveServerOwnedSettings,
  stripServerOwnedSettings,
} from "./server-owned-settings.js";

/**
 * An editor must not be able to plant or erase the
 * server-owned `controlPlane` / `nango` workspace settings through the generic
 * settings door.
 */

describe("server-owned workspace settings", () => {
  it("a client-supplied controlPlane.url / nango is dropped on create", () => {
    expect(
      stripServerOwnedSettings({
        theme: "dark",
        controlPlane: { url: "https://evil.tld", podId: "pod-1" },
        nango: { secretKey: "planted", host: "https://evil.tld" },
      })
    ).toEqual({ theme: "dark" });
  });

  it("an update cannot replace the stored controlPlane with a planted URL", () => {
    const stored = {
      controlPlane: {
        url: "https://cp.synap.live",
        podId: "pod-1",
        tier: "pro",
      },
    };
    expect(
      preserveServerOwnedSettings(
        {
          theme: "light",
          controlPlane: { url: "https://evil.tld", podId: "pod-1" },
        },
        stored
      )
    ).toEqual({ theme: "light", controlPlane: stored.controlPlane });
  });

  it("a round-trip WITHOUT controlPlane (the client projection) does not erase it", () => {
    const stored = { controlPlane: { podId: "pod-1" }, nango: { host: "h" } };
    expect(preserveServerOwnedSettings({ theme: "light" }, stored)).toEqual({
      theme: "light",
      controlPlane: { podId: "pod-1" },
      nango: { host: "h" },
    });
  });

  it("a workspace that never had them does not gain them", () => {
    expect(
      preserveServerOwnedSettings(
        { controlPlane: { url: "x" } },
        { theme: "dark" }
      )
    ).toEqual({});
  });
});
