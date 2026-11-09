/**
 * "Add this device", the approving side: a failed read is never "nobody
 * asks", a request past its time is not offered, and each answer leaves the
 * receipt the pod's refusal names.
 */
import { describe, expect, it } from "vitest";
import {
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_MISMATCH,
  PRESENCE_DEVICE_LINK_SELF,
  PRESENCE_REQUIRED,
} from "@synap-core/types/presence";
import {
  approveReceipt,
  declineReceipt,
  receiptIsFailure,
  requestsShown,
  requestsView,
  type PendingDeviceLink,
} from "./requests-model";

const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const row = (over: Partial<PendingDeviceLink> = {}): PendingDeviceLink => ({
  id: "11111111-1111-4111-8111-111111111111",
  label: "iPhone · Safari",
  expiresAt: at(300_000),
  choices: ["17", "42", "88"],
  ...over,
});

const read = (
  data: PendingDeviceLink[] | undefined,
  extra: { isLoading?: boolean; error?: unknown } = {}
) => ({
  data,
  isLoading: extra.isLoading ?? false,
  error: extra.error ?? null,
});

describe("requestsView", () => {
  it("a failed read is failed, even with rows read before", () => {
    expect(
      requestsView(read([row()], { error: new Error("503") }), T0)
    ).toEqual({ kind: "failed" });
  });

  it("loading is loading, never an empty list", () => {
    expect(requestsView(read(undefined, { isLoading: true }), T0)).toEqual({
      kind: "loading",
    });
  });

  it("each request with its minutes left, rounded up", () => {
    expect(requestsView(read([row()]), T0 + 1_000)).toEqual({
      kind: "ready",
      rows: [
        {
          id: row().id,
          label: "iPhone · Safari",
          minutesLeft: 5,
          choices: ["17", "42", "88"],
        },
      ],
    });
    expect(
      requestsView(read([row({ expiresAt: at(20_000) })]), T0)
    ).toMatchObject({ rows: [{ minutesLeft: 1 }] });
  });

  it("a request past its time is not offered", () => {
    expect(requestsView(read([row({ expiresAt: at(-1) })]), T0)).toEqual({
      kind: "ready",
      rows: [],
    });
  });
});

describe("requestsShown", () => {
  it("rows show everywhere; nothing shows when nobody asks", () => {
    const rows = requestsView(read([row()]), T0);
    expect(requestsShown(rows, "banner")).toBe("rows");
    expect(requestsShown(rows, "page")).toBe("rows");
    const none = requestsView(read([]), T0);
    expect(requestsShown(none, "banner")).toBeNull();
    expect(requestsShown(none, "page")).toBeNull();
  });

  it("GUARDRAIL: a failed read shows on the Security page only, never as a banner everywhere", () => {
    expect(requestsShown({ kind: "failed" }, "page")).toBe("failed");
    expect(requestsShown({ kind: "failed" }, "banner")).toBeNull();
    expect(requestsShown({ kind: "loading" }, "page")).toBeNull();
  });
});

describe("receipts", () => {
  const refused = (reasonCode: string) => ({
    ok: false as const,
    error: { message: "no", data: { reasonCode } },
    declined: false,
  });

  it("picking a number: approved, or the pod's reason", () => {
    expect(approveReceipt({ ok: true })).toBe("approved");
    expect(approveReceipt(refused(PRESENCE_DEVICE_LINK_MISMATCH))).toBe(
      "mismatch"
    );
    expect(approveReceipt(refused(PRESENCE_DEVICE_LINK_GONE))).toBe("gone");
    expect(approveReceipt(refused(PRESENCE_DEVICE_LINK_SELF))).toBe("self");
    // A proof the person could not give is a failure, said as one.
    expect(approveReceipt(refused(PRESENCE_REQUIRED))).toBe("failed");
  });

  it("the person closed the passkey dialog: nothing approved, nothing said", () => {
    expect(
      approveReceipt({ ok: false, error: new Error("x"), declined: true })
    ).toBeNull();
  });

  it("Not me", () => {
    expect(declineReceipt({ ok: true })).toBe("declined");
    expect(
      declineReceipt({
        ok: false,
        error: { data: { reasonCode: PRESENCE_DEVICE_LINK_GONE } },
      })
    ).toBe("gone");
    expect(declineReceipt({ ok: false, error: new Error("503") })).toBe(
      "declineFailed"
    );
  });

  it("failures are alerts; the rest is news", () => {
    expect(receiptIsFailure("failed")).toBe(true);
    expect(receiptIsFailure("declineFailed")).toBe(true);
    expect(receiptIsFailure("mismatch")).toBe(false);
    expect(receiptIsFailure("approved")).toBe(false);
  });
});
