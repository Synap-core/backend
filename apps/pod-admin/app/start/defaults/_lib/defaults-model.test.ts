/**
 * The defaults step's rows, derived from each setting's own read. The cases
 * that matter are where a wrong rule would DISAGREE with the right one: a
 * failed read (never a default), presence's default `enforce` (ON, from a
 * pod with no setting), the operator floor (locked, and says why), and the
 * proactive write (the defaults as read, only `enabled` moved).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROWS,
  defaultsStepRows,
  enabledSave,
  libraryDial,
  presenceDial,
  presenceSave,
  proactiveDial,
  proactiveInput,
  type PresenceModeData,
  type QueryLike,
} from "./defaults-model";

const idle = { isPending: false, variables: undefined };
const ready = <T>(data: T): QueryLike<T> => ({
  isLoading: false,
  isError: false,
  data,
});
const failed: QueryLike<never> = { isLoading: false, isError: true };
const dialOn = ready({ enabled: true, canManage: true });

function rowsWith(
  presence: QueryLike<PresenceModeData>,
  over: Partial<Parameters<typeof defaultsStepRows>[0]> = {}
) {
  return defaultsStepRows(
    {
      presence: { read: presenceDial(presence), save: idle },
      reversible: { read: dialOn, save: idle },
      ownOrganise: { read: dialOn, save: idle },
      proactive: { read: dialOn, save: idle },
      library: { read: dialOn, save: idle },
      ...over,
    },
    presence
  );
}

describe("defaultsStepRows", () => {
  it("lists every row once, in the declared order", () => {
    const rows = rowsWith(ready({ mode: "enforce", source: "default" }));
    expect(rows.map((r) => r.row)).toEqual([...DEFAULT_ROWS]);
  });

  it("a pod with no presence setting reads ON (enforce by default), switchable", () => {
    const [presence] = rowsWith(ready({ mode: "enforce", source: "default" }));
    expect(presence).toMatchObject({
      state: { kind: "ready", on: true, canManage: true },
      lockedBy: null,
    });
  });

  it("an explicit report reads OFF", () => {
    const [presence] = rowsWith(ready({ mode: "report", source: "setting" }));
    expect(presence!.state).toMatchObject({ kind: "ready", on: false });
  });

  it("the operator's env floor locks presence ON and says who", () => {
    const [presence] = rowsWith(ready({ mode: "enforce", source: "env" }));
    expect(presence).toMatchObject({
      state: { kind: "ready", on: true, canManage: false },
      lockedBy: "operator",
    });
  });

  it("GUARDRAIL: a failed read is the failed mark, never a default", () => {
    const rows = rowsWith(failed, {
      proactive: { read: proactiveDial(failed), save: idle },
      library: { read: libraryDial(failed), save: idle },
    });
    expect(rows[0]!.state).toEqual({ kind: "failed" });
    expect(rows[3]!.state).toEqual({ kind: "failed" });
    expect(rows[4]!.state).toEqual({ kind: "failed" });
    expect(rows[0]!.lockedBy).toBeNull();
  });

  it("a row the pod says this person may not change is locked as admin-only", () => {
    const rows = rowsWith(ready({ mode: "enforce", source: "default" }), {
      reversible: {
        read: ready({ enabled: true, canManage: false }),
        save: idle,
      },
    });
    expect(rows[1]).toMatchObject({ lockedBy: "admin" });
  });

  it("the pick shows while the pod saves it", () => {
    const rows = rowsWith(ready({ mode: "enforce", source: "default" }), {
      library: {
        read: libraryDial(
          ready({ settings: { enabled: true, archiveAfterDays: 0 } })
        ),
        save: enabledSave({ isPending: true, variables: { enabled: false } }),
      },
    });
    expect(rows[4]!.state).toMatchObject({ on: false, saving: true });
    const presenceSaving = presenceSave({
      isPending: true,
      variables: { mode: "report" },
    });
    expect(presenceSaving).toEqual({
      isPending: true,
      variables: { enabled: false },
    });
  });
});

describe("proactiveInput", () => {
  it("sends the defaults as read, only `enabled` moved", () => {
    const read = {
      defaults: {
        enabled: false,
        nudgeDensity: "high" as const,
        schedules: {
          morningBriefing: true,
          weeklyDigest: false,
          healthCheck: true,
        },
      },
    };
    expect(proactiveInput(read, true)).toEqual({
      ...read.defaults,
      enabled: true,
    });
    expect(proactiveDial(ready(read)).data).toEqual({
      enabled: false,
      canManage: true,
    });
  });
});
