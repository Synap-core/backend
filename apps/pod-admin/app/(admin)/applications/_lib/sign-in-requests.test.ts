import { describe, expect, it } from "vitest";
import {
  requestStateLabel,
  signInRequestHref,
  splitSignInRequests,
} from "./sign-in-requests";

const req = (id: string, status: string) => ({
  id,
  displayName: id,
  issuerUrl: "https://issuer.example",
  requestedOrigin: "https://app.example",
  status,
});

describe("sign-in requests", () => {
  it("splits mid-flight from the archive, and leaves pending to Review", () => {
    const { inProgress, archived } = splitSignInRequests([
      req("a", "pending"),
      req("b", "awaiting_local_auth"),
      req("c", "approved"),
      req("d", "expired"),
      req("e", "rejected"),
      req("f", "completed"),
    ]);
    expect(inProgress.map((r) => r.id)).toEqual(["b", "c"]);
    expect(archived.map((r) => r.id)).toEqual(["d", "e", "f"]);
  });

  it("says what is waited on, and that an approval is still finishing", () => {
    expect(requestStateLabel("awaiting_local_auth")).toBe(
      "Waiting for the app"
    );
    expect(requestStateLabel("approved")).toMatch(/· finishing$/);
  });

  it("links to the request's own page", () => {
    expect(signInRequestHref("r 1")).toBe("/connection-requests/r%201");
  });
});
