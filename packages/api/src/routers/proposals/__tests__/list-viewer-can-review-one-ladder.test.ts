/**
 * MERGE PROOF — `proposals.list`'s `viewerCanReview` and the mutations must be
 * ONE ladder.
 *
 * THE DIVERGENCE. `list` computed its per-row flag from its OWN inlined rungs:
 *
 *     const isOwner = data?.sourceId === reviewerId;
 *     const allowed = !hasWorkspace
 *       ? true
 *       : canReviewProposal({ policy, memberRole, isOwner });
 *
 * Two holes, both of which the shared `computeCanReviewApproval` closes:
 *   1. NO AGENT-CLASS FLOOR. `computeCanReviewApproval` now takes a required
 *      `purpose`, and `"approve"` refuses an agent principal BEFORE the policy
 *      ladder. The list applied no such floor, so an agent could be shown an
 *      Approve button the mutation refuses — and the ladder's own docstring
 *      claimed "the button shows iff the mutation would succeed".
 *   2. POD-WIDE WAS AN UNCONDITIONAL ALLOW. `!hasWorkspace ? true` handed a
 *      review affordance on EVERY pod-wide proposal to every authenticated pod
 *      user; the shared ladder admits only the owner or a pod-admin.
 *
 * These tests exercise the merged path exactly as `list` runs it —
 * `resolveBatchedReviewAuthorityFacts` (the batched DB resolution) followed by
 * `computeCanReviewApprovalFromFacts` (the one ladder body) — with the database
 * mocked. The `PRE-MERGE` cases below are written so that they FAIL against the
 * inlined rungs quoted above and PASS against the shared ladder.
 *
 * `vi.mock` note: `importOriginal()` + spread, NOT a total replacement. Routing
 * the list through the shared ladder pulls in `isPodAdmin` / `isAgentPrincipal`,
 * which read `db.query.workspaces`, `db.query.workspaceMembers` and a `users`
 * select. A total mock would leave a newly-imported name undefined and kill the
 * file at COLLECTION — zero tests, which reads as a pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Blank out comments so a MENTION of a helper never counts as a CALL. */
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

const h = vi.hoisted(() => ({
  /** `users.id` → the row the agent-class lookup sees. */
  users: new Map<string, { userType: string }>(),
  /** agent `users.id` → `created_by_user_id`, for the agent-owner rung. */
  agentCreators: new Map<string, string | null>(),
  /** workspaceId → stored `settings` JSONB (undefined ⇒ default policy). */
  workspaceSettings: new Map<string, unknown>(),
  /** The viewer's membership rows, as `db.query.workspaceMembers` returns them. */
  memberships: [] as Array<{ workspaceId: string; role: string }>,
  /** The `pod-admin` system workspace row, or undefined when it doesn't exist. */
  podAdminWorkspace: undefined as { id: string } | undefined,
  /** The viewer's pod-admin membership row, or undefined. */
  podAdminMembership: undefined as { role: string } | undefined,
  /** Every `.select()` the resolvers issue, for the query-budget assertions. */
  selectShapes: [] as string[],
  /** Every `db.query.*` read, likewise. */
  queryReads: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // The resolvers' `where` clauses are opaque here, so capture the operand the
  // caller actually asked for rather than guessing which row to answer with.
  let lastEqValue: string | undefined;
  let lastInValues: string[] = [];
  const eq = (col: unknown, val: unknown) => {
    lastEqValue = val as string;
    return actual.eq(col as never, val as never);
  };
  const inArray = (col: unknown, vals: unknown) => {
    lastInValues = vals as string[];
    return actual.inArray(col as never, vals as never);
  };
  return {
    ...actual,
    eq,
    inArray,
    db: {
      query: {
        // `isPodAdmin` reads both of these.
        workspaces: {
          findFirst: async () => {
            h.queryReads.push("workspaces.findFirst");
            return h.podAdminWorkspace;
          },
        },
        workspaceMembers: {
          findFirst: async () => {
            h.queryReads.push("workspaceMembers.findFirst");
            return h.podAdminMembership;
          },
          // The batched membership read in `resolveBatchedReviewAuthorityFacts`.
          findMany: async () => {
            h.queryReads.push("workspaceMembers.findMany");
            return h.memberships;
          },
        },
      },
      select: (shape: Record<string, unknown>) => {
        const key = Object.keys(shape).sort().join(",");
        h.selectShapes.push(key);
        const rows = () => {
          if (Object.hasOwn(shape, "createdByUserId")) {
            // The batched agent-owner lookup: one `inArray` over the page's
            // distinct acting agents.
            return lastInValues
              .filter((id) => h.agentCreators.has(id))
              .map((id) => ({ id, createdByUserId: h.agentCreators.get(id) }));
          }
          if (Object.hasOwn(shape, "settings")) {
            // Batched form asks for {id, settings}; single form for {settings}.
            const ids = Object.hasOwn(shape, "id")
              ? lastInValues
              : [lastEqValue ?? ""];
            return ids.map((id) => ({
              id,
              settings: h.workspaceSettings.get(id),
            }));
          }
          const row = h.users.get(lastEqValue ?? "");
          return row ? [row] : [];
        };
        const where = () =>
          Object.assign(Promise.resolve(rows()), {
            limit: async () => rows(),
          });
        return { from: () => ({ where }) };
      },
    },
  };
});

const {
  computeCanReviewApprovalFromFacts,
  resolveBatchedReviewAuthorityFacts,
  computeCanReviewApproval,
} = await import("../review-authority.js");

const AGENT = "agent-user-id";
const HUMAN = "human-user-id";
const STRANGER = "stranger-user-id";
const WS = "workspace-id";

/** Exactly what `proposals.list` does for one page, minus the display plumbing. */
async function listVerdicts(
  viewerId: string,
  rows: Array<{
    id: string;
    workspaceId: string | null;
    data: unknown;
    agentUserId: string | null;
  }>
) {
  const factsFor = await resolveBatchedReviewAuthorityFacts({
    userId: viewerId,
    rows,
  });
  return new Map(
    rows.map((r) => [
      r.id,
      computeCanReviewApprovalFromFacts({
        proposal: {
          workspaceId: r.workspaceId,
          data: r.data,
          agentUserId: r.agentUserId,
        },
        userId: viewerId,
        purpose: "approve",
        facts: factsFor(r),
      }),
    ])
  );
}

beforeEach(() => {
  h.users.clear();
  h.users.set(AGENT, { userType: "agent" });
  h.users.set(HUMAN, { userType: "human" });
  h.users.set(STRANGER, { userType: "human" });
  h.agentCreators.clear();
  h.agentCreators.set(AGENT, HUMAN);
  h.workspaceSettings.clear();
  h.memberships = [];
  h.podAdminWorkspace = undefined;
  h.podAdminMembership = undefined;
  h.selectShapes = [];
  h.queryReads = [];
});

/**
 * A dev-approval-shaped proposal: `data.sourceId` is the AGENT itself (that is
 * what `services/proposals/dev-approval.ts` and
 * `services/playbooks/stage-gate.ts` write — `agentUserId ?? userId`).
 */
const agentOwnedRow = {
  id: "p-agent-self",
  workspaceId: WS,
  data: { sourceId: AGENT, changeType: "deploy_approval" },
  agentUserId: AGENT,
};

describe("PRE-MERGE HOLE 1 — the list had no agent-class floor", () => {
  it("an agent that is data.sourceId AND a workspace admin gets viewerCanReview:false", async () => {
    // Agents really do hold memberships: `routers/agent-users.ts` copies the
    // role from their creator, so an agent created by an admin IS an admin.
    h.memberships = [{ workspaceId: WS, role: "admin" }];

    const verdicts = await listVerdicts(AGENT, [agentOwnedRow]);

    // The inlined rungs computed `isOwner = (sourceId === AGENT) === true`, and
    // `canReviewProposal({policy:"owner_and_admins", memberRole:"admin", isOwner:true})`
    // returns true on BOTH counts. So this assertion is RED against them.
    expect(verdicts.get("p-agent-self")).toEqual({
      allowed: false,
      reason: "not-authorized",
    });
  });

  it("NON-VACUITY: the same row and the same membership grant a HUMAN", async () => {
    // Identical inputs except `users.user_type`. If the floor were instead a
    // blanket deny, this would fail — the ONLY thing separating the two
    // verdicts is the viewer's class. The acting agent is owned by a THIRD
    // party here, so this human is admitted purely by the ROLE rung: the floor
    // must be blocking the agent's role grant, not merely its owner rung.
    h.memberships = [{ workspaceId: WS, role: "admin" }];
    h.agentCreators.set(AGENT, "some-third-party");

    const verdicts = await listVerdicts(HUMAN, [agentOwnedRow]);

    expect(verdicts.get("p-agent-self")).toEqual({
      allowed: true,
      reason: "admin",
    });
  });

  it("the list flag and the MUTATION now agree for that agent", async () => {
    // The whole point of the merge: the button shows iff the mutation succeeds.
    h.memberships = [{ workspaceId: WS, role: "admin" }];

    const listed = (await listVerdicts(AGENT, [agentOwnedRow])).get(
      "p-agent-self"
    );
    const mutation = await computeCanReviewApproval({
      proposal: {
        workspaceId: agentOwnedRow.workspaceId,
        data: agentOwnedRow.data,
        agentUserId: agentOwnedRow.agentUserId,
      },
      userId: AGENT,
      purpose: "approve",
    });

    expect(listed?.allowed).toBe(mutation.allowed);
    expect(listed?.allowed).toBe(false);
  });

  it("an agent is floored even under `any_editor` with only an editor role", async () => {
    // The owner rung is not the only way in: the ROLE ladder grants
    // independently, which is exactly why the floor sits ABOVE it.
    h.workspaceSettings.set(WS, {
      aiGovernance: { proposalApprovalPolicy: "any_editor" },
    });
    h.memberships = [{ workspaceId: WS, role: "editor" }];

    const notMine = {
      id: "p-someone-else",
      workspaceId: WS,
      data: { sourceId: HUMAN },
      agentUserId: null,
    };
    expect(
      (await listVerdicts(AGENT, [notMine])).get("p-someone-else")
    ).toEqual({ allowed: false, reason: "not-authorized" });
    // Same policy, same role, human viewer ⇒ granted.
    expect(
      (await listVerdicts(STRANGER, [notMine])).get("p-someone-else")
    ).toEqual({ allowed: true, reason: "editor" });
  });
});

describe("PRE-MERGE HOLE 2 — pod-wide rows were an unconditional allow", () => {
  const podWideRow = {
    id: "p-pod-wide",
    workspaceId: null,
    data: { sourceId: HUMAN },
    agentUserId: null,
  };

  it("a stranger no longer gets a review affordance on someone else's pod-wide proposal", async () => {
    // `!hasWorkspace ? true` returned TRUE here, for everyone. RED pre-merge.
    const verdicts = await listVerdicts(STRANGER, [podWideRow]);
    expect(verdicts.get("p-pod-wide")).toEqual({
      allowed: false,
      reason: "not-authorized",
    });
  });

  it("the pod-wide proposal's own owner keeps it (solo-capture UX preserved)", async () => {
    const verdicts = await listVerdicts(HUMAN, [podWideRow]);
    expect(verdicts.get("p-pod-wide")).toEqual({
      allowed: true,
      reason: "owner",
    });
  });

  it("a pod-admin keeps it", async () => {
    h.podAdminWorkspace = { id: "pod-admin-ws" };
    h.podAdminMembership = { role: "admin" };
    const verdicts = await listVerdicts(STRANGER, [podWideRow]);
    expect(verdicts.get("p-pod-wide")).toEqual({
      allowed: true,
      reason: "admin",
    });
  });
});

describe("the batched resolution is O(1) in page size, not O(rows)", () => {
  it("a 40-row page across 2 workspaces costs 3 queries, none per row", async () => {
    h.memberships = [{ workspaceId: WS, role: "admin" }];
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `p-${i}`,
      workspaceId: i % 2 === 0 ? WS : "ws-2",
      data: { sourceId: HUMAN },
      agentUserId: null,
    }));

    await listVerdicts(HUMAN, rows);

    // 1 workspace-settings select (inArray over the 2 distinct ids)
    // + 1 batched membership read + 1 users select for the viewer's class.
    expect(h.selectShapes).toEqual(["id,settings", "userType"]);
    expect(h.queryReads).toEqual(["workspaceMembers.findMany"]);
  });

  it("isPodAdmin is consulted ONLY when the page carries a pod-wide row", async () => {
    h.memberships = [{ workspaceId: WS, role: "admin" }];
    const wsOnly = [
      {
        id: "p-ws",
        workspaceId: WS,
        data: { sourceId: HUMAN },
        agentUserId: null,
      },
    ];
    await listVerdicts(HUMAN, wsOnly);
    expect(h.queryReads).not.toContain("workspaces.findFirst");

    h.queryReads = [];
    await listVerdicts(HUMAN, [
      ...wsOnly,
      { id: "p-pod", workspaceId: null, data: {}, agentUserId: null },
    ]);
    expect(h.queryReads).toContain("workspaces.findFirst");
  });
});

describe("PRE-MERGE HOLE 3 — the agent-owner rung was never resolved", () => {
  /**
   * The mirror of holes 1 and 2, and the more user-hostile direction. The
   * mutation (`computeCanReviewApproval`) admits the human who owns the acting
   * agent, but the list resolved no agent creator at all, so `isOwner` was just
   * `data.sourceId === viewer` — false for an agent-authored proposal. Under
   * the default `owner_and_admins` policy a plain (non-admin) member therefore
   * got NO Approve button for a proposal their own agent raised and their own
   * approval would materialize: no button, no error, nothing to retry.
   */
  const myAgentsProposal = {
    id: "p-my-agent",
    workspaceId: WS,
    // dev-approval shape: `sourceId` is the AGENT, so the direct match fails
    // and only the agent-owner rung can admit the human.
    data: { sourceId: AGENT },
    agentUserId: AGENT,
  };

  it("the human who OWNS the acting agent gets viewerCanReview:true as a plain member", async () => {
    h.memberships = [{ workspaceId: WS, role: "member" }];
    h.agentCreators.set(AGENT, HUMAN);

    // RED pre-merge: `isOwner` was `data.sourceId === HUMAN` = false, and
    // `canReviewProposal({owner_and_admins, "member", false})` = false.
    expect(
      (await listVerdicts(HUMAN, [myAgentsProposal])).get("p-my-agent")
    ).toEqual({ allowed: true, reason: "agent-owner" });
  });

  it("and the list now agrees with the MUTATION for that human", async () => {
    h.memberships = [{ workspaceId: WS, role: "member" }];
    h.agentCreators.set(AGENT, HUMAN);

    const listed = (await listVerdicts(HUMAN, [myAgentsProposal])).get(
      "p-my-agent"
    );
    const mutation = await computeCanReviewApproval({
      proposal: {
        workspaceId: myAgentsProposal.workspaceId,
        data: myAgentsProposal.data,
        agentUserId: myAgentsProposal.agentUserId,
      },
      userId: HUMAN,
      purpose: "approve",
    });
    expect(listed?.allowed).toBe(mutation.allowed);
    expect(listed?.allowed).toBe(true);
  });

  it("NO WIDENING: a stranger who owns nothing is still denied", async () => {
    // Same row, same (absent) membership, different viewer. If the rung had
    // been implemented as "any viewer when the row is agent-authored", this
    // would flip to true.
    h.memberships = [];
    h.agentCreators.set(AGENT, HUMAN);

    expect(
      (await listVerdicts(STRANGER, [myAgentsProposal])).get("p-my-agent")
    ).toEqual({ allowed: false, reason: "not-authorized" });
  });

  it("NO WIDENING: the AGENT itself is still denied by the class floor", async () => {
    // The agent's creator is the human, so the rung does not admit the agent —
    // and even if it did, the class floor sits above the whole ladder.
    h.memberships = [{ workspaceId: WS, role: "admin" }];
    h.agentCreators.set(AGENT, HUMAN);

    expect(
      (await listVerdicts(AGENT, [myAgentsProposal])).get("p-my-agent")
    ).toEqual({ allowed: false, reason: "not-authorized" });
  });

  it("an agent whose creator is UNKNOWN admits nobody through the rung", async () => {
    // The `users` row is missing (deleted agent): resolved-to-null, not
    // resolved-to-anyone.
    h.memberships = [{ workspaceId: WS, role: "member" }];
    h.agentCreators.delete(AGENT);

    expect(
      (await listVerdicts(HUMAN, [myAgentsProposal])).get("p-my-agent")
    ).toEqual({ allowed: false, reason: "not-authorized" });
  });

  it("`undefined` means the row has no acting agent — never `we did not look`", async () => {
    const noAgentRow = {
      id: "p-no-agent",
      workspaceId: WS,
      data: { sourceId: HUMAN },
      agentUserId: null,
    };
    const factsFor = await resolveBatchedReviewAuthorityFacts({
      userId: HUMAN,
      rows: [noAgentRow, myAgentsProposal],
    });
    expect(factsFor(noAgentRow).agentCreatedByUserId).toBeUndefined();
    expect(factsFor(myAgentsProposal).agentCreatedByUserId).toBe(HUMAN);
  });
});

describe("the ORDER of the rungs is the guarantee", () => {
  /**
   * BEHAVIOURAL replacement for the source-regex that used to pin the floor in
   * `__tripwires__/proposal-source-id-principal.test.ts`. The floor is only
   * worth anything if it runs BEFORE the role/policy rung — an agent-class
   * check placed after `canReviewProposal` would be dead code for exactly the
   * agents that hold a membership, which is the common case (`agent-users.ts`
   * copies the creator's role onto the agent).
   */
  it("an agent is denied on inputs where the POLICY LADDER ALONE would grant", async () => {
    h.workspaceSettings.set(WS, {
      aiGovernance: { proposalApprovalPolicy: "admins_only" },
    });
    h.memberships = [{ workspaceId: WS, role: "admin" }];
    const row = {
      id: "p-role-grants",
      workspaceId: WS,
      // Authored by a FOURTH party, so neither viewer below can reach the
      // ownership rung — the only thing that can grant here is the role rung.
      data: { sourceId: "someone-entirely-else" },
      agentUserId: null,
    };

    // Proof the role rung WOULD grant on these exact inputs: same policy, same
    // role, human viewer.
    expect((await listVerdicts(STRANGER, [row])).get("p-role-grants")).toEqual({
      allowed: true,
      reason: "admin",
    });
    // ...and the agent is refused anyway ⇒ the floor ran first.
    expect((await listVerdicts(AGENT, [row])).get("p-role-grants")).toEqual({
      allowed: false,
      reason: "not-authorized",
    });
  });
});

/**
 * SOURCE TRIPWIRE — red against HEAD before this merge, where the list called
 * `canReviewProposal({ policy, memberRole, isOwner })` directly. Cited by SYMBOL
 * name, never by line number.
 */
describe("tripwire: the list must not rebuild the ladder", () => {
  const ROUTER = strip(
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../proposals.ts"
      ),
      "utf-8"
    )
  );

  it("proposals.ts calls no ladder rung directly", () => {
    // NON-VACUITY first: the file must still reach the shared ladder at all,
    // so a rename or a deleted call site fails loudly here instead of making
    // the "no rungs" assertion below trivially true.
    expect(
      (ROUTER.match(/computeCanReviewApprovalFromFacts\(/g) ?? []).length
    ).toBe(1);
    expect(
      (ROUTER.match(/resolveBatchedReviewAuthorityFacts\(/g) ?? []).length
    ).toBe(1);

    // The rungs themselves belong to `computeCanReviewApprovalFromFacts`. A
    // router that calls one directly is re-opening the fork this merge closed.
    for (const rung of ["canReviewProposal", "formatReviewAuthorityReason"]) {
      expect(
        (ROUTER.match(new RegExp(`\\b${rung}\\(`, "g")) ?? []).length,
        `proposals.ts calls \`${rung}\` directly — that is a second ladder. ` +
          `Route the verdict through computeCanReviewApprovalFromFacts instead.`
      ).toBe(0);
    }
  });
});
