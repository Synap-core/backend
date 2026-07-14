import { describe, expect, it } from "vitest";
import {
  trustedIssuerCapabilitiesSchema,
  trustedIssuerCapabilitySchema,
} from "./trusted-issuer-capabilities.js";

describe("trusted issuer capability schema", () => {
  it.each(["auth:exchange-user", "identity:link-user", "membership:grant"])(
    "allows the generic issuer capability %s",
    (capability) => {
      expect(trustedIssuerCapabilitySchema.parse(capability)).toBe(capability);
    }
  );

  it("deduplicates capability lists while retaining the compatibility grant", () => {
    expect(
      trustedIssuerCapabilitiesSchema.parse([
        "auth:exchange-user",
        "identity:link-user",
        "membership:grant",
        "membership:activate",
        "membership:grant",
      ])
    ).toEqual([
      "auth:exchange-user",
      "identity:link-user",
      "membership:grant",
      "membership:activate",
    ]);
  });

  it("rejects unknown issuer capabilities", () => {
    expect(
      trustedIssuerCapabilitiesSchema.safeParse(["root:everything"]).success
    ).toBe(false);
  });
});
