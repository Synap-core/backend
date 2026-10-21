/**
 * `prompt=login` / `max_age` (consent.ts `reauthenticationRequired`): a
 * Synap app (first party) gets the step-up window as a floor; ANY OTHER
 * client gets OIDC as written — `prompt=login` / `max_age=0` need a sign-in
 * made after its authorize request (the signed `auth_req` /authorize
 * stamps), `max_age=N` one within N seconds.
 */
import { describe, expect, it } from "vitest";
import {
  reauthenticationRequired,
  signAuthRequestTime,
  verifyAuthRequestTime,
} from "./consent.js";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo);

describe("reauthenticationRequired", () => {
  it("nothing asked: never", () => {
    expect(reauthenticationRequired({}, at(10 * 60 * MIN), "dcr", NOW)).toBe(
      false
    );
  });

  it("a Synap app: prompt=login and max_age=0 accept a sign-in within 5 minutes", () => {
    for (const p of [{ prompt: "login" }, { maxAge: 0 }]) {
      expect(reauthenticationRequired(p, at(4 * MIN), "first_party", NOW)).toBe(
        false
      );
      expect(reauthenticationRequired(p, at(6 * MIN), "first_party", NOW)).toBe(
        true
      );
    }
  });

  for (const clientKind of ["dcr", "cimd", "app"]) {
    describe(`a third-party client (${clientKind})`, () => {
      const requestedAt = NOW - 30_000;
      const authRequest = signAuthRequestTime(requestedAt);

      it("prompt=login / max_age=0: a sign-in from BEFORE the request is not enough, even one minute old", () => {
        for (const p of [{ prompt: "login" }, { maxAge: 0 }]) {
          expect(
            reauthenticationRequired(
              { ...p, authRequest },
              at(60_000),
              clientKind,
              NOW
            )
          ).toBe(true);
        }
      });

      it("prompt=login / max_age=0: a sign-in made AFTER the request passes", () => {
        for (const p of [{ prompt: "login" }, { maxAge: 0 }]) {
          expect(
            reauthenticationRequired(
              { ...p, authRequest },
              at(10_000),
              clientKind,
              NOW
            )
          ).toBe(false);
        }
      });

      it("no request time, or a forged one: sign in again", () => {
        const forged = `${NOW - 60 * MIN}.${authRequest.split(".")[1]}`;
        for (const stamp of [undefined, "", forged, "1.x"]) {
          expect(
            reauthenticationRequired(
              { prompt: "login", authRequest: stamp },
              at(1_000),
              clientKind,
              NOW
            )
          ).toBe(true);
        }
      });

      it("max_age=60 has no 5-minute floor", () => {
        expect(
          reauthenticationRequired({ maxAge: 60 }, at(2 * MIN), clientKind, NOW)
        ).toBe(true);
        expect(
          reauthenticationRequired({ maxAge: 60 }, at(30_000), clientKind, NOW)
        ).toBe(false);
      });
    });
  }
});

describe("the signed request time", () => {
  it("round-trips, and refuses a stale or future stamp", () => {
    expect(verifyAuthRequestTime(signAuthRequestTime(NOW), NOW)).toBe(NOW);
    expect(
      verifyAuthRequestTime(signAuthRequestTime(NOW - 2 * 60 * MIN), NOW)
    ).toBeNull();
    expect(
      verifyAuthRequestTime(signAuthRequestTime(NOW + 60_000), NOW)
    ).toBeNull();
  });
});
