/**
 * A Happening row's progress: the pod's `live-session` signal carries its
 * deliverables counted (`progress`), `lensRowOfLiveSignal` puts them on the
 * row, and `lensRowProgress` turns them into the rail's fill (THE rail rule,
 * `resolveUnitState`) and its words ("2 of 3 done"). Nothing declared ⇒ no
 * rail and no label, never a fake 0%. The row's STATE stays "running": its
 * `progress` means other things on other rows, so the label never reads it.
 */
import { describe, expect, it } from "vitest";
import { lensRowOfLiveSignal, type LensPageSignal } from "./page.js";
import { lensRowOfSession, lensRowProgress } from "./rows.js";

const live = (progress?: LensPageSignal["progress"]): LensPageSignal => ({
  id: "live:s1",
  kind: "live-session",
  title: "Outreach wave",
  target: { kind: "session", id: "s1" },
  live: { turnInFlight: true, since: "2026-10-22T09:00:00.000Z" },
  ...(progress === undefined ? {} : { progress }),
});

describe("Happening row progress", () => {
  it("2 of 3 delivered is a 67% rail, labelled in words", () => {
    const row = lensRowOfLiveSignal(live({ done: 2, total: 3 }));
    expect(row.state).toEqual({ running: true });
    expect(lensRowProgress(row)).toEqual({ pct: 67, label: "2 of 3 done" });
  });

  it("nothing declared (absent, null or a zero total) has no rail", () => {
    for (const p of [undefined, null, { done: 0, total: 0 }]) {
      expect(lensRowProgress(lensRowOfLiveSignal(live(p)))).toBeNull();
    }
  });

  it("a session LIST row's 0–100 state progress is never read as deliverables", () => {
    const row = lensRowOfSession({ id: "s1", title: "Outreach", status: "active", progress: 40 });
    expect(row.state.progress).toEqual({ done: 40, total: 100 });
    expect(lensRowProgress(row)).toBeNull();
  });
});
