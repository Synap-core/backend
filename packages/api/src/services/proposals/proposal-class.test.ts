import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  classifyProposal,
  proposalLifetimeHours,
  CLASS_LIFETIME_HOURS,
  PROPOSAL_CLASSES,
} from "./proposal-class.js";

/**
 * The class rule decides what can be EXPIRED, so its failure mode is losing a
 * decision a human still owed. Every test here is about that direction.
 */
describe("classifyProposal", () => {
  it("classifies the four shapes present in the live queue", () => {
    // Counts measured on the team pod 2026-09-02 (660 pending).
    expect(classifyProposal("capability.run", "capability")).toBe("ephemeral"); // 441
    expect(classifyProposal("merge", "entity")).toBe("curatorial"); //  143
    expect(classifyProposal("create", "entity")).toBe("objectWork"); //  56
    expect(classifyProposal("import.graph", "entity")).toBe("objectWork"); // 12
    expect(classifyProposal("ai_edit", "document")).toBe("objectWork"); //  1
    expect(classifyProposal("governance.tighten_lane", "governance")).toBe(
      "governance"
    ); // 2
  });

  it("FAILS CLOSED — an unknown pair gets the class that never expires", () => {
    // The whole safety property. A proposal type this function has not been
    // taught must never be silently deleted by the sweeper.
    expect(classifyProposal("some_future_type", "some_future_target")).toBe(
      "objectWork"
    );
    expect(
      proposalLifetimeHours("some_future_type", "some_future_target"),
      "an unrecognised proposal must be un-expirable"
    ).toBeNull();
  });

  it("a run on something OTHER than a capability is not ephemeral", () => {
    // `proposalType === "capability.run"` alone is not enough — the pair is the key. A
    // future `run` against a different target must not inherit a 24h fuse.
    expect(classifyProposal("capability.run", "playbook")).toBe("objectWork");
    expect(proposalLifetimeHours("capability.run", "playbook")).toBeNull();
  });

  it("ONLY ephemeral has a lifetime", () => {
    const withLifetime = PROPOSAL_CLASSES.filter(
      (c) => CLASS_LIFETIME_HOURS[c] !== null
    );
    expect(
      withLifetime,
      "a class that can expire is a class that can lose a human's decision — " +
        "adding one is a product decision, not a refactor"
    ).toEqual(["ephemeral"]);
  });

  it("the ephemeral backstop outlives a working day plus a night", () => {
    // A run proposed at 6pm must still be answerable the next morning. 158 of
    // the 441 ephemeral rows carry no session, so this is their ONLY trigger.
    const h = CLASS_LIFETIME_HOURS.ephemeral!;
    expect(h).toBeGreaterThanOrEqual(16);
    expect(
      h,
      "long enough to survive a night, short enough to never become archaeology"
    ).toBeLessThanOrEqual(48);
  });

  it("classification reads only the two columns, never the payload", () => {
    // Pinned as behaviour: the same pair must classify identically regardless
    // of anything an agent could write. An agent that could nominate its own
    // class would nominate the quiet one (ATR-2026-00118, approval fatigue).
    expect(classifyProposal("merge", "entity")).toBe(
      classifyProposal("merge", "entity")
    );
    expect(
      classifyProposal.length,
      "arity is (proposalType, targetType) only"
    ).toBe(2);
  });

  it("classifies the literal the executor actually WRITES (source-scan tripwire)", () => {
    // Dogfood 2026-09-02: the table matched "run" while execute-capability.ts
    // wrote "capability.run" — every run filed as objectWork, nothing expired,
    // and the tests were green because they pinned the same wrong literal.
    const src = readFileSync(
      fileURLToPath(
        new URL("../capabilities/execute-capability.ts", import.meta.url)
      ),
      "utf8"
    );
    const m = /proposalType:\s*"([^"]+)"/.exec(src);
    expect(
      m,
      "execute-capability.ts must write a literal proposalType"
    ).not.toBeNull();
    expect(classifyProposal(m![1], "capability")).toBe("ephemeral");
  });
});
