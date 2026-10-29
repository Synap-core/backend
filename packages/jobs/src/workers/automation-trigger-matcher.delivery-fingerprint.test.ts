/**
 * An inbound webhook's fingerprint (the D5 claim that fires a rule once per
 * event) is the SENDER's delivery id when it sends one, scoped by the
 * subscription (pipeline-health W1, finding d0fbdc0e) — and it never reads
 * the stored row's id the dispatcher puts in `data.inboundDeliveryId`, which
 * is unique per delivery and would make every copy of one delivery fire again.
 */
import { describe, it, expect } from "vitest";
import { resolveAutomationEventFingerprintId } from "./automation-trigger-matcher.js";

const EVENT = "external_webhook.received.completed";
const SUB = "sub-1";

function fp(data: Record<string, unknown>) {
  return resolveAutomationEventFingerprintId({
    eventType: EVENT,
    subjectId: SUB,
    data,
  });
}

describe("inbound webhook fingerprint", () => {
  it("one delivery id is one event, even when the body differs", () => {
    const a = fp({ subscriptionId: SUB, payload: { n: 1 }, deliveryId: "d-1" });
    const b = fp({ subscriptionId: SUB, payload: { n: 2 }, deliveryId: "d-1" });
    expect(a).toBe(b);
    expect(a).toBe(`${SUB}:delivery:d-1`);
  });

  it("two delivery ids are two events, even with byte-identical bodies", () => {
    const a = fp({ subscriptionId: SUB, payload: { n: 1 }, deliveryId: "d-1" });
    const b = fp({ subscriptionId: SUB, payload: { n: 1 }, deliveryId: "d-2" });
    expect(a).not.toBe(b);
  });

  it("the same delivery id under another subscription is another event", () => {
    const a = fp({ subscriptionId: SUB, payload: {}, deliveryId: "d-1" });
    const b = fp({ subscriptionId: "sub-2", payload: {}, deliveryId: "d-1" });
    expect(a).not.toBe(b);
  });

  it("the stored row id never changes the fingerprint, whatever the body (null too)", () => {
    for (const payload of [{ n: 1 }, null, "raw text"]) {
      const without = fp({ subscriptionId: SUB, payload });
      const withRow = fp({
        subscriptionId: SUB,
        payload,
        inboundDeliveryId: "row-a",
      });
      const otherRow = fp({
        subscriptionId: SUB,
        payload,
        inboundDeliveryId: "row-b",
      });
      expect(withRow).toBe(without);
      expect(otherRow).toBe(without);
    }
  });

  it("is not vacuous: a different body without a delivery id is a different event", () => {
    expect(fp({ subscriptionId: SUB, payload: { n: 1 } })).not.toBe(
      fp({ subscriptionId: SUB, payload: { n: 2 } })
    );
  });
});
