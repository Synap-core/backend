/**
 * The scope a typed presence code needs (`isBrowserPersonSession`) is opened
 * by the tRPC base procedure for a person's Kratos session, and ONLY for it:
 * never for a Synap app's device token, nor a caller whose context says
 * nothing (a Hub door's caller). Driven through a real procedure built on
 * `publicProcedure`, so removing the middleware fails here.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

import { publicProcedure, router } from "../trpc.js";
import { isBrowserPersonSession } from "./device-session.js";

const probe = router({
  scope: publicProcedure.query(() => isBrowserPersonSession()),
});

const PERSON = "11111111-1111-4111-8111-111111111111";
const call = (ctx: Record<string, unknown>) =>
  probe.createCaller({ userId: PERSON, ...ctx } as never).scope();

describe("the browser-person scope", () => {
  it("a person's Kratos session (pod admin) opens it", async () => {
    await expect(
      call({ authenticated: true, sessionKind: "kratos" })
    ).resolves.toBe(true);
  });

  it("GUARDRAIL: a device token, a silent context, or no sign-in never does", async () => {
    await expect(
      call({ authenticated: true, sessionKind: "person_device" })
    ).resolves.toBe(false);
    await expect(call({ authenticated: true })).resolves.toBe(false);
    await expect(
      call({ authenticated: false, sessionKind: "kratos" })
    ).resolves.toBe(false);
  });

  it("outside any procedure there is no scope", () => {
    expect(isBrowserPersonSession()).toBe(false);
  });
});
