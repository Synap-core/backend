import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveProposalPrincipal } from "../routers/proposals/display.js";

/**
 * `proposals.subject_user_id` (0248) HAS TWO CONSUMERS AND THEY MUST NOT DRIFT.
 *
 * The column holds the EFFECTIVE USER of the principal that authored the row —
 * `apiKeys.linkedUserId ?? apiKeys.userId`, i.e. the same `ctx.userId` every
 * door already carries. One fact, two readings:
 *
 *   FLOOR     — "who reviews this?" When the value is an AGENT user id (a
 *               pod-wide agent acts as its own principal, `linkedUserId: null`),
 *               the reviewing human is that agent's `users.createdByUserId`. A
 *               raw `subjectUserId === viewerId` floor would hide the row from
 *               everybody: a proposal nobody can decide.
 *   PRINCIPAL — "did a human delegate this?" `deriveProposalPrincipal` below.
 *
 * The two readings only coexist because the WRITERS keep the linkage intact.
 * The tempting "fix" for the floor — stamping `users.createdByUserId` instead —
 * would make a global agent and a delegated agent byte-identical on the row and
 * silently destroy the principal reading. `automation-governance.ts` did
 * exactly that, which is what rendered "Scout · for Antoine" for a delegation
 * that never happened.
 *
 * So this file pins BOTH ends:
 *   1. BEHAVIOUR — the three principal outcomes, including the two that used to
 *      collapse into one.
 *   2. SOURCE — the doors that stamp `agentUserId` on a proposal row never
 *      derive `subjectUserId` from `createdByUserId`. (Source-scanned because
 *      these are DB doors; there is no local Postgres to run them against.)
 *
 * NOT IN SCOPE, deliberately: the recommender doors
 * (`recommend-tighten.ts`, `recommend-raise-ceiling.ts`,
 * `governance-lane-scanner.ts`) DO write `subjectUserId: agent.createdByUserId`
 * — correctly. They author meta-proposals ABOUT an agent and document that
 * `proposals.agentUserId` is null on those rows, so the principal reading never
 * fires and the value is already a human. The invariant is scoped to rows that
 * carry an agent ACTOR, which is the only place the two readings can disagree.
 */

const API_SRC = join(process.cwd(), "src");
const JOBS_SRC = join(process.cwd(), "..", "jobs", "src");

describe("PRINCIPAL reading — behaviour", () => {
  const resolveName = (id: string) =>
    ({ "human-1": "Antoine" })[id as "human-1"];

  it("no agent acted → no principal question to answer", () => {
    expect(
      deriveProposalPrincipal({
        agentUserId: null,
        subjectUserId: "human-1",
        resolveName,
      })
    ).toBeUndefined();
  });

  it("a POD-WIDE agent acted as ITSELF → global, and names NOBODY", () => {
    // THE FALSE-CLAIM CASE. The old derivation read the agent's
    // `createdByUserId` here and rendered "for Antoine" — a delegation the
    // human never made, asserted on the surface built to disprove it.
    expect(
      deriveProposalPrincipal({
        agentUserId: "agent-1",
        subjectUserId: "agent-1",
        resolveName,
      })
    ).toEqual({ kind: "global" });
  });

  it("a HUMAN-LINKED agent acted → delegated, and names the human", () => {
    expect(
      deriveProposalPrincipal({
        agentUserId: "agent-1",
        subjectUserId: "human-1",
        resolveName,
      })
    ).toEqual({ kind: "delegated", name: "Antoine" });
  });

  it("global and delegated are DISTINGUISHABLE (the point of the column)", () => {
    const global = deriveProposalPrincipal({
      agentUserId: "agent-1",
      subjectUserId: "agent-1",
      resolveName,
    });
    const delegated = deriveProposalPrincipal({
      agentUserId: "agent-1",
      subjectUserId: "human-1",
      resolveName,
    });
    expect(global?.kind).not.toBe(delegated?.kind);
  });

  it("a pre-0248 row is UNRESOLVED — a value, never a silent 'no'", () => {
    expect(
      deriveProposalPrincipal({
        agentUserId: "agent-1",
        subjectUserId: null,
        resolveName,
      })
    ).toEqual({ kind: "unresolved" });
  });

  it("delegated with an unreadable user row still says DELEGATED, unnamed", () => {
    expect(
      deriveProposalPrincipal({
        agentUserId: "agent-1",
        subjectUserId: "human-ghost",
        resolveName,
      })
    ).toEqual({ kind: "delegated" });
  });
});

describe("WRITER invariant — agent-actor doors pass the effective user", () => {
  /**
   * Every door that stamps BOTH `agentUserId` and `subjectUserId` on a proposal
   * row, and the expression each must pass. A door added here without being
   * added to the list is the drift this file exists to catch; the count is
   * pinned below so a silent removal reads RED too.
   */
  const AGENT_ACTOR_DOORS: Array<{
    file: string;
    src: string;
    /** The expression(s) the door legitimately stamps. */
    allowed: RegExp[];
  }> = [
    {
      file: "packages/api/src/utils/permission-check.ts",
      src: join(API_SRC, "utils", "permission-check.ts"),
      // `userId` here is the envelope's AccessContext user = effectiveUserId.
      allowed: [
        /subjectUserId:\s*userId\b/,
        /subjectUserId:\s*input\.userId\b/,
      ],
    },
    {
      file: "packages/api/src/utils/event-backed-proposal.ts",
      src: join(API_SRC, "utils", "event-backed-proposal.ts"),
      allowed: [/subjectUserId:\s*input\.userId\b/],
    },
    {
      file: "packages/jobs/src/utils/automation-governance.ts",
      src: join(JOBS_SRC, "utils", "automation-governance.ts"),
      // No request context in a job: the door's own RBAC ladder defines the
      // effective user as the owning agent's user id, so that is the fallback.
      // `ownerId` is the confused-deputy branch, where a HUMAN owns the
      // automation the agent's step runs inside.
      allowed: [
        /subjectUserId:\s*ownerId\b/,
        /subjectUserId\s*=\s*opts\.subjectUserId\s*\?\?\s*agentUserId\b/,
        /subjectUserId,/,
      ],
    },
  ];

  it("pins the door count so a removal is not silent", () => {
    expect(AGENT_ACTOR_DOORS).toHaveLength(3);
  });

  for (const door of AGENT_ACTOR_DOORS) {
    it(`${door.file}: never derives subjectUserId from createdByUserId`, () => {
      const src = readFileSync(door.src, "utf8");
      // The forbidden derivation, in any of the shapes it has taken:
      //   subjectUserId: x.createdByUserId
      //   subjectUserId = x?.createdByUserId ?? null
      const FORBIDDEN = /subjectUserId\s*[:=][^;\n]*\bcreatedByUserId\b/;
      const offending = src
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => FORBIDDEN.test(line));
      expect(
        offending,
        `${door.file}: \`createdByUserId\` is the ACCOUNTABILITY anchor — every ` +
          `agent has one — so stamping it makes a pod-wide agent look delegated. ` +
          `Pass the acting principal's effective user instead.`
      ).toEqual([]);
    });

    it(`${door.file}: every subjectUserId it stamps is an allowed expression`, () => {
      const src = readFileSync(door.src, "utf8");
      const stamps = src
        .split("\n")
        .map((line, i) => [i + 1, line.trim()] as const)
        // Only real assignments, not prose: a comment line is skipped.
        .filter(
          ([, line]) =>
            /\bsubjectUserId\s*[:=]/.test(line) &&
            !line.startsWith("*") &&
            !line.startsWith("//")
        );
      expect(stamps.length).toBeGreaterThan(0);
      const unexplained = stamps.filter(
        ([, line]) => !door.allowed.some((re) => re.test(line))
      );
      expect(
        unexplained,
        `${door.file}: a new subjectUserId writer must be reviewed against the ` +
          `column contract in @synap/database schema/proposals.ts, then listed here.`
      ).toEqual([]);
    });
  }
});

describe("PRINCIPAL is a LABEL, never a FILTER", () => {
  /**
   * The three access predicates that decide WHO SEES / WHO MAY APPROVE all key
   * on `users.createdByUserId`, and none of them may start keying on
   * `subjectUserId` as part of this wave. A display fix that quietly became a
   * visibility change would hide rows rather than relabel them — the exact
   * failure mode migration 0248's own note warns about ("flooring a mostly-NULL
   * column would HIDE rows").
   */
  const FILTERS = [
    join(API_SRC, "utils", "proposal-visibility.ts"),
    join(API_SRC, "routers", "proposals", "review-authority.ts"),
  ].filter((p) => {
    try {
      readFileSync(p, "utf8");
      return true;
    } catch {
      return false;
    }
  });

  it("finds the visibility/authority modules it claims to guard", () => {
    // A path typo would make every assertion below vacuously pass.
    expect(FILTERS.length).toBe(2);
  });

  for (const path of FILTERS) {
    it(`${path.split("/").slice(-1)[0]}: does not floor on subjectUserId`, () => {
      expect(readFileSync(path, "utf8")).not.toMatch(/subjectUserId/);
    });
  }
});
