import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  decodeDefinitionCursor,
  decodeInstantCursor,
  decodeRunCursor,
  decodeRunGroupCursor,
  encodeDefinitionCursor,
  encodeInstantCursor,
  encodeRunCursor,
  encodeRunGroupCursor,
} from "./keyset-cursor.js";

const AT = new Date("2026-07-31T00:00:00.000Z");
const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";

describe("keyset cursors", () => {
  it("keeps ids in equal-timestamp definition cursors", () => {
    const first = encodeDefinitionCursor({ at: AT, id: ID_A });
    const second = encodeDefinitionCursor({ at: AT, id: ID_B });

    expect(first).not.toBe(second);
    expect(decodeDefinitionCursor(second)).toEqual({
      at: AT.toISOString(),
      id: ID_B,
    });
  });

  it("keeps flow kind and id in equal-timestamp group cursors", () => {
    const cursor = encodeRunGroupCursor({
      at: AT,
      flowType: "playbook",
      id: ID_B,
    });

    expect(decodeRunGroupCursor(cursor)).toEqual({
      at: AT.toISOString(),
      flowType: "playbook",
      id: ID_B,
    });
  });

  it("keeps flow kind and a non-uuid id in run-feed cursors", () => {
    // Capture / capability runs are keyed by correlationId — not a uuid.
    const cursor = encodeRunCursor({
      at: AT,
      flowType: "capture",
      id: "cap_123",
    });

    expect(decodeRunCursor(cursor)).toEqual({
      at: AT.toISOString(),
      flowType: "capture",
      id: "cap_123",
    });
  });

  it("rejects malformed cursors as a caller error", () => {
    expect(() => decodeDefinitionCursor("not-a-cursor")).toThrow(TRPCError);
    expect(() => decodeRunCursor("not-a-cursor")).toThrow(TRPCError);
  });

  it("keeps microseconds in instant cursors and refuses a non-instant", () => {
    const at = "2026-07-31T00:00:00.123456Z";
    expect(decodeInstantCursor(encodeInstantCursor({ at, id: ID_A }))).toEqual({
      at,
      id: ID_A,
    });
    for (const bad of [
      "2026-07-31T00:00:00.123Z", // milliseconds only
      "2026-02-30T00:00:00.000000Z", // no such day
      "2026-07-31T24:00:00.000000Z",
      "2026-07-31 00:00:00.123456+00",
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({ at: bad, id: ID_A })
      ).toString("base64url");
      expect(() => decodeInstantCursor(cursor), bad).toThrow(TRPCError);
    }
  });
});
