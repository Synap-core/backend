/**
 * TRIPWIRE — a next-rung grant can never cross a floor.
 *
 * The trust ladder's offer (`projectNextRung`, services/proposals/next-rung.ts)
 * is the ONLY producer of a next-rung rule. For EVERY governed write door the
 * engine classifies (`REVERSIBILITY_DOOR_CLASS` — derived, so a new door joins
 * by existing), a pending agent card is projected and must get an offer IFF
 * the write is reversible AND no event-keyed floor catches it. For every
 * reason code the ladder classifies as out of reach, even a reversible card
 * gets none.
 *
 * WHAT IT DOES NOT COVER: the WHO-grants gate (next-rung.pglite.test.ts) and
 * the engine ordering itself (governance-policy trust-ladder-reach.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  PROPOSE_REASON,
  REVERSIBILITY_DOOR_CLASS,
  isReversibleWrite,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import { GOVERNANCE_REASON_RULE_REACH } from "@synap-core/types/trust-ladder";
import { projectNextRung } from "../services/proposals/next-rung.js";

const EVENT_KEYS = Object.keys(REVERSIBILITY_DOOR_CLASS).map((door) =>
  door.replace("/", ".")
);

function card(eventKey: string, governanceReason: string | null = null) {
  const dot = eventKey.lastIndexOf(".");
  return projectNextRung({
    id: "p-1",
    status: "pending",
    targetType: eventKey.slice(0, dot),
    proposalType: eventKey.slice(dot + 1),
    workspaceId: null,
    agentUserId: "agent-1",
    governanceReason,
    data: {},
  });
}

describe("next rung never crosses a floor", () => {
  it("non-vacuity: every door is scanned, both outcomes occur, and the scan still sees a known pair", () => {
    expect(EVENT_KEYS.length).toBeGreaterThan(60);
    expect(card("entity.update").offer).not.toBeNull();
    expect(card("entity.delete").offer).toBeNull();
  });

  it("offers a rule on exactly the reversible, un-floored doors", () => {
    let offered = 0;
    let refused = 0;
    for (const key of EVENT_KEYS) {
      const expected =
        isReversibleWrite(key) && nonWidenableFloorFor(key) === null;
      const projection = card(key);
      expect(projection.offer !== null, key).toBe(expected);
      if (projection.rule) {
        // The drafted rule is itself never behind a floor.
        expect(nonWidenableFloorFor(projection.rule.targetPattern), key).toBeNull();
        expect(projection.rule.verdict).toBe("auto");
        expect(projection.rule.principalKind).toBe("agent");
        offered++;
      } else refused++;
    }
    expect(offered).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(20);
  });

  it("no out-of-reach reason code ever gets an offer, even on a reversible door", () => {
    const outOfReach = Object.keys(PROPOSE_REASON).filter((code) => {
      const reach = (GOVERNANCE_REASON_RULE_REACH as Record<string, string>)[
        code
      ];
      return reach !== "rule" && reach !== "below";
    });
    expect(outOfReach.length).toBeGreaterThan(8);
    for (const code of outOfReach) {
      expect(card("entity.update", code).offer, code).toBeNull();
    }
  });
});
