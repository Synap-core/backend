import { describe, expect, it } from "vitest";
import { isPhone } from "./platform";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  firefoxAndroid:
    "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
};

describe("isPhone", () => {
  it.each([
    ["iPhone Safari", UA.iphone],
    ["Android Chrome phone", UA.androidPhone],
    ["Firefox on an Android phone", UA.firefoxAndroid],
  ])("%s is a phone", (_label, ua) => {
    expect(isPhone(ua)).toBe(true);
  });

  it.each([
    ["Android tablet (no Mobile token)", UA.androidTablet],
    ["iPad (says Mobile, is a tablet)", UA.ipad],
    ["desktop Safari", UA.macSafari],
    ["desktop Chrome", UA.windowsChrome],
    ["empty string (server, or no navigator)", ""],
  ])("%s is not a phone", (_label, ua) => {
    expect(isPhone(ua)).toBe(false);
  });

  it("trusts the browser's own userAgentData.mobile over the string", () => {
    expect(isPhone(UA.windowsChrome, true)).toBe(true);
    expect(isPhone(UA.androidPhone, false)).toBe(false);
  });
});
