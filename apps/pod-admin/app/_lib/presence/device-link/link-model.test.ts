/**
 * "Add this device", the new device's panel: each state, and the line every
 * presence surface holds: a failed READ is never "declined" or "expired".
 */
import { describe, expect, it, vi } from "vitest";
import type { KratosFlow } from "../../../../lib/kratos-flow";
import {
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_MISMATCH,
  PRESENCE_DEVICE_LINK_NO_SESSION,
  PRESENCE_DEVICE_LINK_RATE,
} from "@synap-core/types/presence";
import {
  INITIAL_LINK_STATE,
  linkReducer,
  openRequestId,
  reasonCodeOf,
  registrationEvent,
  shouldPoll,
  startPasskeyStep,
  timeLeft,
  type LinkEvent,
  type LinkState,
} from "./link-model";

const ID = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const IN_5_MIN = new Date(T0 + 300_000).toISOString();

const run = (...events: LinkEvent[]): LinkState =>
  events.reduce(linkReducer, INITIAL_LINK_STATE);

const asked: LinkEvent = {
  type: "asked",
  answer: { needed: true, id: ID, number: "42", expiresAt: IN_5_MIN },
};

describe("linkReducer: asking", () => {
  it("a person with no factor yet goes straight to creating the passkey (nothing to approve)", () => {
    expect(run({ type: "asked", answer: { needed: false } })).toEqual({
      kind: "approved",
      id: null,
      expiresAt: null,
    });
  });

  it("a person with a factor waits, showing the number", () => {
    expect(run(asked)).toEqual({
      kind: "waiting",
      id: ID,
      number: "42",
      expiresAt: IN_5_MIN,
    });
  });

  it("each refusal of the ask has its own state; anything else is a failed request", () => {
    const failed = (reasonCode: string | null) =>
      run({ type: "ask-failed", reasonCode, detail: "503" });
    expect(failed(PRESENCE_DEVICE_LINK_RATE)).toEqual({ kind: "rate-limited" });
    expect(failed(PRESENCE_DEVICE_LINK_NO_SESSION)).toEqual({
      kind: "no-session",
    });
    expect(failed(null)).toEqual({ kind: "request-failed", detail: "503" });
  });
});

describe("linkReducer: waiting", () => {
  it("follows the pod's status", () => {
    expect(
      run(asked, { type: "status", status: "pending", expiresAt: IN_5_MIN })
    ).toMatchObject({ kind: "waiting", number: "42" });
    expect(
      run(asked, { type: "status", status: "approved", expiresAt: IN_5_MIN })
    ).toEqual({ kind: "approved", id: ID, expiresAt: IN_5_MIN });
    expect(
      run(asked, { type: "status", status: "declined", expiresAt: IN_5_MIN })
    ).toEqual({ kind: "declined" });
    expect(
      run(asked, { type: "status", status: "expired", expiresAt: IN_5_MIN })
    ).toEqual({ kind: "expired" });
    expect(
      run(asked, { type: "status", status: "replaced", expiresAt: IN_5_MIN })
    ).toEqual({ kind: "expired" });
    expect(
      run(asked, { type: "status", status: "redeemed", expiresAt: IN_5_MIN })
    ).toEqual({ kind: "done" });
  });

  it("GUARDRAIL: a failed status read keeps the number and says so; it is never declined", () => {
    const s = run(asked, {
      type: "status-failed",
      reasonCode: null,
      detail: "Failed to fetch",
    });
    expect(s).toEqual({
      kind: "status-failed",
      id: ID,
      number: "42",
      expiresAt: IN_5_MIN,
      detail: "Failed to fetch",
    });
    // The poll goes on, and a good read brings the wait back.
    expect(shouldPoll(s)).toBe(ID);
    expect(
      linkReducer(s, {
        type: "status",
        status: "pending",
        expiresAt: IN_5_MIN,
      })
    ).toMatchObject({ kind: "waiting", number: "42" });
  });

  it("GONE means the pod no longer knows the request: ask again", () => {
    expect(
      run(asked, {
        type: "status-failed",
        reasonCode: PRESENCE_DEVICE_LINK_GONE,
        detail: null,
      })
    ).toEqual({ kind: "expired" });
  });

  it("the clock ends a wait past its time, not before", () => {
    expect(run(asked, { type: "clock", now: T0 + 299_000 })).toMatchObject({
      kind: "waiting",
    });
    expect(run(asked, { type: "clock", now: T0 + 300_000 })).toEqual({
      kind: "expired",
    });
  });
});

describe("linkReducer: creating the passkey", () => {
  const approved: LinkEvent = {
    type: "status",
    status: "approved",
    expiresAt: IN_5_MIN,
  };

  it("approved → creating → done", () => {
    expect(run(asked, approved, { type: "create" })).toEqual({
      kind: "creating",
      id: ID,
      expiresAt: IN_5_MIN,
    });
    expect(
      run(asked, approved, { type: "create" }, { type: "created" })
    ).toEqual({ kind: "done" });
  });

  it("a closed prompt goes back to the press; a failure keeps the approval for another try", () => {
    expect(
      run(
        asked,
        approved,
        { type: "create" },
        { type: "create-cancelled", detail: "NotAllowedError: not allowed" }
      )
    ).toEqual({
      kind: "approved",
      id: ID,
      expiresAt: IN_5_MIN,
      closed: { detail: "NotAllowedError: not allowed" },
    });
    const failed = run(
      asked,
      approved,
      { type: "create" },
      { type: "create-failed", reason: "exists", detail: "InvalidStateError" }
    );
    expect(failed).toMatchObject({ kind: "create-failed", reason: "exists" });
    expect(linkReducer(failed, { type: "create" })).toMatchObject({
      kind: "creating",
      id: ID,
    });
  });

  it("an approval nobody redeemed in time runs out", () => {
    expect(run(asked, approved, { type: "clock", now: T0 + 300_000 })).toEqual({
      kind: "expired",
    });
  });

  it("with nothing to approve, there is no clock", () => {
    expect(
      run(
        { type: "asked", answer: { needed: false } },
        { type: "clock", now: T0 + 10 ** 9 }
      )
    ).toMatchObject({ kind: "approved", id: null });
  });

  it("a late status after the person moved on changes nothing", () => {
    const creating = run(asked, approved, { type: "create" });
    expect(
      linkReducer(creating, {
        type: "status",
        status: "declined",
        expiresAt: IN_5_MIN,
      })
    ).toBe(creating);
  });
});

describe("helpers", () => {
  it("reasonCodeOf reads the tRPC error's data", () => {
    expect(
      reasonCodeOf({ data: { reasonCode: PRESENCE_DEVICE_LINK_MISMATCH } })
    ).toBe(PRESENCE_DEVICE_LINK_MISMATCH);
    expect(reasonCodeOf(new Error("x"))).toBeNull();
    expect(reasonCodeOf(null)).toBeNull();
  });

  it("the open request is the one to decline on Cancel", () => {
    expect(openRequestId(run(asked))).toBe(ID);
    expect(
      openRequestId(run({ type: "asked", answer: { needed: false } }))
    ).toBeNull();
    expect(openRequestId({ kind: "done" })).toBeNull();
  });

  it("only a waiting request is polled", () => {
    expect(shouldPoll(run(asked))).toBe(ID);
    expect(
      shouldPoll(
        run(asked, { type: "status", status: "approved", expiresAt: IN_5_MIN })
      )
    ).toBeNull();
  });

  it("timeLeft: minutes rounded up, then seconds, then nothing", () => {
    expect(timeLeft(IN_5_MIN, T0)).toEqual({ unit: "minutes", n: 5 });
    expect(timeLeft(IN_5_MIN, T0 + 1_000)).toEqual({ unit: "minutes", n: 5 });
    expect(timeLeft(IN_5_MIN, T0 + 241_000)).toEqual({
      unit: "seconds",
      n: 59,
    });
    expect(timeLeft(IN_5_MIN, T0 + 300_000)).toBeNull();
    expect(timeLeft(null, T0)).toBeNull();
  });

  it("registrationEvent: Kratos' answer as the next step", () => {
    expect(
      registrationEvent({ kind: "flow", errors: [], success: true })
    ).toEqual({ type: "created" });
    expect(
      registrationEvent({ kind: "flow", errors: ["refused"], success: false })
    ).toEqual({ type: "create-failed", reason: "refused", detail: "refused" });
    expect(
      registrationEvent({ kind: "flow", errors: [], success: false })
    ).toMatchObject({ type: "create-failed", reason: "failed" });
    expect(registrationEvent({ kind: "refresh_required" })).toEqual({
      type: "reauth",
    });
    expect(registrationEvent({ kind: "redirect", to: "/x" })).toEqual({
      type: "redirect",
      to: "/x",
    });
  });
});

describe("startPasskeyStep: the prompt opens from the press", () => {
  const FLOW = { id: "flow-1", ui: { nodes: [] } } as unknown as KratosFlow;

  it("with the flow held, opens the prompt in the same tick as the press", () => {
    const register = vi.fn(() => Promise.resolve("ok"));
    const readFlow = vi.fn(() => Promise.resolve({ flow: FLOW }));
    void startPasskeyStep({ flow: FLOW }, readFlow, register);
    // Synchronously: no await between the tap and credentials.create.
    expect(register).toHaveBeenCalledWith(FLOW);
    expect(readFlow).not.toHaveBeenCalled();
  });

  it("with none held, reads the flow first, then registers", async () => {
    const register = vi.fn(() => Promise.resolve("ok"));
    const pending = startPasskeyStep(
      null,
      () => Promise.resolve({ flow: FLOW }),
      register
    );
    expect(register).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({
      kind: "registered",
      result: "ok",
    });
    expect(register).toHaveBeenCalledWith(FLOW);
  });

  it("a sign-in with no settings flow signs in again; a failed read rejects", async () => {
    const register = vi.fn(() => Promise.resolve("ok"));
    await expect(
      startPasskeyStep({ signInRequired: true }, vi.fn(), register)
    ).resolves.toEqual({ kind: "reauth" });
    await expect(
      startPasskeyStep(null, () => Promise.reject(new Error("down")), register)
    ).rejects.toThrow("down");
    expect(register).not.toHaveBeenCalled();
  });
});
