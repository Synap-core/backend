/**
 * "Add this device": the label the new device sends, so the device that
 * approves can tell which one asks. Proper nouns stay as they are; the
 * joiner and the fallback come from the caller (the catalog).
 */
import { describe, expect, it } from "vitest";
import { deviceLabel, deviceParts } from "./device-label";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipadAsMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macFirefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  linuxFirefox:
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
};

const words = {
  join: ({ device, browser }: { device: string; browser: string }) =>
    `${device} · ${browser}`,
  unknown: "This device",
};

const label = (userAgent: string, extra = {}) =>
  deviceLabel(deviceParts({ userAgent, ...extra }), words);

describe("deviceParts / deviceLabel", () => {
  it("names the phone and its browser", () => {
    expect(label(UA.iphoneSafari)).toBe("iPhone · Safari");
    expect(label(UA.iphoneChrome)).toBe("iPhone · Chrome");
    expect(label(UA.androidChrome)).toBe("Android phone · Chrome");
    expect(label(UA.androidTablet)).toBe("Android tablet · Chrome");
  });

  it("an iPad that says it is a Mac is an iPad (it has a touch screen)", () => {
    expect(label(UA.ipadAsMac, { touchPoints: 5 })).toBe("iPad · Safari");
    expect(label(UA.ipadAsMac, { touchPoints: 0 })).toBe("Mac · Safari");
  });

  it("names computers and their browsers", () => {
    expect(label(UA.macChrome)).toBe("Mac · Chrome");
    expect(label(UA.macFirefox)).toBe("Mac · Firefox");
    expect(label(UA.windowsEdge)).toBe("Windows PC · Edge");
    expect(label(UA.linuxFirefox)).toBe("Linux PC · Firefox");
  });

  it("another Chromium browser is never called Chrome", () => {
    expect(deviceParts({ userAgent: UA.opera }).browser).toBeNull();
    expect(label(UA.opera)).toBe("Windows PC");
  });

  it("reads userAgentData where the browser has it", () => {
    expect(
      deviceParts({
        userAgent: "Mozilla/5.0",
        userAgentData: {
          platform: "macOS",
          brands: [{ brand: "Microsoft Edge" }],
        },
      })
    ).toEqual({ device: "Mac", browser: "Edge" });
  });

  it("an unknown device is the fallback, with or without a browser", () => {
    expect(label("")).toBe("This device");
    expect(label("Mozilla/5.0 (Unknown) Firefox/132.0")).toBe(
      "This device · Firefox"
    );
  });
});
