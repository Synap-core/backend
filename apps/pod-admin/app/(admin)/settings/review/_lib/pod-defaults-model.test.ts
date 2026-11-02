import { describe, expect, it } from "vitest";
import { dialState, podDefaultsManageable } from "./pod-defaults-model";

const idle = { isPending: false, variables: undefined };

describe("a pod default dial", () => {
  it("a failed read is failed, never an off switch", () => {
    expect(
      dialState({ isLoading: false, isError: true, data: undefined }, idle)
    ).toEqual({ kind: "failed" });
  });

  it("loading until the pod answers", () => {
    expect(
      dialState({ isLoading: true, isError: false, data: undefined }, idle)
    ).toEqual({ kind: "loading" });
  });

  it("shows the pod's answer, and the pick while it saves", () => {
    const read = {
      isLoading: false,
      isError: false,
      data: { enabled: true, canManage: true },
    };
    expect(dialState(read, idle)).toEqual({
      kind: "ready",
      on: true,
      canManage: true,
      saving: false,
    });
    expect(
      dialState(read, { isPending: true, variables: { enabled: false } })
    ).toMatchObject({ on: false, saving: true });
  });
});

describe("who may change the defaults", () => {
  it("reads whichever dial answered", () => {
    const failed = { isLoading: false, isError: true, data: undefined };
    const member = {
      isLoading: false,
      isError: false,
      data: { enabled: true, canManage: false },
    };
    expect(podDefaultsManageable(failed, member)).toBe(false);
    expect(podDefaultsManageable(failed, failed)).toBeNull();
  });
});
