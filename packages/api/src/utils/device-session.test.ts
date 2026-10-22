/**
 * The step-up clock read from a request's context, outside any request
 * scope: a device and a Kratos session held as a token are asked for a
 * recent sign-in; a browser's cookie session and a keyed caller are not.
 * (The scope half is in `middleware/app-session.test.ts`; the real doors in
 * `services/person-device-token.pglite.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import {
  assertFreshAuthentication,
  STEP_UP_WINDOW_MS,
} from "./device-session.js";

const ago = (ms: number) => new Date(Date.now() - ms);
const refused = (ctx: Parameters<typeof assertFreshAuthentication>[0]) => {
  try {
    assertFreshAuthentication(ctx);
    return false;
  } catch {
    return true;
  }
};

describe("assertFreshAuthentication from the context", () => {
  it("a device past the window is refused; within it, not", () => {
    const device = (authTime: Date | null) => ({
      sessionKind: "person_device",
      session: { device: { id: "d", authTime } },
    });
    expect(refused(device(ago(STEP_UP_WINDOW_MS + 60_000)))).toBe(true);
    expect(refused(device(null))).toBe(true);
    expect(refused(device(ago(60_000)))).toBe(false);
  });

  it("a Kratos session TOKEN: its clock is the last credential presented AT the pod", () => {
    const token = (
      methods: Array<{ method: string; completed_at?: string }> | undefined
    ) => ({
      sessionKind: "kratos_token",
      session: { id: "s", authentication_methods: methods },
    });
    const at = (ms: number) => ago(ms).toISOString();
    const stale = at(STEP_UP_WINDOW_MS + 60_000);
    expect(refused(token([{ method: "password", completed_at: stale }]))).toBe(
      true
    );
    expect(refused(token(undefined))).toBe(true);
    expect(
      refused(token([{ method: "password", completed_at: "not a date" }]))
    ).toBe(true);
    expect(
      refused(token([{ method: "password", completed_at: at(60_000) }]))
    ).toBe(false);
    expect(
      refused(token([{ method: "webauthn", completed_at: at(60_000) }]))
    ).toBe(false);
    // A federated sign-in (Synap Cloud) may be silent: it never sets the clock.
    expect(refused(token([{ method: "oidc", completed_at: at(60_000) }]))).toBe(
      true
    );
    expect(
      refused(
        token([
          { method: "password", completed_at: stale },
          { method: "oidc", completed_at: at(60_000) },
        ])
      )
    ).toBe(true);
  });

  it("CONTROL — a browser cookie session, however old, and no session are not asked", () => {
    expect(
      refused({
        sessionKind: "kratos",
        session: {
          id: "s",
          authentication_methods: [
            {
              method: "password",
              completed_at: ago(10 * 86_400_000).toISOString(),
            },
          ],
        },
      })
    ).toBe(false);
    expect(refused(null)).toBe(false);
  });
});
