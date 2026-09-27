import { describe, expect, it } from "vitest";
import { paramOwedSlots, paramValueFromAnswer } from "./param-slots.js";

describe("a credential param slot never takes the secret as an answer", () => {
  const [slot] = paramOwedSlots(
    [{ name: "api_token", type: "text", required: true } as never],
    "Deploy",
    "2026-09-27T00:00:00.000Z"
  );

  it("is filed without an ask", () => {
    expect(slot.ask).toBeUndefined();
    expect(slot.paramName).toBe("api_token");
  });

  it("refuses a typed secret before anything is written", () => {
    const r = paramValueFromAnswer(slot, { type: "text" }, "sk_live_123");
    expect(r.status).toBe("invalid");
  });

  it("an ordinary param still writes its value", () => {
    const [plain] = paramOwedSlots(
      [{ name: "topic", type: "text", required: true } as never],
      "Deploy",
      "2026-09-27T00:00:00.000Z"
    );
    expect(paramValueFromAnswer(plain, { type: "text" }, "AI")).toEqual({
      status: "value",
      name: "topic",
      value: "AI",
    });
  });
});
