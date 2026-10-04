import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_DOOR_COPY,
  RECOVERY_NO_DOORS_COPY,
  operatorResetCommand,
  operatorResetMessage,
  recoveryCodesMark,
} from "./index.js";

/** Shaped the way the pod's `/status` builds it: `set` is `remaining > 0`. */
function wire(remaining: number, total: number = RECOVERY_CODE_COUNT) {
  return { set: remaining > 0, remaining, total };
}

describe("recoveryCodesMark", () => {
  it("never made → warning 'Not set'", () => {
    expect(recoveryCodesMark(wire(0, 0))).toEqual({
      tone: "warning",
      glyph: "alert",
      label: "Not set",
    });
  });

  // The discriminating row: the pod sends `set: false` for a used-up batch,
  // so a rule that reads `set` first says "Not set" here.
  it("a used-up batch (set:false, total>0) → error 'None left', not 'Not set'", () => {
    expect(recoveryCodesMark(wire(0, 10))).toEqual({
      tone: "error",
      glyph: "alert",
      label: "None left",
    });
  });

  it("≤ 2 left → warning, and always says 'N of M'", () => {
    expect(recoveryCodesMark(wire(2))).toEqual({
      tone: "warning",
      glyph: "alert",
      label: "2 of 10 left",
    });
    expect(recoveryCodesMark(wire(1))).toMatchObject({ tone: "warning", label: "1 of 10 left" });
  });

  it("3+ left → success 'N of M left'", () => {
    expect(recoveryCodesMark(wire(3))).toEqual({
      tone: "success",
      glyph: "check",
      label: "3 of 10 left",
    });
    expect(recoveryCodesMark(wire(10))).toMatchObject({ tone: "success", label: "10 of 10 left" });
  });

  it("returns tokens, never colours", () => {
    for (const r of [0, 1, 2, 3, 10]) {
      const m = recoveryCodesMark(wire(r, r === 0 ? 0 : 10));
      expect(m.tone).not.toMatch(/#|rgb|var\(/);
    }
  });
});

describe("RECOVERY_DOOR_COPY", () => {
  it("covers every door the pod reports, plus the Cloud-account reset", () => {
    // Keys of RecoveryDoors — a new door without copy fails here.
    const podDoors = ["recoveryCode", "email", "cloud"];
    for (const k of [...podDoors, "cloudAccountReset"]) {
      const copy = RECOVERY_DOOR_COPY[k as keyof typeof RECOVERY_DOOR_COPY];
      expect(copy?.title.length, k).toBeGreaterThan(0);
      expect(copy?.body.length, k).toBeGreaterThan(0);
      // One line each.
      expect(copy!.body).not.toContain("\n");
    }
    expect(Object.keys(RECOVERY_DOOR_COPY).sort()).toEqual(
      [...podDoors, "cloudAccountReset"].sort()
    );
  });

  it("the no-doors title is the agreed sentence", () => {
    expect(RECOVERY_NO_DOORS_COPY.title).toBe(
      "This pod has no way to recover your account yet"
    );
  });
});

describe("operator reset message", () => {
  it("carries the command, with a placeholder for a blank email", () => {
    expect(operatorResetCommand(" a@b.co ")).toBe("synap users reset-password a@b.co");
    expect(operatorResetCommand("")).toBe("synap users reset-password <email>");
    const msg = operatorResetMessage("a@b.co", "pod.example.com");
    expect(msg).toContain("synap users reset-password a@b.co");
    expect(msg).toContain("pod.example.com");
  });
});
