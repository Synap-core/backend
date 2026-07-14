import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it } from "vitest";

let decodeShortLivedAssertion: (typeof import("./federation.js"))["decodeShortLivedAssertion"];

function signedAssertion(options: {
  expiresIn?: number;
  omitExpiry?: boolean;
}) {
  const now = Math.floor(Date.now() / 1_000);
  return jwt.sign(
    {
      iss: "https://issuer.example.test",
      sub: "external-user-1",
      jti: "assertion-1",
      iat: now,
      ...(options.omitExpiry ? {} : { exp: now + (options.expiresIn ?? 300) }),
    },
    "test-secret",
    { algorithm: "HS256" }
  );
}

describe("federated assertion policy", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ decodeShortLivedAssertion } = await import("./federation.js"));
  });

  it("admits a signed assertion with a five-minute lifetime", () => {
    expect(
      decodeShortLivedAssertion(signedAssertion({ expiresIn: 300 }))
    ).not.toBeNull();
  });

  it("rejects a long-lived or non-expiring assertion before JWKS verification", () => {
    expect(
      decodeShortLivedAssertion(signedAssertion({ expiresIn: 301 }))
    ).toBeNull();
    expect(
      decodeShortLivedAssertion(signedAssertion({ omitExpiry: true }))
    ).toBeNull();
  });
});
