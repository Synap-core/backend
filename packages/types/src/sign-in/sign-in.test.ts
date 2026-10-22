import { describe, expect, it } from "vitest";
import {
  cleanLoginHint,
  compareSignedInDevices,
  confirmItsYouReason,
  signedInDeviceView,
} from "./index.js";

describe("cleanLoginHint", () => {
  it("keeps a trimmed hint", () => {
    expect(cleanLoginHint("  ada@example.com ")).toBe("ada@example.com");
  });
  it.each([
    [undefined],
    [42],
    ["   "],
    ["a\nb@x"],
    ["a\u007fb"],
    ["x".repeat(255)],
  ])("drops %j", (raw) => {
    expect(cleanLoginHint(raw)).toBeNull();
  });
  it("keeps exactly an email's longest length", () => {
    expect(cleanLoginHint("x".repeat(254))).toHaveLength(254);
  });
});

describe("signedInDeviceView", () => {
  const row = {
    id: "d1",
    clientId: "synap-desktop",
    label: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    lastUsedAt: null,
    current: false,
  };

  it("names the app from the vocabulary, and says where it runs", () => {
    expect(signedInDeviceView(row)).toMatchObject({
      appName: "Synap Desktop",
      kind: "computer",
      title: "Synap Desktop",
    });
    expect(signedInDeviceView({ ...row, clientId: "synap-relay" }).kind).toBe(
      "phone"
    );
  });

  it("titles a row by the device's own label, and dates it by its last use", () => {
    const v = signedInDeviceView({
      ...row,
      label: " Ada's MacBook ",
      lastUsedAt: "2026-10-20T10:00:00.000Z",
    });
    expect(v.title).toBe("Ada's MacBook");
    expect(v.lastActiveAt.toISOString()).toBe("2026-10-20T10:00:00.000Z");
  });

  it("lists this device first, then the most recently active", () => {
    const old = signedInDeviceView({ ...row, id: "old" });
    const recent = signedInDeviceView({
      ...row,
      id: "recent",
      lastUsedAt: "2026-10-21T10:00:00.000Z",
    });
    const mine = signedInDeviceView({ ...row, id: "mine", current: true });
    expect(
      [old, recent, mine].sort(compareSignedInDevices).map((v) => v.id)
    ).toEqual(["mine", "recent", "old"]);
  });
});

describe("confirmItsYouReason", () => {
  it("names the Synap app that asks", () => {
    expect(confirmItsYouReason("synap-desktop")).toBe(
      "Synap Desktop asks you to confirm it's you."
    );
    expect(confirmItsYouReason(null)).toBe(
      "An app asks you to confirm it's you."
    );
    expect(confirmItsYouReason("dcr_4f2a")).toBe(
      "An app asks you to confirm it's you."
    );
  });
});
