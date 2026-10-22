/**
 * "from X" on a Needs-you row: the pod's `Signal.by` (the ONE agent behind a
 * cluster) reaches the lens row a surface draws as a door to the agent. A
 * session CARD (several asks) names the session, never one asker; no `by`, or
 * one without a name, draws nothing.
 */
import { describe, expect, it } from "vitest";
import { lensItemsOfClass } from "./page-model.js";
import type { LensNeedsYouSignal } from "./rows.js";

const cluster = (over: Partial<LensNeedsYouSignal> = {}): LensNeedsYouSignal => ({
  id: "cluster:fp",
  kind: "proposal-cluster",
  title: "Create lead Lumen Atelier",
  count: 2,
  repeatCount: 1,
  category: "governance",
  groupKey: null,
  ageBucket: "recent",
  target: { kind: "proposal", id: "p1" },
  by: { kind: "agent", id: "a1", label: "Scout" },
  ...over,
});

const rowOf = (signals: LensNeedsYouSignal[]) => lensItemsOfClass(signals, "blocking")[0]!.row;

describe("Needs-you row: who asked", () => {
  it("carries the one agent as a door", () => {
    expect(rowOf([cluster()]).by).toEqual({ kind: "agent", id: "a1", label: "Scout" });
  });

  it("no by, or a nameless one, draws no 'from'", () => {
    expect(rowOf([cluster({ by: null })]).by ?? null).toBeNull();
    expect(rowOf([cluster({ by: { kind: "agent", id: "a1", label: "" } })]).by ?? null).toBeNull();
  });

  it("a session card of several asks names no single asker", () => {
    const inSession = (id: string) =>
      cluster({ id, groupKey: "session:s1", sessionTitle: "Outreach" });
    expect(rowOf([inSession("c1"), inSession("c2")]).by ?? null).toBeNull();
  });
});
