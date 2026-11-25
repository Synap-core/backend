"use client";

/**
 * The this-device marker in the browser (`this-device.ts`): set it where this
 * browser creates or proves with a passkey, and read it where the nudge
 * decides. Mounted readers are told when it is set here, and when another
 * tab sets it (the `storage` event).
 */
import { useEffect, useState } from "react";
import { publicPodUrl } from "../../../../lib/public-pod-url";
import { readThisDevice, thisDeviceKey, writeThisDevice } from "./this-device";

const listeners = new Set<() => void>();

/** The pod's origin; this console's own while the pod URL is not configured. */
function podOrigin(): string {
  return publicPodUrl() || window.location.origin;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** This browser created a passkey for this pod, or proved with one. */
export function rememberThisDevicePasskey(): void {
  if (typeof window === "undefined") return;
  writeThisDevice(storage(), podOrigin());
  for (const listener of listeners) listener();
}

/**
 * Does this browser hold a passkey for this pod, as far as it remembers?
 * Null until mounted (storage is a browser read): unknown asks for nothing.
 */
export function useThisDevicePasskey(): boolean | null {
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => setHeld(readThisDevice(storage(), podOrigin()));
    read();
    listeners.add(read);
    const key = thisDeviceKey(podOrigin());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) read();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return held;
}
