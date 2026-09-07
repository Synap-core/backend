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

  it("the agent-class floor guarding the sourceId owner rung is still present", () => {
    const src = read("routers/proposals/review-authority.ts");
    // The floor is what makes an agent-principal `sourceId` safe to compare
    // against the caller. Two branches (pod-wide + workspace) each carry it.
    const floors = src.match(
      /isOwner\s*&&\s*\(await isAgentPrincipal\(userId\)\)/g
    );
    expect(
      floors?.length,
      "expected the agent-class floor in BOTH authority branches"
    ).toBe(2);
    expect(src).toContain('row?.userType === "agent"');
  });
});
