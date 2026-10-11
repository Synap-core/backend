import { describe, expect, it } from "vitest";
import {
  approvedIssuerRedirectPrefix,
  toOriginPrefix,
} from "./connect-redirect";

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const APPROVED = "https://api.synap.live";

describe("approvedIssuerRedirectPrefix", () => {
  it("widens the allowlist for the pod's approved issuer", () => {
    expect(
      approvedIssuerRedirectPrefix(
        jwt({ iss: "https://api.synap.live" }),
        APPROVED
      )
    ).toBe("https://api.synap.live/");
  });

  it("refuses a forged issuer — the key would be sent to the attacker", () => {
    expect(
      approvedIssuerRedirectPrefix(
        jwt({ iss: "https://attacker.example" }),
        APPROVED
      )
    ).toBeNull();
    // prefix confusion
    expect(
      approvedIssuerRedirectPrefix(
        jwt({ iss: "https://api.synap.live.attacker.example" }),
        APPROVED
      )
    ).toBeNull();
  });

  it("widens nothing when the pod has no approved issuer (or the read failed)", () => {
    expect(
      approvedIssuerRedirectPrefix(jwt({ iss: "https://api.synap.live" }), null)
    ).toBeNull();
  });

  it("widens nothing for a missing or malformed assertion", () => {
    expect(approvedIssuerRedirectPrefix("", APPROVED)).toBeNull();
    expect(approvedIssuerRedirectPrefix("not-a-jwt", APPROVED)).toBeNull();
    expect(approvedIssuerRedirectPrefix(jwt({}), APPROVED)).toBeNull();
  });
});

describe("toOriginPrefix", () => {
  it("pins https origins with a trailing slash and refuses http", () => {
    expect(toOriginPrefix("https://a.example/path")).toBe("https://a.example/");
    expect(toOriginPrefix("http://a.example")).toBeNull();
  });
});
