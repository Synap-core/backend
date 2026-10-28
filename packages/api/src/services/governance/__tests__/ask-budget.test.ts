/**
 * D7 (founder, 2026-10-28) — the daily ask budget: `daily_ask_count` = 5,
 * counted in ONE place (`ask-budget.ts`); past it an ask is in Later, which
 * never pushes and never auto-approves.
 *
 * Pure halves here: the ranking (`rankAskUnits`), the unit an ask belongs to
 * (`askUnitKey`, Q1: a batch is one ask) and the push decision's Later rule.
 * "Never auto-approves" is pinned on the source: the counter writes nothing,
 * and the engine has no input it could read the budget through.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CEILING_DEFAULTS,
  DEFAULT_DAILY_ASK_COUNT,
} from "@synap/governance-policy";
import { askUnitKey, rankAskUnits } from "../ask-budget.js";
import { decidePush } from "../../../notifications/push-decision.js";

const at = (min: number) => new Date(Date.UTC(2026, 9, 28, 8, min));
const row = (id: string, min: number, unitKey = `u-${id}`) => ({
  id,
  createdAt: at(min),
  unitKey,
});

describe("the ask budget — the default", () => {
  it("is 5 asks a day, stored as the daily_ask_count ceiling axis", () => {
    expect(DEFAULT_DAILY_ASK_COUNT).toBe(5);
    expect(CEILING_DEFAULTS.daily_ask_count).toBe(5);
  });
});

describe("rankAskUnits — which asks interrupt, which wait in Later", () => {
  it("the first 5 units of the day are Asks; the 6th and after are Later", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`n${i}`, i));
    const units = rankAskUnits(rows, 5);
    expect(units.map((u) => u.lane)).toEqual([
      "asks",
      "asks",
      "asks",
      "asks",
      "asks",
      "later",
      "later",
    ]);
    expect(units.map((u) => u.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("Q1: a batch is ONE ask — its members share its place and its lane", () => {
    const rows = [
      row("a", 0),
      ...Array.from({ length: 9 }, (_, i) => row(`b${i}`, 1 + i, "batch:B")),
      row("c", 20),
      row("d", 21),
      row("e", 22),
      row("f", 23),
    ];
    const units = rankAskUnits(rows, 5);
    expect(units).toHaveLength(6);
    expect(units[1]).toMatchObject({ key: "batch:B", lane: "asks" });
    expect(units[1]!.notificationIds).toHaveLength(9);
    expect(units.find((u) => u.key === "u-f")?.lane).toBe("later");
  });

  it("an ask already in Asks never moves to Later when more arrive", () => {
    const first = rankAskUnits([row("a", 5)], 1);
    const later = rankAskUnits([row("a", 5), row("b", 6), row("c", 1)], 1);
    expect(first[0]!.lane).toBe("asks");
    // An earlier-stamped row wins its place by time, never by arrival order
    // of the read; a unit's place is its FIRST notification.
    expect(later.map((u) => [u.key, u.lane])).toEqual([
      ["u-c", "asks"],
      ["u-a", "later"],
      ["u-b", "later"],
    ]);
  });

  it("a later member of a unit already asked shares that unit's lane", () => {
    const units = rankAskUnits(
      [row("a", 0, "fp:X"), row("b", 1), row("c", 30, "fp:X")],
      1
    );
    expect(units[0]).toMatchObject({ key: "fp:X", lane: "asks" });
    expect(units[0]!.notificationIds).toEqual(["a", "c"]);
  });

  it("no limit (null) ⇒ every ask is in Asks", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`n${i}`, i));
    expect(rankAskUnits(rows, null).every((u) => u.lane === "asks")).toBe(true);
  });
});

describe("askUnitKey — one ask per batch, per change, per source", () => {
  const proposal = (data: unknown, targetId = "t-1") => ({
    proposalType: "update",
    targetType: "entity",
    targetId,
    data,
  });

  it("a proposal with a batchId is its batch", () => {
    expect(
      askUnitKey({
        type: "proposal.created",
        sourceId: "p1",
        notificationId: "n1",
        proposal: proposal({ batchId: "B1" }),
      })
    ).toBe("batch:B1");
  });

  it("two proposals of the same change to the same target are one ask; another target is another", () => {
    const key = (id: string, targetId: string) =>
      askUnitKey({
        type: "proposal.created",
        sourceId: id,
        notificationId: `n-${id}`,
        proposal: proposal({ title: "x" }, targetId),
      });
    expect(key("p1", "t-1")).toBe(key("p2", "t-1"));
    expect(key("p1", "t-1")).not.toBe(key("p3", "t-2"));
  });

  it("any other ask is one per (type, source)", () => {
    expect(
      askUnitKey({
        type: "session.needs_you",
        sourceId: "s1",
        notificationId: "n1",
      })
    ).toBe("session.needs_you:s1");
  });
});

describe("Later never pushes", () => {
  const prefs = {};
  it("an ask in Later is not pushed — even a type the person forced to push", () => {
    for (const typeRule of [undefined, "os", "all"]) {
      expect(
        decidePush({
          type: "session.needs_you",
          typeRule,
          facts: { askLane: "later" },
          prefs,
        })
      ).toEqual({ push: false, category: null, reason: "later" });
    }
  });

  it("the same ask in Asks pushes as before", () => {
    expect(
      decidePush({
        type: "session.needs_you",
        typeRule: undefined,
        facts: { askLane: "asks" },
        prefs,
      })
    ).toMatchObject({ push: true, category: "blocking-ask" });
    expect(
      decidePush({
        type: "proposal.created",
        typeRule: undefined,
        facts: { askLane: "asks", proposalBlocksOpenSession: true },
        prefs,
      })
    ).toMatchObject({ push: true, category: "decision-blocking" });
  });

  it("Later never quiets what is not an ask (a mention)", () => {
    expect(
      decidePush({
        type: "chat.mention",
        typeRule: undefined,
        facts: { askLane: "later" },
        prefs,
      })
    ).toMatchObject({ push: true, category: "mention" });
  });
});

describe("Later never auto-approves (tripwire on the source)", () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the counter writes nothing: no insert, update or delete, no gate", () => {
    const counter = src("../ask-budget.ts");
    expect(counter).not.toMatch(/\.(insert|update|delete)\(/);
    expect(counter).not.toMatch(/checkPermissionOrPropose|ProposalStatus/);
  });

  it("the engine has no input the budget could reach it through", () => {
    const engine = src("../../../../../governance-policy/src/index.ts");
    const start = engine.indexOf("export interface AgentPolicyInput");
    const end = engine.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(engine.slice(start, end)).not.toMatch(/ask(Lane|Budget|Count)/i);
  });
});
