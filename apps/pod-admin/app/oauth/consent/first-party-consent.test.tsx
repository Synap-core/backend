/**
 * The Synap-app consent, rendered (react-dom/server; pod-admin's vitest runs
 * in node): what the person reads before a Synap app signs in as them, and
 * the state shown instead while they are sent to sign in again.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ReactElement } from "react";
import { Card } from "@heroui/react";

vi.mock("../../../lib/trpc", () => ({ trpc: {} }));

import {
  FirstPartyConsent,
  PodCredentialNotice,
  ReconfirmingNotice,
} from "./ConsentForm";

const html = (el: ReactElement) => render(<Card>{el}</Card>);
const base = {
  name: "Synap Desktop",
  onComputer: true,
  redirectHost: "127.0.0.1:53111",
  busy: false,
  step: { kind: "idle" } as const,
  onDecide: () => {},
};

describe("FirstPartyConsent", () => {
  it("names the computer, never its loopback port, and says it acts as you", () => {
    const out = html(<FirstPartyConsent {...base} reconfirm={false} />);
    expect(out).toContain("This computer");
    expect(out).not.toContain("127.0.0.1");
    expect(out).toContain("Synap Desktop will act as you.");
    expect(out).toContain(">Sign in<");
  });

  it("re-confirming reads as a confirmation, not a new sign-in", () => {
    const out = html(<FirstPartyConsent {...base} reconfirm />);
    expect(out).toContain("Synap Desktop is already signed in.");
    expect(out).toContain(">Confirm<");
  });

  it("the sign-out promise is a door to Signed-in apps", () => {
    const out = html(<FirstPartyConsent {...base} reconfirm={false} />);
    expect(out).toMatch(/href="\/my-connections"[^>]*>Signed-in apps</);
  });

  it("a phone's redirect is shown in full", () => {
    const out = html(
      <FirstPartyConsent
        {...base}
        onComputer={false}
        redirectHost="synap.live"
        reconfirm={false}
      />
    );
    expect(out).toContain("synap.live");
  });
});

describe("ReconfirmingNotice", () => {
  it("is a status mark, with no decision to click", () => {
    const out = html(<ReconfirmingNotice />);
    expect(out).toContain('role="status"');
    expect(out).toContain("Confirming it&#x27;s you…");
    expect(out).not.toContain("<button");
  });
});

describe("PodCredentialNotice", () => {
  it("asks for the pod password or passkey, names the app, and gives a Cloud-only person a way", () => {
    const out = html(
      <PodCredentialNotice name="Synap Desktop" onContinue={() => {}} />
    );
    expect(out).toContain("Confirm with your password or passkey");
    expect(out).toContain("Synap Desktop asks you to confirm it");
    expect(out).toContain("Make the change from this console");
    expect(out).toContain('role="status"');
  });
});
