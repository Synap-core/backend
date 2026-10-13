import { describe, expect, it } from "vitest";
import { forwardedHeaders, podCallerHeaders } from "./pod-caller-headers";

describe("forwardedHeaders", () => {
  it("relays the client address Caddy set, and never X-Real-IP", () => {
    const h = new Headers({
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "203.0.113.1",
      cookie: "ory_kratos_session=s",
      host: "pod-admin.example",
    });
    expect(forwardedHeaders(h)).toEqual({ "x-forwarded-for": "198.51.100.7" });
  });

  it("relays only the first entry of a list, trimmed", () => {
    const h = new Headers({
      "x-forwarded-for": "  2001:db8::7 , 10.0.0.1, 127.0.0.1",
    });
    expect(forwardedHeaders(h)).toEqual({ "x-forwarded-for": "2001:db8::7" });
  });

  it("drops a first entry that is not an IP address", () => {
    for (const bad of ["unknown", "localhost", "", " , 1.2.3.4", "1.2.3.4.5"]) {
      expect(forwardedHeaders(new Headers({ "x-forwarded-for": bad }))).toEqual(
        {}
      );
    }
  });

  it("sends nothing it did not receive (never an invented address)", () => {
    expect(forwardedHeaders(new Headers())).toEqual({});
    expect(forwardedHeaders(new Headers({ "x-real-ip": "1.2.3.4" }))).toEqual(
      {}
    );
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
