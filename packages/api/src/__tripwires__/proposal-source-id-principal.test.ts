/**
 * TRIPWIRE — `data.sourceId` writers must keep their DOCUMENTED principal.
 *
 * `data.sourceId` is the fifth "who" on a proposal, and unlike the four row
 * columns it holds a DIFFERENT principal per door (contract documented on
 * `RequestShapedProposalData.sourceId` in `@synap-core/types`):
 *
 *   - the canonical `createProposal` writes the HUMAN  (`sourceId: userId`)
 *   - dev-approval / stage-gate write the AGENT        (`sourceId: agentUserId ?? userId`)
 *
 * A comment asserting the opposite sat above a security gate for months and
 * taught readers the wrong thing. Prose rots; this does not. If a writer's
 * shape changes, the documented contract AND
 * `routers/proposals/review-authority.ts`'s agent-class floor must be revisited
 * together — that floor exists precisely BECAUSE one door writes the agent.
 *
 * Scans SOURCE, because the whole point is what the writer literally writes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

/** Blank out comments so a MENTION of a rung never counts as the rung itself. */
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

/** Every known `data.sourceId` writer and the principal it MUST write. */
const WRITERS = [
  {
    file: "utils/permission-check.ts",
    principal: "human",
    /** The canonical `createProposal` payload: the bare human user id. */
    pattern: /^\s*sourceId:\s*userId,\s*$/m,
  },
  {
    file: "services/proposals/dev-approval.ts",
    principal: "agent",
    pattern: /^\s*sourceId:\s*input\.agentUserId\s*\?\?\s*input\.userId,\s*$/m,
  },
  {
    file: "services/playbooks/stage-gate.ts",
    principal: "agent",
    pattern: /^\s*sourceId:\s*input\.agentUserId\s*\?\?\s*input\.userId,\s*$/m,
  },
] as const;

describe("tripwire: data.sourceId writers keep their documented principal", () => {
  // NON-VACUITY: fail loudly if the writer set itself evaporated, rather than
  // passing an empty loop and certifying nothing.
  it("has writers to check", () => {
    expect(WRITERS.length).toBeGreaterThanOrEqual(3);
  });

  for (const w of WRITERS) {
    it(`${w.file} writes the ${w.principal.toUpperCase()} into data.sourceId`, () => {
      const src = read(w.file);
      expect(
        w.pattern.test(src),
        `${w.file} no longer writes \`sourceId\` in its documented ${w.principal} shape. ` +
          `If this door's principal changed, update the contract on ` +
          `RequestShapedProposalData.sourceId (@synap-core/types) AND re-check the ` +
          `agent-class floor in routers/proposals/review-authority.ts.`
      ).toBe(true);
    });
  }

  it("the agent-class floor runs BEFORE the role/policy rung", () => {
    // RE-PINNED 2026-09-07 BY INTENT, not by count. This assertion used to
    // count `isOwner && (await isAgentPrincipal(userId))` and require exactly
    // 2 — a proxy for "the floor exists in BOTH branches". The pod-wide and
    // workspace branches have since been merged into ONE pure ladder
    // (`computeCanReviewApprovalFromFacts`, so `proposals.list` can reach the
    // same rungs for a whole page without an N+1), and a count of 1 would have
    // preserved a number while losing the meaning.
    //
    // What actually matters is ORDER: an agent-class check placed AFTER
    // `canReviewProposal` is dead code for precisely the agents that hold a
    // workspace membership — which is the common case, since `agent-users.ts`
    // copies the creator's role onto the agent. So assert the floor is present
    // and precedes the role rung.
    //
    // The BEHAVIOURAL proof of the same guarantee (an agent denied on inputs
    // where the policy ladder alone grants) lives in
    // `routers/proposals/__tests__/list-viewer-can-review-one-ladder.test.ts`.
    // Prefer editing that one; this is the cheap structural backstop. Matching
    // is whitespace-tolerant on purpose — a tripwire in this repo has already
    // gone falsely red because prettier rewrapped the line it string-matched.
    const src = strip(read("routers/proposals/review-authority.ts"));

    const floor = src.search(
      /purpose\s*===\s*"approve"\s*&&\s*facts\.viewerIsAgent/
    );
    const ownerFloor = src.search(/isOwner\s*&&\s*facts\.viewerIsAgent/);
    const roleRung = src.search(/canReviewProposal\s*\(\s*\{/);

    // NON-VACUITY: all three must exist. A renamed helper makes a `search`
    // return -1, which would otherwise satisfy "floor < roleRung" trivially.
    expect(
      floor,
      "the approve-purpose agent-class floor is gone"
    ).toBeGreaterThan(-1);
    expect(
      ownerFloor,
      "the ownership-rung agent-class floor is gone"
    ).toBeGreaterThan(-1);
    expect(roleRung, "the role/policy rung is gone").toBeGreaterThan(-1);

    expect(
      floor,
      "the agent-class floor must precede the role/policy rung — after it, " +
        "an agent holding an admin membership is granted before the floor runs."
    ).toBeLessThan(roleRung);
    expect(ownerFloor).toBeLessThan(roleRung);

    // The class signal itself, still read from `users.user_type`.
    expect(src).toContain('row?.userType === "agent"');
  });
});
