import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  decodeDefinitionCursor,
  decodeRunGroupCursor,
  encodeDefinitionCursor,
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

  it("rejects malformed cursors as a caller error", () => {
    expect(() => decodeDefinitionCursor("not-a-cursor")).toThrow(TRPCError);
  });
});
