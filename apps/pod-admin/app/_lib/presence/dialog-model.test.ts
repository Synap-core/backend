/**
 * The proof-of-presence dialog's states (review bf96d410): what it
 * says and offers in each, so a failed read never reads as "no passkey",
 * and the dialog never promises a way that is not there.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { failedPromptWord, presenceDialogView } from "./dialog-model";
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

  it("GUARDRAIL (recovery ladder): with a 2FA app or recovery codes, every ready state offers a code; code mode makes it primary", () => {
    const withPasskey = presenceDialogView({
      phase: ready(),
      passkeySupported: true,
      typed: true,
    });
    expect(withPasskey.primary).toBe("confirm");
    expect(withPasskey.useCode).toBe(true);
    expect(withPasskey.codeField).toBe(false);
    const coding = presenceDialogView({
      phase: ready(),
      passkeySupported: true,
      typed: true,
      codeMode: true,
    });
    expect(coding.primary).toBe("confirmCode");
    expect(coding.codeField).toBe(true);
    expect(coding.notice).toBeNull();
    // No passkey but a code: straight to the code, no "add a passkey" first.
    const noPasskey = presenceDialogView({
      phase: ready({ passkey: false }),
      passkeySupported: true,
      typed: true,
    });
    expect(noPasskey.primary).toBe("confirmCode");
    expect(noPasskey.notice).toBeNull();
    // Without a code to type, nothing changes.
    const none = presenceDialogView({
      phase: ready(),
      passkeySupported: true,
    });
    expect(none.useCode).toBe(false);
    expect(none.codeField).toBe(false);
  });
});

describe("a prompt that did not sign, past a password-manager extension", () => {
  it("offers the other prompt beside Confirm, never while signing", () => {
    expect(
      presenceDialogView({
        phase: { ...ready(), fallback: "native" },
        passkeySupported: true,
      }).secondary
    ).toBe("useDevice");
    expect(
      presenceDialogView({
        phase: { ...ready(), fallback: "page" },
        passkeySupported: true,
      }).secondary
    ).toBe("useManager");
    expect(
      presenceDialogView({
        phase: { ...ready(), kind: "signing", fallback: "native" },
        passkeySupported: true,
      }).secondary
    ).toBeNull();
    expect(
      presenceDialogView({ phase: ready(), passkeySupported: true }).secondary
    ).toBeNull();
  });

  it("keeps the browser's own error behind Copy details, never in the status", () => {
    const view = presenceDialogView({
      phase: {
        ...ready(),
        note: "The passkey prompt ended with an error.",
        copyDetail: "SecurityError: The operation is insecure.",
      },
      passkeySupported: true,
    });
    expect(view.copyDetail).toBe("SecurityError: The operation is insecure.");
    expect(view.status).toEqual({
      note: "The passkey prompt ended with an error.",
    });
  });

  it("names why, by the prompt that failed", () => {
    const base = {
      cancelled: true,
      offer: null,
      deviceName: "iCloud Keychain",
      onMac: true,
    } as const;
    expect(
      failedPromptWord({ ...base, route: "native", cancelled: false })
    ).toEqual({ word: "device.unreachable.mac" });
    expect(
      failedPromptWord({
        ...base,
        route: "native",
        cancelled: false,
        onMac: false,
      })
    ).toEqual({ word: "device.unreachable" });
    // A closed prompt is never told flatly that the browser can't reach it.
    expect(failedPromptWord({ ...base, route: "native" })).toEqual({
      word: "device.closed.mac",
    });
    expect(
      failedPromptWord({ ...base, route: "native", onMac: false })
    ).toEqual({ word: "device.closed" });
    expect(
      failedPromptWord({ ...base, route: "page", offer: "native" })
    ).toEqual({ word: "fallback.device", name: "iCloud Keychain" });
    expect(
      failedPromptWord({
        ...base,
        route: "page",
        offer: "native",
        deviceName: null,
      })
    ).toEqual({ word: "fallback.device.unnamed" });
    expect(failedPromptWord({ ...base, route: "page" })).toEqual({
      word: "cancelled",
    });
    expect(
      failedPromptWord({ ...base, route: "page", cancelled: false })
    ).toEqual({ word: "ceremonyFailed" });
  });

  it("the words read as the founder asked, in English and French", () => {
    setAmbientCatalogLocale("en");
    const t = presenceT();
    expect(t("device.unreachable.mac")).toBe(
      "This browser can’t reach the passkey on your Mac. Use Safari."
    );
    expect(t("useDevice")).toBe("Use this device’s passkey");
    expect(t("fallback.device", { name: "iCloud Keychain" })).toContain(
      "iCloud Keychain"
    );
    setAmbientCatalogLocale("fr");
    expect(presenceT()("useDevice")).toBe(
      "Utiliser la clé d’accès de cet appareil"
    );
    setAmbientCatalogLocale("en");
  });
});

describe("presenceDialogView: Set up this device (Add this device, 9 Nov 2026)", () => {
  const failedPrompt = {
    ...ready(),
    note: "Nothing was confirmed.",
    promptFailed: true,
  } as const;

  it("offered once the passkey prompt did not sign here", () => {
    const view = presenceDialogView({
      phase: failedPrompt,
      passkeySupported: true,
      setUpAllowed: true,
    });
    expect(view.setUp).toBe(true);
    // Confirm stays: the person may try the prompt again.
    expect(view.primary).toBe("confirm");
    expect(view.panel).toBe(false);
  });

  it("offered when no passkey of this pod reaches this browser, beside Add a passkey and beside the code", () => {
    expect(
      presenceDialogView({
        phase: ready({ passkey: false, label: ["iPhone"] }),
        passkeySupported: true,
        setUpAllowed: true,
      }).setUp
    ).toBe(true);
    const code = presenceDialogView({
      phase: ready({ passkey: false }),
      passkeySupported: true,
      typed: true,
      setUpAllowed: true,
    });
    expect(code.codeField).toBe(true);
    expect(code.setUp).toBe(true);
  });

  it("not offered before the prompt ran, while it runs, nor on a failed read", () => {
    expect(
      presenceDialogView({
        phase: ready(),
        passkeySupported: true,
        setUpAllowed: true,
      }).setUp
    ).toBe(false);
    expect(
      presenceDialogView({
        phase: { ...ready(), kind: "signing" },
        passkeySupported: true,
        setUpAllowed: true,
      }).setUp
    ).toBe(false);
    expect(
      presenceDialogView({
        phase: { kind: "read-failed", detail: null },
        passkeySupported: true,
        setUpAllowed: true,
      }).setUp
    ).toBe(false);
  });

  it("GUARDRAIL: never offered while approving a device link itself, or where no passkey can be created", () => {
    expect(
      presenceDialogView({
        phase: failedPrompt,
        passkeySupported: true,
        setUpAllowed: false,
      }).setUp
    ).toBe(false);
    expect(
      presenceDialogView({
        phase: ready({ passkey: false }),
        passkeySupported: true,
      }).setUp
    ).toBe(false);
  });

  it("open: the panel is the body, with no status, notice, primary or Relay line", () => {
    const view = presenceDialogView({
      phase: { ...ready({ passkey: false, label: ["iPhone"] }) },
      passkeySupported: true,
      setUpAllowed: true,
      setUpOpen: true,
    });
    expect(view.panel).toBe(true);
    expect(view.primary).toBeNull();
    expect(view.secondary).toBeNull();
    expect(view.notice).toBeNull();
    expect(view.status).toBeNull();
    expect(view.relayDevice).toBeNull();
    expect(view.codeField).toBe(false);
    expect(view.setUp).toBe(false);
  });

  it("closed again (the passkey was created): every existing state is back", () => {
    const view = presenceDialogView({
      phase: ready(),
      passkeySupported: true,
      setUpAllowed: true,
      setUpOpen: false,
    });
    expect(view.panel).toBe(false);
    expect(view.primary).toBe("confirm");
  });
});
