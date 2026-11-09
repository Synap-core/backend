/**
 * The "this browser holds a passkey for this pod" marker: per pod, and an
 * unreadable storage is no marker, never a crash.
 */
import { describe, expect, it } from "vitest";
import {
  THIS_DEVICE_KEY_PREFIX,
  readThisDevice,
  thisDeviceKey,
  writeThisDevice,
} from "./this-device";

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("QuotaExceededError");
  },
};

const POD = "https://pod.example.synap.live";

describe("this-device marker", () => {
  it("the key is versioned and names the pod's origin", () => {
    expect(thisDeviceKey(POD)).toBe(
      "synap.presence.thisDevice.v1:https://pod.example.synap.live"
    );
    expect(thisDeviceKey(POD).startsWith(THIS_DEVICE_KEY_PREFIX)).toBe(true);
  });

  it("written, then read, for that pod only", () => {
    const s = memory();
    expect(readThisDevice(s, POD)).toBe(false);
    expect(writeThisDevice(s, POD)).toBe(true);
    expect(readThisDevice(s, POD)).toBe(true);
    expect(readThisDevice(s, "https://other.synap.live")).toBe(false);
    expect([...s.m.values()]).toEqual(["passkey"]);
  });

  it("another value is no marker", () => {
    const s = memory();
    s.setItem(thisDeviceKey(POD), "1");
    expect(readThisDevice(s, POD)).toBe(false);
  });

  it("storage that throws or is missing is no marker, and writing it does not throw", () => {
    expect(readThisDevice(throwing, POD)).toBe(false);
    expect(writeThisDevice(throwing, POD)).toBe(false);
    expect(readThisDevice(null, POD)).toBe(false);
    expect(writeThisDevice(undefined, POD)).toBe(false);
  });

  it("no pod origin (a misconfigured console) keeps nothing", () => {
    const s = memory();
    expect(writeThisDevice(s, "")).toBe(false);
    expect(readThisDevice(s, "")).toBe(false);
  });
});
