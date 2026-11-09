/**
 * A short name for THIS browser, sent with "Add this device"
 * (`presence.deviceLink.request`'s `label`) so the device that approves can
 * tell which one asks: "iPhone · Safari", "Mac · Chrome", "This device".
 *
 * Pure: it reads the user agent string and, where the browser has it,
 * `navigator.userAgentData` (Chromium), passed in. Device and browser names
 * are proper nouns, never translated; the joiner and the fallback are words
 * of `copy.ts` (`label.join`, `label.unknown`), given by the caller.
 *
 * iPadOS Safari reports itself as a Mac: a "Mac" with a touch screen is an
 * iPad (`touchPoints`).
 */

export type DeviceName =
  | "iPhone"
  | "iPad"
  | "Android phone"
  | "Android tablet"
  | "Mac"
  | "Windows PC"
  | "Linux PC"
  | "Chromebook";

export type BrowserName = "Safari" | "Chrome" | "Firefox" | "Edge";

/** What the browser says about itself. */
export interface BrowserSignals {
  userAgent: string;
  /** `navigator.userAgentData` (Chromium only), when present. */
  userAgentData?: {
    platform?: string | null;
    mobile?: boolean | null;
    brands?: ReadonlyArray<{ brand: string }> | null;
  } | null;
  /** `navigator.maxTouchPoints`: tells an iPad from a Mac. */
  touchPoints?: number | null;
}

export interface DeviceParts {
  device: DeviceName | null;
  browser: BrowserName | null;
}

function deviceOf(s: BrowserSignals): DeviceName | null {
  const ua = s.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) {
    const mobile = s.userAgentData?.mobile ?? /Mobile/.test(ua);
    return mobile ? "Android phone" : "Android tablet";
  }
  if (/CrOS/.test(ua)) return "Chromebook";
  const platform = s.userAgentData?.platform ?? "";
  if (platform === "macOS" || /Macintosh|Mac OS X/.test(ua)) {
    return (s.touchPoints ?? 0) > 1 ? "iPad" : "Mac";
  }
  if (platform === "Windows" || /Windows/.test(ua)) return "Windows PC";
  if (platform === "Chrome OS") return "Chromebook";
  if (platform === "Linux" || /Linux|X11/.test(ua)) return "Linux PC";
  return null;
}

function browserOf(s: BrowserSignals): BrowserName | null {
  const ua = s.userAgent;
  const brands = (s.userAgentData?.brands ?? []).map((b) => b.brand);
  if (brands.includes("Microsoft Edge") || /Edg(e|A|iOS)?\//.test(ua)) {
    return "Edge";
  }
  // Another Chromium browser (Opera, Samsung Internet, Brave says Chrome):
  // never named Chrome when it says it is something else.
  if (brands.includes("Opera") || /OPR\/|SamsungBrowser\//.test(ua)) {
    return null;
  }
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (brands.includes("Google Chrome") || /Chrome\/|CriOS\//.test(ua)) {
    return "Chrome";
  }
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return null;
}

export function deviceParts(signals: BrowserSignals): DeviceParts {
  return { device: deviceOf(signals), browser: browserOf(signals) };
}

/**
 * The label: "{device} · {browser}" when both are known, the device alone,
 * else the fallback ("This device"), also with a browser:
 * "This device · Firefox".
 */
export function deviceLabel(
  parts: DeviceParts,
  words: {
    join: (args: { device: string; browser: string }) => string;
    unknown: string;
  }
): string {
  const device = parts.device ?? words.unknown;
  return parts.browser
    ? words.join({ device, browser: parts.browser })
    : device;
}

/** This browser's signals, or null outside a browser. */
export function browserSignals(): BrowserSignals | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & {
    userAgentData?: BrowserSignals["userAgentData"];
  };
  return {
    userAgent: nav.userAgent ?? "",
    userAgentData: nav.userAgentData ?? null,
    touchPoints: nav.maxTouchPoints ?? 0,
  };
}
