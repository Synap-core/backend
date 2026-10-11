/**
 * The device door's START is budgeted per IP (`device_auth`, RFC 8628 §5.1):
 * an unauthenticated caller must not share the Bearer-keyed `crud` budget,
 * and a random Bearer must not buy a fresh one (the limiter is IP-only).
 * Polling stays in `crud` — it is paced by `interval`/`slow_down`.
 */
import { describe, it, expect } from "vitest";
import {
  classifyRateLimitPath,
  getDeviceAuthRateConfig,
} from "./rate-limit-classes.js";

describe("device_auth rate class", () => {
  it("classifies the device-flow start on both hub mounts", () => {
    expect(classifyRateLimitPath("/api/hub/setup/device", "POST")).toBe(
      "device_auth"
    );
    expect(
      classifyRateLimitPath("/api/hub-protocol/setup/device", "POST")
    ).toBe("device_auth");
  });

  it("leaves collection and neighbours alone", () => {
    expect(classifyRateLimitPath("/api/hub/setup/device/token", "POST")).toBe(
      "crud"
    );
    expect(classifyRateLimitPath("/api/hub/setup/agent", "POST")).toBe("crud");
  });

  it("defaults to 10 starts per 10 minutes per IP", () => {
    expect(getDeviceAuthRateConfig()).toMatchObject({
      max: 10,
      windowMs: 600_000,
    });
  });
});
