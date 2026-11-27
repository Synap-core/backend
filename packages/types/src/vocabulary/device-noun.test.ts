import { describe, expect, it } from "vitest";
import {
  DEVICE_KIND_LABELS,
  DEVICE_STATUS_LABELS,
  resolveDeviceKindLabel,
  resolveDeviceStatusLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
  vocabularyEn,
} from "./index.js";
import { vocabularyFr } from "./catalog.fr.js";
import { OBJECT_KINDS } from "./object-kinds.js";
import {
  DEVICE_KINDS,
  DEVICE_STATUSES,
} from "../device-manifest/index.js";

/**
 * "Device" (devices plan 767a5978, decision 78fc3fa1): the product word that
 * replaces "Computers" in the nav, "Appareil" in French. A computer stays a
 * device kind, so the `machine` noun keeps its own words. Each device kind
 * and status has its words in both languages, so no UI humanizes `vm` as
 * "Vm".
 */
describe("the Device noun", () => {
  it("is a registry kind, resolved through the one door in both languages", () => {
    expect(OBJECT_KINDS.device?.kind).toBe("device");
    expect(resolveObjectNoun("device")).toBe("Device");
    expect(resolveObjectNounPlural("device")).toBe("Devices");
    expect(resolveObjectNoun("device", "fr")).toBe("Appareil");
    expect(resolveObjectNounPlural("device", "fr")).toBe("Appareils");
  });

  it("leaves the computer noun as it is", () => {
    expect(resolveObjectNoun("machine")).toBe("Computer");
    expect(resolveObjectNoun("machine", "fr")).toBe("Ordinateur");
  });
});

describe("device kinds and statuses", () => {
  it("names exactly the declared kinds, in English and in French", () => {
    expect(Object.keys(DEVICE_KIND_LABELS).sort()).toEqual(
      [...DEVICE_KINDS].sort()
    );
    for (const kind of DEVICE_KINDS) {
      const key = `deviceKind.${kind}` as const;
      expect(vocabularyEn[key]).toBe(DEVICE_KIND_LABELS[kind]);
      expect(vocabularyFr[key], key).toBeTruthy();
      expect(resolveDeviceKindLabel(kind, { locale: "fr" })).toBe(
        vocabularyFr[key]
      );
    }
    expect(resolveDeviceKindLabel("vm")).toBe("Virtual machine");
    expect(resolveDeviceKindLabel("vm", { locale: "fr" })).toBe(
      "Machine virtuelle"
    );
    expect(resolveDeviceKindLabel("cloud_server")).toBe("Cloud server");
  });

  it("names exactly the declared statuses, in English and in French", () => {
    expect(Object.keys(DEVICE_STATUS_LABELS).sort()).toEqual(
      [...DEVICE_STATUSES].sort()
    );
    for (const status of DEVICE_STATUSES) {
      const key = `deviceStatus.${status}` as const;
      expect(vocabularyEn[key]).toBe(DEVICE_STATUS_LABELS[status]);
      expect(vocabularyFr[key], key).toBeTruthy();
      expect(resolveDeviceStatusLabel(status, { locale: "fr" })).toBe(
        vocabularyFr[key]
      );
    }
    expect(resolveDeviceStatusLabel("online")).toBe("Online");
    expect(resolveDeviceStatusLabel("offline", { locale: "fr" })).toBe(
      "Hors ligne"
    );
    expect(resolveDeviceStatusLabel("unknown")).toBe("Not reported yet");
  });

  it("an unknown kind or status humanizes, never leaks; none is empty", () => {
    expect(resolveDeviceKindLabel("drone")).toBe("Drone");
    expect(resolveDeviceKindLabel("smart_plug", { locale: "fr" })).toBe(
      "Smart plug"
    );
    expect(resolveDeviceStatusLabel("rebooting")).toBe("Rebooting");
    expect(resolveDeviceKindLabel(null)).toBe("");
    expect(resolveDeviceStatusLabel(undefined)).toBe("");
  });
});
