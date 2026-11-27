import { describe, expect, it } from "vitest";
import {
  dialState,
  floorDial,
  floorSave,
  floorsStillAsking,
  parameterValue,
  podDefaultsManageable,
  settingState,
  settingsOf,
  parseSetting,
} from "./pod-defaults-model";

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

const KINDS = "@agent-defines-kinds";
const STRUCTURE = "@agent-builds-structure";
const HOURS = "governance.own_work_fresh_hours";
const floorsRead = {
  isLoading: false,
  isError: false,
  data: {
    families: [
      { pattern: KINDS, enabled: true },
      { pattern: STRUCTURE, enabled: false },
    ],
    settings: [
      {
        key: HOURS,
        value: 24,
        min: 1,
        max: 168,
        parameterOf: "@own-organise",
      },
      {
        key: "governance.project_evidence_min",
        value: 5,
        min: 0,
        max: 50,
        parameterOf: null,
      },
    ],
    canManage: true,
  },
};

describe("a floor family's switch", () => {
  it("reads its own family from the shared read", () => {
    expect(dialState(floorDial(floorsRead, KINDS), idle)).toMatchObject({
      kind: "ready",
      on: true,
    });
    expect(dialState(floorDial(floorsRead, STRUCTURE), idle)).toMatchObject({
      kind: "ready",
      on: false,
    });
  });

  it("a family the pod did not answer for, or a failed read, is failed, never off", () => {
    expect(dialState(floorDial(floorsRead, "@other"), idle)).toEqual({
      kind: "failed",
    });
    expect(
      dialState(
        floorDial({ isLoading: false, isError: true, data: undefined }, KINDS),
        idle
      )
    ).toEqual({ kind: "failed" });
  });

  it("a save shows only on the row it switches", () => {
    const saving = {
      isPending: true,
      variables: { pattern: STRUCTURE, enabled: true },
    };
    expect(
      dialState(floorDial(floorsRead, STRUCTURE), floorSave(saving, STRUCTURE))
    ).toMatchObject({ on: true, saving: true });
    expect(
      dialState(floorDial(floorsRead, KINDS), floorSave(saving, KINDS))
    ).toMatchObject({ on: true, saving: false });
  });
});

describe("a governance number", () => {
  it("reads its value and range; a missing one is failed, never a guessed default", () => {
    expect(settingState(floorsRead, HOURS)).toEqual({
      kind: "ready",
      value: 24,
      min: 1,
      max: 168,
      canManage: true,
    });
    expect(settingState(floorsRead, "governance.other")).toEqual({
      kind: "failed",
    });
    expect(settingState({ isLoading: true, isError: false }, HOURS)).toEqual({
      kind: "loading",
    });
  });

  it("takes only a whole number in its range; an empty field is no value, not 0", () => {
    const limits = { min: 0, max: 50 };
    expect(parseSetting("12", limits)).toBe(12);
    expect(parseSetting("0", limits)).toBe(0);
    expect(parseSetting("", limits)).toBeNull();
    expect(parseSetting("51", limits)).toBeNull();
    expect(parseSetting("2.5", limits)).toBeNull();
    expect(parseSetting("-1", limits)).toBeNull();
  });
});

describe("where a governance number is drawn", () => {
  it("under the switch it is a parameter of, or on its own", () => {
    expect(settingsOf(floorsRead, "@own-organise").map((s) => s.key)).toEqual(
      [HOURS]
    );
    expect(settingsOf(floorsRead, null).map((s) => s.key)).toEqual([
      "governance.project_evidence_min",
    ]);
  });

  it("the switch's sentence reads its value; unread, null (the sentence says recently)", () => {
    expect(parameterValue(floorsRead, "@own-organise")).toBe(24);
    expect(
      parameterValue(
        { isLoading: false, isError: true, data: undefined },
        "@own-organise"
      )
    ).toBeNull();
  });
});

describe("the floors that still always ask", () => {
  const floors = [
    { key: "admin" },
    { key: "agent-schema", switchedBy: KINDS },
    { key: "agent-builds-structure", switchedBy: STRUCTURE },
    { key: "agent-structure" },
  ];

  it("leave out an entry once its switch is on, keep the rest", () => {
    expect(floorsStillAsking(floors, floorsRead).map((f) => f.key)).toEqual([
      "admin",
      "agent-builds-structure",
      "agent-structure",
    ]);
  });

  it("while the switches are unread, every floor is listed", () => {
    expect(
      floorsStillAsking(floors, {
        isLoading: false,
        isError: true,
        data: undefined,
      })
    ).toHaveLength(4);
  });
});
