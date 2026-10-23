/**
 * One "Signed-in apps" row, rendered (react-dom/server): the app's name and
 * mark from the shared view, "This device", last used, and Sign out.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { signedInDeviceView } from "@synap-core/types/sign-in";

vi.mock("../../../lib/trpc", () => ({ trpc: {} }));

import { SignedInAppRow } from "./signed-in-apps-section";

const row = (over: Partial<Parameters<typeof signedInDeviceView>[0]> = {}) =>
  signedInDeviceView({
    id: "d1",
    clientId: "synap-desktop",
    label: "Ada's MacBook",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    current: false,
    ...over,
  });

describe("SignedInAppRow", () => {
  it("names the device and the app, when it was last used, and offers Sign out", () => {
    const out = renderToStaticMarkup(
      <SignedInAppRow view={row()} isSigningOut={false} onSignOut={() => {}} />
    );
    expect(out).toContain("Ada&#x27;s MacBook");
    expect(out).toContain("Synap Desktop · last used");
    expect(out).toContain(">Sign out<");
    expect(out).not.toContain("This device");
  });

  it("marks this device", () => {
    const out = renderToStaticMarkup(
      <SignedInAppRow
        view={row({ current: true, label: null, clientId: "synap-relay" })}
        isSigningOut={false}
        onSignOut={() => {}}
      />
    );
    expect(out).toContain("This device");
    expect(out).toContain("Synap Relay");
  });
});
