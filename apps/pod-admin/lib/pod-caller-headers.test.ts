import { describe, expect, it } from "vitest";
import { forwardedHeaders, podCallerHeaders } from "./pod-caller-headers";

describe("forwardedHeaders", () => {
  it("relays the client address headers Caddy set", () => {
    const h = new Headers({
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "198.51.100.7",
      cookie: "ory_kratos_session=s",
      host: "pod-admin.example",
    });
    expect(forwardedHeaders(h)).toEqual({
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "198.51.100.7",
    });
  });

  it("sends nothing it did not receive (never an invented address)", () => {
    expect(forwardedHeaders(new Headers())).toEqual({});
  });
});

describe("podCallerHeaders", () => {
  it("adds the session cookie to the address", () => {
    const h = new Headers({
      "x-forwarded-for": "198.51.100.7",
      cookie: "ory_kratos_session=s",
    });
    expect(podCallerHeaders(h)).toEqual({
      Cookie: "ory_kratos_session=s",
      "x-forwarded-for": "198.51.100.7",
    });
  });
});
