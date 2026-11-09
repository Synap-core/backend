/**
 * "Add a passkey" with a factor already held (W3 slice 3, founder decision 2):
 * Kratos' guard refuses the new passkey without a grant, so pod admin
 * confirms with an existing passkey first; it cannot with a Relay key alone;
 * a failed read of the device keys is never "none".
 */
import { describe, expect, it } from "vitest";
import { offersDeviceLink, passkeyAddStep } from "./passkey-add-model";

describe("passkeyAddStep", () => {
  it("no factor: the first passkey is added straight away", () => {
    expect(passkeyAddStep({ passkeys: 0, deviceKeys: 0, granted: false })).toBe(
      "add"
    );
  });

  it("a passkey: confirm with it first, then create", () => {
    expect(passkeyAddStep({ passkeys: 1, deviceKeys: 0, granted: false })).toBe(
      "authorize"
    );
    expect(passkeyAddStep({ passkeys: 1, deviceKeys: 2, granted: false })).toBe(
      "authorize"
    );
    expect(
      passkeyAddStep({ passkeys: 2, deviceKeys: null, granted: true })
    ).toBe("create");
  });

  it("only a Relay key: pod admin cannot get the grant here", () => {
    expect(passkeyAddStep({ passkeys: 0, deviceKeys: 1, granted: false })).toBe(
      "relayOnly"
    );
  });

  it("an authenticator app or recovery codes: confirm with a code first (the guard refuses a plain add)", () => {
    expect(
      passkeyAddStep({
        passkeys: 0,
        deviceKeys: 0,
        codes: true,
        granted: false,
      })
    ).toBe("authorize");
    expect(
      passkeyAddStep({
        passkeys: 0,
        deviceKeys: 1,
        codes: true,
        granted: false,
      })
    ).toBe("authorize");
    expect(
      passkeyAddStep({ passkeys: 0, deviceKeys: 0, codes: true, granted: true })
    ).toBe("create");
  });

  it("a permission this session holds (an approved request) creates, whatever protects the account", () => {
    expect(passkeyAddStep({ passkeys: 0, deviceKeys: 1, granted: true })).toBe(
      "create"
    );
    expect(
      passkeyAddStep({ passkeys: 0, deviceKeys: null, granted: true })
    ).toBe("create");
  });

  it("an unread factor list with no passkey is a failed read, not an open door", () => {
    expect(
      passkeyAddStep({
        passkeys: 0,
        deviceKeys: 0,
        codes: null,
        granted: false,
      })
    ).toBe("devicesFailed");
  });

  it("an unread device list with no passkey is a failed read, not an open door", () => {
    expect(
      passkeyAddStep({ passkeys: 0, deviceKeys: null, granted: false })
    ).toBe("devicesFailed");
  });
});

describe("offersDeviceLink (Add this device, 9 Nov 2026)", () => {
  it("a Relay key alone: approving this device from Relay or another device is the way forward", () => {
    expect(
      offersDeviceLink(
        passkeyAddStep({ passkeys: 0, deviceKeys: 1, granted: false })
      )
    ).toBe(true);
  });

  it("a passkey: offered beside confirming with it (it may live on another device)", () => {
    expect(
      offersDeviceLink(
        passkeyAddStep({ passkeys: 1, deviceKeys: 0, granted: false })
      )
    ).toBe(true);
  });

  it("not with no factor, not once granted, not on a failed read", () => {
    expect(
      offersDeviceLink(
        passkeyAddStep({ passkeys: 0, deviceKeys: 0, granted: false })
      )
    ).toBe(false);
    expect(
      offersDeviceLink(
        passkeyAddStep({ passkeys: 1, deviceKeys: 0, granted: true })
      )
    ).toBe(false);
    expect(
      offersDeviceLink(
        passkeyAddStep({ passkeys: 0, deviceKeys: null, granted: false })
      )
    ).toBe(false);
  });
});
