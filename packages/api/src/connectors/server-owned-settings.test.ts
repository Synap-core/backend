import { describe, expect, it } from "vitest";
import {
  preserveServerOwnedSettings,
  stripServerOwnedSettings,
  stripServerOwnedSettingsLeaves,
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

  it("exposurePolicy (Sites W2 S3) can be neither planted nor erased by a settings round-trip", () => {
    const planted = { kinds: { entity: { public: { read: "direct" } } } };
    expect(
      stripServerOwnedSettings({ theme: "dark", exposurePolicy: planted })
    ).toEqual({ theme: "dark" });
    const stored = { exposurePolicy: { kinds: {} } };
    expect(
      preserveServerOwnedSettings(
        { theme: "light", exposurePolicy: planted },
        stored
      )
    ).toEqual({ theme: "light", exposurePolicy: stored.exposurePolicy });
  });

  it("intent (homes A10) has ONE writer: a settings save neither plants nor erases it", () => {
    const stored = {
      intent: { label: "Sales", produces: ["deal"], source: "template" },
    };
    const forked = { label: "Mine", produces: ["post"], source: "template" };
    expect(stripServerOwnedSettings({ theme: "dark", intent: forked })).toEqual(
      { theme: "dark" }
    );
    // The client projection carries intent back on every save: kept as stored.
    expect(
      preserveServerOwnedSettings({ theme: "light", intent: forked }, stored)
    ).toEqual({ theme: "light", intent: stored.intent });
    expect(preserveServerOwnedSettings({ theme: "light" }, stored)).toEqual({
      theme: "light",
      intent: stored.intent,
    });
  });

  it("devplane.localTerminalEnabled (audit F2) is dropped; the rest of devplane is kept", () => {
    const planted = {
      theme: "dark",
      devplane: { localTerminalEnabled: true, monorepoRoot: "/src/app" },
    };
    const expected = { theme: "dark", devplane: { monorepoRoot: "/src/app" } };
    // create + the review payload of an update
    expect(stripServerOwnedSettings(planted)).toEqual(expected);
    // what `workspaces.update` persists (top-level keys go via the repository)
    expect(stripServerOwnedSettingsLeaves(planted)).toEqual(expected);
    // the caller's object is not mutated
    expect(planted.devplane.localTerminalEnabled).toBe(true);
    // a blob without devplane, or with a non-object devplane, passes through
    expect(stripServerOwnedSettingsLeaves({ theme: "x" })).toEqual({
      theme: "x",
    });
    expect(stripServerOwnedSettingsLeaves({ devplane: null })).toEqual({
      devplane: null,
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
