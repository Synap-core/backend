import { describe, expect, it } from "vitest";
import {
  DEVICE_STATUS_LABELS,
  humanizeToken,
  resolveDeviceStatusLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
  vocabularyEn,
} from "./index.js";
import { vocabularyFr } from "./catalog.fr.js";
import { OBJECT_KINDS } from "./object-kinds.js";
import { DEVICE_KINDS, DEVICE_STATUSES } from "../device-manifest/index.js";

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

describe("device kinds: the noun door names each one", () => {
  it("every declared kind has its own words in English and in French", () => {
    // A row of its own (`computer` through its alias, `machine`), never a
    // humanized token.
    for (const kind of DEVICE_KINDS) {
      const slug = kind === "computer" ? "machine" : kind;
      const one = `kind.${slug}.one` as keyof typeof vocabularyFr;
      const other = `kind.${slug}.other` as keyof typeof vocabularyFr;
      expect(vocabularyFr[one], kind).toBeTruthy();
      expect(resolveObjectNoun(kind, "fr"), kind).toBe(vocabularyFr[one]);
      expect(resolveObjectNounPlural(kind, "fr"), kind).toBe(
        vocabularyFr[other]
      );
    }
  });

  it("reads `vm` as a Virtual machine and `computer` as the Computer noun", () => {
    expect(resolveObjectNoun("vm")).toBe("Virtual machine");
    expect(resolveObjectNounPlural("vm")).toBe("Virtual machines");
    expect(resolveObjectNoun("vm", "fr")).toBe("Machine virtuelle");
    expect(resolveObjectNoun("cloud_server")).toBe("Cloud server");
    expect(resolveObjectNoun("printer", "fr")).toBe("Imprimante");
    expect(resolveObjectNoun("computer")).toBe(resolveObjectNoun("machine"));
    expect(resolveObjectNoun("computer", "fr")).toBe("Ordinateur");
    expect(resolveObjectNoun("other")).toBe(humanizeToken("other"));
    expect(resolveObjectNoun("other", "fr")).toBe("Autre");
  });
});

describe("device statuses: their own door", () => {
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
    expect(resolveDeviceStatusLabel("retired")).toBe("Removed");
  });

  it("an unknown status humanizes, never leaks; none is empty", () => {
    expect(resolveDeviceStatusLabel("rebooting")).toBe("Rebooting");
    expect(resolveDeviceStatusLabel(undefined)).toBe("");
  });
});
