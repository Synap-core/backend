/**
 * The two reads of a write that touches the do-not-contact flag: "sets it
 * only" (a de-escalation the gate applies) and "clears it" (the person's
 * alone). Rules out: a set riding another field or key, a set with a value
 * other than `true`, and a clear missed when it comes as a deletion or as a
 * removed reason or date.
 */
import { describe, expect, it } from "vitest";

import {
  clearsDoNotContact,
  isDoNotContactSetWrite,
} from "./do-not-contact-fields.js";

describe("isDoNotContactSetWrite", () => {
  it("is the flag set to true, with at most its reason and date, and neutral keys", () => {
    expect(
      isDoNotContactSetWrite({ id: "x", properties: { doNotContact: true } })
    ).toBe(true);
    expect(
      isDoNotContactSetWrite({
        id: "x",
        title: undefined,
        deleteProperties: undefined,
        source: "intelligence",
        agentUserId: "a",
        reasoning: "asked to stop",
        properties: {
          doNotContact: true,
          doNotContactReason: "asked to stop",
          doNotContactSince: "2026-11-17",
        },
      })
    ).toBe(true);
  });

  it("is not a set: another value, a missing flag, another field, another key", () => {
    for (const write of [
      { id: "x", properties: { doNotContact: false } },
      { id: "x", properties: { doNotContact: "true" } },
      { id: "x", properties: { doNotContactReason: "asked to stop" } },
      { id: "x", properties: { doNotContact: true, email: "a@b.c" } },
      { id: "x", title: "Renamed", properties: { doNotContact: true } },
      { id: "x", deleteProperties: [], properties: { doNotContact: true } },
      { id: "x", global: true, properties: { doNotContact: true } },
      { id: "x", expectedStatus: null, properties: { doNotContact: true } },
      { id: "x", properties: {} },
      { id: "x" },
      undefined,
    ]) {
      expect(isDoNotContactSetWrite(write), JSON.stringify(write)).toBe(false);
    }
  });
});

describe("clearsDoNotContact", () => {
  it("is a clear: a value other than yes, or any of the three removed", () => {
    for (const write of [
      { properties: { doNotContact: false } },
      { properties: { doNotContact: null } },
      { properties: { doNotContact: "false" } },
      { deleteProperties: ["doNotContact"] },
      { deleteProperties: ["doNotContactReason"] },
      { deleteProperties: ["email", "doNotContactSince"] },
    ]) {
      expect(clearsDoNotContact(write), JSON.stringify(write)).toBe(true);
    }
  });

  it("is not a clear: a set, or a write that does not touch the flag", () => {
    for (const write of [
      { properties: { doNotContact: true } },
      { properties: { doNotContactReason: "moved on" } },
      { properties: { email: "a@b.c" } },
      { deleteProperties: ["email"] },
      {},
    ]) {
      expect(clearsDoNotContact(write), JSON.stringify(write)).toBe(false);
    }
  });
});
