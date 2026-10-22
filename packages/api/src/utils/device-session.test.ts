/**
 * The step-up clock: a device read from the request's context (outside any
 * request scope), and the time a consent hands a device, which only a
 * credential presented AT this pod sets. (The real doors are driven in
 * `services/person-device-token.pglite.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import {
  assertFreshAuthentication,
  kratosCredentialTime,
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

  it("CONTROL — a Kratos session, however old, and no session are not asked", () => {
    expect(refused({ sessionKind: "kratos", session: {} })).toBe(false);
    expect(refused(null)).toBe(false);
  });
});

describe("kratosCredentialTime — only a credential presented at the pod", () => {
  const at = (ms: number) => ago(ms).toISOString();

  it("is the latest pod credential", () => {
    const t = kratosCredentialTime({
      authentication_methods: [
        { method: "password", completed_at: at(3_600_000) },
        { method: "webauthn", completed_at: at(60_000) },
      ],
    });
    expect(Date.now() - t!.getTime()).toBeLessThan(61_000);
  });

  it("a federated sign-in (Synap Cloud) never sets it, even when it is the latest", () => {
    expect(
      kratosCredentialTime({
        authentication_methods: [{ method: "oidc", completed_at: at(10_000) }],
      })
    ).toBeNull();
    const t = kratosCredentialTime({
      authentication_methods: [
        { method: "password", completed_at: at(3_600_000) },
        { method: "oidc", completed_at: at(10_000) },
      ],
    });
    expect(Date.now() - t!.getTime()).toBeGreaterThan(3_500_000);
  });

  it("unknown is null: no methods, an unreadable time, a recovery", () => {
    expect(kratosCredentialTime(null)).toBeNull();
    expect(kratosCredentialTime({})).toBeNull();
    expect(
      kratosCredentialTime({
        authentication_methods: [{ method: "password", completed_at: "x" }],
      })
    ).toBeNull();
    expect(
      kratosCredentialTime({
        authentication_methods: [
          { method: "link_recovery", completed_at: at(10_000) },
        ],
      })
    ).toBeNull();
  });
});
