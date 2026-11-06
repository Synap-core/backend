/**
 * The proof-of-presence dialog's states (review bf96d410, lane E): what it
 * says and offers in each, so a failed read never reads as "no passkey",
 * and the dialog never promises a way that is not there.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { presenceDialogView } from "./dialog-model";
import { presenceT } from "./copy";

const ready = (over: Partial<{ passkey: boolean; label: string[] }> = {}) =>
  ({
    kind: "ready",
    passkey: over.passkey ?? true,
    deviceKeys: (over.label ?? []).map((label) => ({ label })),
    note: null,
  }) as const;

describe("presenceDialogView", () => {
  it("a failed read is its own state: the headline asks to retry, the pod's words are the detail", () => {
    const view = presenceDialogView({
      phase: { kind: "read-failed", detail: "Kratos admin API timed out" },
      passkeySupported: true,
    });
    expect(view.status).toEqual({ word: "readFailed" });
    expect(view.detail).toBe("Kratos admin API timed out");
    expect(view.tone).toBe("danger");
    expect(view.primary).toBe("tryAgain");
    expect(view.notice).toBeNull();
    setAmbientCatalogLocale("en");
    expect(presenceT()("readFailed")).toBe(
      "Couldn’t get a confirmation from your pod. Check your connection, then press Try again."
    );
  });

  it("no passkey on this pod: Add a passkey is the primary action, Try again beside it", () => {
    const view = presenceDialogView({
      phase: ready({ passkey: false }),
      passkeySupported: true,
    });
    expect(view.notice).toBe("noPasskey");
    expect(view.primary).toBe("addPasskey");
    expect(view.secondary).toBe("tryAgain");
  });

  it("after Add a passkey opened its tab: come back and press Try again, which leads", () => {
    const view = presenceDialogView({
      phase: ready({ passkey: false }),
      passkeySupported: true,
      addPasskeyOpened: true,
    });
    expect(view.status).toEqual({ word: "comeBack" });
    expect(view.primary).toBe("tryAgain");
    expect(view.secondary).toBe("addPasskey");
    setAmbientCatalogLocale("en");
    expect(presenceT()("comeBack")).toMatch(
      /come back here and press Try again/
    );
  });

  it("a browser that cannot use a passkey: no primary action and no Try again", () => {
    const view = presenceDialogView({
      phase: ready(),
      passkeySupported: false,
    });
    expect(view.notice).toBe("unsupported");
    expect(view.primary).toBeNull();
    expect(view.secondary).toBeNull();
  });

  it("Relay is offered only on an enrolled device", () => {
    expect(
      presenceDialogView({ phase: ready(), passkeySupported: true }).relayDevice
    ).toBeNull();
    expect(
      presenceDialogView({
        phase: ready({ label: ["Antoine's iPhone"] }),
        passkeySupported: true,
      }).relayDevice
    ).toBe("Antoine's iPhone");
  });

  it("in a batch the way out is Stop here; alone it is Not now", () => {
    expect(
      presenceDialogView({
        phase: ready(),
        passkeySupported: true,
        progress: { index: 1, total: 3 },
      }).decline
    ).toBe("stopHere");
    expect(
      presenceDialogView({ phase: ready(), passkeySupported: true }).decline
    ).toBe("notNow");
  });

  it("signing holds Confirm and says it waits; a reason to ask again shows as the status", () => {
    const signing = presenceDialogView({
      phase: { ...ready(), kind: "signing" },
      passkeySupported: true,
    });
    expect(signing).toMatchObject({
      primary: "confirm",
      busy: true,
      status: { word: "waiting" },
    });
    expect(
      presenceDialogView({
        phase: { ...ready(), note: "That confirmation took too long." },
        passkeySupported: true,
      }).status
    ).toEqual({ note: "That confirmation took too long." });
  });
  it("a change this page makes itself never offers Relay, even with an enrolled phone", () => {
    for (const passkey of [true, false]) {
      const shared = {
        phase: ready({ passkey, label: ["iPhone"] }),
        passkeySupported: true,
      };
      expect(presenceDialogView(shared).relayDevice).toBe("iPhone");
      expect(
        presenceDialogView({ ...shared, inBrowserOnly: true }).relayDevice
      ).toBeNull();
    }
  });
});
