/**
 * workflow-place proposal attribution — security/correctness gate (DB-gated).
 *
 * `loadProposals` used to attribute a proposal to a workflow via `sessionId`
 * ONLY. An automation step run has no focus session, so EVERY
 * automation-produced proposal was invisible: the workflow place showed a run
 * that demonstrably created proposals next to an empty proposals list. It now
 * ALSO attributes via the stamped chain
 *   `proposals.step_run_id → automation_step_runs.run_id → automation_runs.automation_id`.
 *
 * That new branch widens WHICH rows the OR admits, so the thing that must not
 * move is the floor ANDed OUTSIDE it:
 *   `and(or(session…, stepRun…), userVisibleWhere(proposals.workspaceId, userId))`
 * If the floor had been folded INTO the `or(...)` — or omitted on the new
 * branch — a caller who can see the automation would read the title/type/status
 * of proposals living in workspaces they are not a member of. This suite pins
 * that behaviourally against real rows, not by inspecting the composed query.
 *
 * Harness: matches `routers/graph-relations-visibility.test.ts` /
 * `services/signal/signal.capability-lens-db.test.ts` — real postgres.js (NO db
 * mock), fixed UUID fixtures, a module-level `checkDb()` probe so
 * `describe.skipIf` reports an honest SKIP (never a vacuous PASS) when PG is
 * down, and symmetric cleanup in beforeAll + afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  users,
  workspaces,
  workspaceMembers,
  automations,
  automationRuns,
  automationStepRuns,
  playbooks,
  focusSessions,
  proposals,
  drizzleSql,
  eq,
  inArray,
} from "@synap/database";
import { randomUUID } from "crypto";
import { getWorkflowPlace } from "./index.js";

const USERS = {
  // Owns WS_VISIBLE, where the automation lives. The caller under test.
  CALLER: "77770000-0000-0000-0000-0000000000a1",
  // Owns WS_HIDDEN. CALLER is NOT a member of it.
  OTHER: "77770000-0000-0000-0000-0000000000b2",
} as const;

const WS_VISIBLE = "77770000-0000-0000-0000-0000000000f1";
const WS_HIDDEN = "77770000-0000-0000-0000-0000000000f2";

/**
 * The automation AND the playbook deliberately share this id — see the playbook
 * guard test below. Distinct tables, no cross-table constraint, so this is a
 * legal (and adversarial) fixture.
 */
const WORKFLOW_ID = "77770000-0000-0000-0000-00000000a001";
const RUN_ID = "77770000-0000-0000-0000-00000000c001";
const STEP_RUN_ID = "77770000-0000-0000-0000-00000000d001";
const SESSION_ID = "77770000-0000-0000-0000-000000005e01";

const P_STEPRUN = "77770000-0000-0000-0000-0000000000e1"; // step-run chain, visible ws
const P_SESSION = "77770000-0000-0000-0000-0000000000e2"; // legacy session path
const P_HIDDEN = "77770000-0000-0000-0000-0000000000e3"; // step-run chain, HIDDEN ws
const ALL_PROPOSALS = [P_STEPRUN, P_SESSION, P_HIDDEN];

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

// Probed ONCE at module load so the gate is settled when `describe.skipIf` is
// evaluated — an `if (!dbAvailable) return` inside each `it` scores as ✓ passed
// with no database, i.e. a security proof that proves nothing while green.
const dbAvailable = await checkDb();

async function cleanup() {
  await db.delete(proposals).where(inArray(proposals.id, ALL_PROPOSALS));
  await db.delete(focusSessions).where(eq(focusSessions.id, SESSION_ID));
  await db
    .delete(automationStepRuns)
    .where(eq(automationStepRuns.id, STEP_RUN_ID));
  await db.delete(automationRuns).where(eq(automationRuns.id, RUN_ID));
  await db.delete(automations).where(eq(automations.id, WORKFLOW_ID));
  await db.delete(playbooks).where(eq(playbooks.id, WORKFLOW_ID));
  for (const ws of [WS_VISIBLE, WS_HIDDEN]) {
    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, ws));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
  }
  for (const id of Object.values(USERS)) {
    await db.delete(users).where(eq(users.id, id));
  }
}

// Anti-skip sanity — NEVER gated. When PG is down the suites below report
// SKIPPED, never PASSED.
describe("workflow-place proposal attribution — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)("workflow-place — loadProposals", () => {
  beforeAll(async () => {
    await cleanup();

    for (const [key, id] of Object.entries(USERS)) {
      await db
        .insert(users)
        .values({
          id,
          email: `wfplace-${key.toLowerCase()}@test.synap`,
          userType: "human",
        })
        .onConflictDoNothing();
    }

    // WS_VISIBLE: owned by CALLER (the `ownedWorkspaceIds` branch of the floor).
    // OTHER is a MEMBER here too, so OTHER can also load the automation's place —
    // that symmetry is what makes the security assertion non-vacuous (below).
    await db.insert(workspaces).values({
      id: WS_VISIBLE,
      name: "Visible WS",
      ownerId: USERS.CALLER,
    });
    await db.insert(workspaceMembers).values({
      id: randomUUID(),
      workspaceId: WS_VISIBLE,
      userId: USERS.OTHER,
      role: "editor",
    });

    // WS_HIDDEN: owned by OTHER, CALLER has no member row and it is not
    // pod-visible (settings default `{}` → no `workspaceVisibility` key), so it
    // fails every branch of `userVisibleWhere` for CALLER.
    await db.insert(workspaces).values({
      id: WS_HIDDEN,
      name: "Hidden WS",
      ownerId: USERS.OTHER,
    });

    await db.insert(automations).values({
      id: WORKFLOW_ID,
      workspaceId: WS_VISIBLE,
      createdBy: USERS.CALLER,
      name: "Attribution fixture",
      triggerType: "manual",
      status: "active",
    });

    await db.insert(automationRuns).values({
      id: RUN_ID,
      automationId: WORKFLOW_ID,
      workspaceId: WS_VISIBLE,
      status: "completed",
      triggeredBy: USERS.CALLER,
    });

    await db.insert(automationStepRuns).values({
      id: STEP_RUN_ID,
      runId: RUN_ID,
      nodeId: "node-propose",
      status: "completed",
    });

    // The legacy (human/agent) path: a focus session of this automation, keyed
    // by the `metadata.automationId` convention `sessionScopeWhere` reads.
    await db.insert(focusSessions).values({
      id: SESSION_ID,
      workspaceId: WS_VISIBLE,
      userId: USERS.CALLER,
      goal: "Attribution fixture session",
      status: "active",
      metadata: { automationId: WORKFLOW_ID },
    });

    await db.insert(proposals).values([
      {
        id: P_STEPRUN,
        workspaceId: WS_VISIBLE,
        targetType: "entity",
        targetId: "target-steprun",
        proposalType: "entity.create",
        data: {},
        stepRunId: STEP_RUN_ID,
        nodeId: "node-propose",
      },
      {
        id: P_SESSION,
        workspaceId: WS_VISIBLE,
        targetType: "entity",
        targetId: "target-session",
        proposalType: "entity.create",
        data: {},
        sessionId: SESSION_ID,
      },
      {
        // Same step run — so it IS on the chain — but in a workspace CALLER
        // cannot see. Only the floor can keep this out.
        id: P_HIDDEN,
        workspaceId: WS_HIDDEN,
        targetType: "entity",
        targetId: "target-hidden",
        proposalType: "entity.create",
        data: {},
        stepRunId: STEP_RUN_ID,
      },
    ]);
  });

  afterAll(cleanup);

  it("attributes a step-run-stamped proposal to its automation (the new path)", async () => {
    // The regression this branch fixes: an automation step run has no focus
    // session, so before the chain existed this proposal was unreachable and the
    // place rendered "0 proposals" next to a run that had just created one.
    const place = await getWorkflowPlace({
      kind: "automation",
      id: WORKFLOW_ID,
      userId: USERS.CALLER,
    });

    expect(place).not.toBeNull();
    expect(place!.proposals.map((p) => p.id)).toContain(P_STEPRUN);
  });

  it("still attributes a session-stamped proposal (the new path is ADDITIVE)", async () => {
    // The two stamps are ORed, not swapped: the human/agent path must survive
    // the automation path being added, or fixing the automation blind spot would
    // simply move it onto playbook/session-origin proposals.
    const place = await getWorkflowPlace({
      kind: "automation",
      id: WORKFLOW_ID,
      userId: USERS.CALLER,
    });

    const ids = place!.proposals.map((p) => p.id);
    expect(ids).toContain(P_SESSION);
    // Both stamps in ONE result set — proof it is a union, not a branch that
    // shadows the other.
    expect(ids).toEqual(expect.arrayContaining([P_STEPRUN, P_SESSION]));
  });

  it("does NOT return a chain-reachable proposal from a workspace the caller cannot see (THE FLOOR)", async () => {
    // THE security assertion. `P_HIDDEN` carries the SAME `step_run_id` as
    // `P_STEPRUN`, so the `or(...)` attribution admits it — the ONLY thing that
    // excludes it is `userVisibleWhere(proposals.workspaceId, userId)` ANDed
    // outside the or. Fold that floor inside the or (or drop it on the new
    // branch) and this test goes red.
    const place = await getWorkflowPlace({
      kind: "automation",
      id: WORKFLOW_ID,
      userId: USERS.CALLER,
    });

    expect(place!.proposals.map((p) => p.id)).not.toContain(P_HIDDEN);
  });

  it("the excluded proposal IS on the chain and IS visible to a caller who can see its workspace (non-vacuity)", async () => {
    // Guards the test above from passing for the wrong reason. Two independent
    // proofs that the exclusion is the FLOOR, not a chain that never matched:
    //
    //   1. the raw chain: P_HIDDEN shares P_STEPRUN's step run, so any
    //      attribution built on `step_run_id` reaches it;
    //   2. OTHER — a member of WS_VISIBLE (so `loadDefinition` admits the
    //      automation) and owner of WS_HIDDEN — reads the SAME workflow place
    //      and DOES get P_HIDDEN back.
    const chain = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.stepRunId, STEP_RUN_ID));
    expect(chain.map((r) => r.id)).toEqual(
      expect.arrayContaining([P_STEPRUN, P_HIDDEN])
    );

    const otherPlace = await getWorkflowPlace({
      kind: "automation",
      id: WORKFLOW_ID,
      userId: USERS.OTHER,
    });
    expect(otherPlace).not.toBeNull();
    expect(otherPlace!.proposals.map((p) => p.id)).toContain(P_HIDDEN);
  });

  it("a playbook does NOT walk the automation step-run chain, and a session-less playbook short-circuits", async () => {
    // Only automations own `automation_step_runs`. The guard is the
    // `kind === "automation"` ternary — a playbook must not build the subselect
    // at all, and with no sessions `loadProposals` returns [] before querying.
    //
    // The fixture makes that DISCRIMINATING rather than trivially true: this
    // playbook is given the SAME id as the automation. If the step-run path were
    // built for playbooks too, `automation_runs.automation_id = <that id>` would
    // match RUN_ID and P_STEPRUN would leak into a playbook's place.
    await db.insert(playbooks).values({
      id: WORKFLOW_ID,
      workspaceId: WS_VISIBLE,
      createdBy: USERS.CALLER,
      name: "Session-less playbook (id collides with the automation on purpose)",
      goalTemplate: "noop",
      status: "active",
    });

    const place = await getWorkflowPlace({
      kind: "playbook",
      id: WORKFLOW_ID,
      userId: USERS.CALLER,
    });

    expect(place).not.toBeNull();
    // No `playbook_id` session exists (the fixture session is automation-keyed
    // via metadata), so the session set is empty…
    expect(place!.sessions).toEqual([]);
    // …and the proposal list short-circuits to empty rather than borrowing the
    // automation's chain.
    expect(place!.proposals).toEqual([]);
  });
});
