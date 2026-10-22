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

  it("a Kratos session TOKEN past the window is refused; within it, not", () => {
    const token = (authenticatedAt: string | undefined) => ({
      sessionKind: "kratos_token",
      session: { id: "s", authenticated_at: authenticatedAt },
    });
    expect(refused(token(ago(STEP_UP_WINDOW_MS + 60_000).toISOString()))).toBe(
      true
    );
    expect(refused(token(undefined))).toBe(true);
    expect(refused(token("not a date"))).toBe(true);
    expect(refused(token(ago(60_000).toISOString()))).toBe(false);
  });

  it("CONTROL — a browser cookie session, however old, and no session are not asked", () => {
    expect(
      refused({
        sessionKind: "kratos",
        session: {
          id: "s",
          authenticated_at: ago(10 * 86_400_000).toISOString(),
        },
      })
    ).toBe(false);
    expect(refused(null)).toBe(false);
  });
});
