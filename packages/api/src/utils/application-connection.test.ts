import { describe, expect, it } from "vitest";
import {
  buildApplicationConnectionReturnUrl,
  normalizeApplicationCallbackUrl,
  normalizeApplicationOrigin,
} from "./application-connection.js";

describe("application connection URL registration", () => {
  it("requires an exact HTTPS origin and a callback on that origin", () => {
    const origin = normalizeApplicationOrigin("https://crm.example.test");
    expect(origin).toBe("https://crm.example.test");
    expect(
      normalizeApplicationCallbackUrl(
        "https://crm.example.test/auth/pod-return?source=crm",
        origin!
      )
    ).toBe("https://crm.example.test/auth/pod-return?source=crm");
    expect(
      normalizeApplicationCallbackUrl(
        "https://attacker.example.test/auth/pod-return",
        origin!
      )
    ).toBeNull();
  });

  it("accepts only explicit loopback development ports", () => {
    expect(normalizeApplicationOrigin("http://localhost:3030")).toBe(
      "http://localhost:3030"
    );
    expect(normalizeApplicationOrigin("http://localhost")).toBeNull();
    expect(
      normalizeApplicationOrigin("http://crm.example.test:3030")
    ).toBeNull();
  });

  it("adds only a public request correlation to an owner return URL", () => {
    expect(
      buildApplicationConnectionReturnUrl({
        callbackUrl: "https://crm.example.test/auth/pod-return?source=crm",
        requestId: "11111111-1111-4111-8111-111111111111",
      })
    ).toBe(
      "https://crm.example.test/auth/pod-return?source=crm&connection_request=11111111-1111-4111-8111-111111111111"
    );
  });
});
