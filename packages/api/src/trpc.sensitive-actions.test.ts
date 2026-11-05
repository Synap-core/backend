/**
 * The ONE step-up middleware (`requireFreshAuthentication`, so
 * `credentialProcedure`) asks for a proof of presence on a SENSITIVE ACTION
 * (W3 slice 3, founder decision 1): the procedure's path is in
 * `SENSITIVE_ACTIONS`, and the proof is checked against the call's RAW input.
 * A valid proof also stands for the step-up; an everyday credential door keeps
 * the step-up alone.
 *
 * No live Postgres: the gate is a spy, and the middlewares' reads are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  gate: vi.fn(async (_args: unknown) => null as unknown),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  };
});
vi.mock("./services/presence/gate.js", () => ({
  assertPresenceForAction: (args: unknown) => h.gate(args),
}));
vi.mock("./utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("./utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

import { credentialProcedure, router } from "./trpc.js";
import { presenceInput } from "./utils/presence-input.js";

const seen: unknown[] = [];
const app = router({
  apiKeys: router({
    create: credentialProcedure
      .input(presenceInput)
      .input(z.object({ keyName: z.string(), days: z.number().default(30) }))
      .mutation(({ input }) => {
        seen.push(input);
        return "created";
      }),
  }),
  shares: router({
    share: credentialProcedure
      .input(z.object({ id: z.string() }))
      .mutation(() => "shared"),
  }),
});

const PERSON = "11111111-1111-4111-8111-111111111111";
/** A Synap app's device session whose sign-in is an hour old: step-up fails. */
const staleDevice = {
  authenticated: true,
  userId: PERSON,
  sessionKind: "person_device",
  session: { device: { authTime: new Date(Date.now() - 3600_000) } },
} as never;
const browser = {
  authenticated: true,
  userId: PERSON,
  session: { identity: { id: PERSON } },
} as never;
const proof = {
  kind: "device_key",
  challengeId: "00000000-0000-4000-8000-0000000000c1",
  keyId: "00000000-0000-4000-8000-0000000000d1",
  signature: "c2ln",
};

beforeEach(() => {
  h.gate.mockReset();
  h.gate.mockResolvedValue(null);
  seen.length = 0;
});

describe("requireFreshAuthentication: sensitive actions", () => {
  it("GUARDRAIL: a listed path asks the gate with its path, its RAW input and the proof", async () => {
    await app
      .createCaller(browser)
      .apiKeys.create({ keyName: "ci", presence: proof } as never);
    expect(h.gate).toHaveBeenCalledWith({
      userId: PERSON,
      path: "apiKeys.create",
      input: { keyName: "ci", presence: proof },
      proof,
    });
    // The proof never reaches the handler's input.
    expect(seen).toEqual([{ keyName: "ci", days: 30 }]);
  });

  it("a refusal from the gate stops the call", async () => {
    h.gate.mockRejectedValueOnce(new Error("PRESENCE_REQUIRED"));
    await expect(
      app.createCaller(browser).apiKeys.create({ keyName: "ci" } as never)
    ).rejects.toThrow(/PRESENCE_REQUIRED/);
    expect(seen).toEqual([]);
  });

  it("a checked proof stands for the step-up; with none, a stale device session is still refused", async () => {
    await expect(
      app.createCaller(staleDevice).apiKeys.create({ keyName: "ci" } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.gate.mockResolvedValueOnce({ method: "device_key" });
    await expect(
      app
        .createCaller(staleDevice)
        .apiKeys.create({ keyName: "ci", presence: proof } as never)
    ).resolves.toBe("created");
  });

  it("an everyday credential door never asks the gate", async () => {
    await app.createCaller(browser).shares.share({ id: "x" });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("a malformed proof is a bad request, not a missing one", async () => {
    await expect(
      app
        .createCaller(browser)
        .apiKeys.create({ keyName: "ci", presence: { kind: "nope" } } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.gate).not.toHaveBeenCalled();
  });
});
