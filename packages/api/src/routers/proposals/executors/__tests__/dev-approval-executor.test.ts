/**
 * DEV-LOOP GATES — approval RECORDS on the session, and records nothing else.
 *
 * Two properties are pinned here, and they are the whole design:
 *
 * 1. THE STAMP LANDS. Approving `dev.plan_approval` / `dev.deploy_approval`
 *    writes the decision onto the session (`metadata.devLoop.<gate>` plus a
 *    `current_stage` advance) — because the agent polling the pod reads exactly
 *    that, and a gate that flips a proposal green without stamping is a gate
 *    the agent never sees clear. This is the `focus_session/*` half of the
 *    severed-approval-door class: an executor that returned `{ success: true }`
 *    over no write at all.
 *
 * 2. THE EXECUTOR NEVER RUNS A COMMAND. The payload carries `gateCommand` /
 *    `deployCommand` as a DISCLOSURE for the reviewer. If approval executed
 *    them, every reviewer tapping Approve on a phone would be a remote-shell
 *    trigger. Pinned by SOURCE SCAN below, not by assertion on behaviour — a
 *    behavioural test can only prove the command was not run on THIS path,
 *    while the scan proves no process-spawning import exists in the module at
 *    all. That is the property that must hold for every future edit.
 *
 * Plus the shallow-merge trap: `mergeSessionMetadata` is a JSONB `||`, so the
 * `devLoop` KEY is replaced wholesale. The deploy gate must fold the plan
 * gate's stamp forward or approving deploy erases the record that a plan was
 * ever approved.
 *
 * COVERAGE STYLE matches the sibling suites (the api suite has no live
 * Postgres): the executor runs for real against a stubbed `db`, so the return
 * value and the UPDATE payload — the things under test — are real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/** Every `db.update(...).set(...)` payload, tagged by table. */
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** What `db.query.focusSessions.findFirst` returns; null = session is gone. */
let sessionRow: Record<string, unknown> | null = null;
/** What the proposal-status pre-read returns (drives the idempotency guard). */
let proposalStatus: string | undefined = "pending";
/** Rows the focus-session UPDATE's `.returning()` reports. */
let updateReturns: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock ON PURPOSE — a total replacement silently kills every other
  // export the module imports (`proposals`, `focusSessions`, `eq`, `drizzleSql`)
  // the moment a new one is added, with typecheck still green.
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tableName = (t: unknown): string =>
    t === actual.focusSessions ? "focus_sessions" : "proposals";
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () =>
            proposalStatus === undefined ? [] : [{ status: proposalStatus }],
        }),
      }),
      query: {
        focusSessions: {
          findFirst: async () => sessionRow,
        },
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          const entry = { table: tableName(table), values };
          const where = () => {
            updates.push(entry);
            return {
              returning: async () => updateReturns,
              then: (resolve: (v: unknown) => unknown) => resolve(undefined),
            };
          };
          return { where };
        },
      }),
    },
  };
});

vi.mock("../../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => {},
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerDevApprovalExecutors } from "../dev-approval.js";
import {
  DEV_DEPLOY_APPROVAL_TYPE,
  DEV_PLAN_APPROVAL_TYPE,
} from "../../../../services/proposals/dev-approval.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function args(
  proposalType: string,
  data: Record<string, unknown>
): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "focus_session",
      targetId: SESSION_ID,
      proposalType,
      workspaceId: "ws-1",
      sessionId: SESSION_ID,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data,
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  };
}

const PLAN_PAYLOAD = {
  sessionId: SESSION_ID,
  repo: "synap-backend",
  branch: "feat/dev-loop",
  planMarkdown: "## Plan\n\n1. Do the thing",
  gateCommand: "pnpm typecheck && pnpm test",
  changeType: "plan_approval",
};

const DEPLOY_PAYLOAD = {
  sessionId: SESSION_ID,
  repo: "synap-backend",
  branch: "feat/dev-loop",
  commitSha: "0a1b2c3d4e5f60718293",
  targetHost: "pod-prod (eve)",
  deployCommand: "./deploy/ship.sh",
  gateReport: { passed: true, summary: "342 passed" },
  changeType: "deploy_approval",
};

function executor(key: string) {
  const ex = proposalExecRegistry.resolveExact(key);
  if (!ex) throw new Error(`executor not registered: ${key}`);
  return ex;
}

function sessionUpdate() {
  const row = updates.find((u) => u.table === "focus_sessions");
  if (!row) throw new Error("no focus_sessions UPDATE was performed");
  return row.values;
}

/**
 * Render the `metadata` SQL fragment's literal text + bound params as one
 * string. `mergeSessionMetadata` returns a drizzle `SQL` whose chunks hold a
 * live table reference, so `JSON.stringify` on it throws on the cycle — the
 * stamp we actually want to assert on is a BOUND PARAM inside it.
 */
function metadataSqlText(values: Record<string, unknown>): string {
  const chunks =
    (values.metadata as { queryChunks?: unknown[] } | undefined)?.queryChunks ??
    [];
  if (chunks.length === 0) {
    throw new Error(
      "metadata was not a SQL fragment — a plain object here would CLOBBER the bag"
    );
  }
  return chunks
    .map((chunk) => {
      // Literal text arrives as a `StringChunk` (`.value: string[]`); a bound
      // JSON param arrives as a BOXED `String` object with no `.value` at all —
      // reading only `.value` silently rendered every stamp as the empty string
      // and made the assertions vacuous.
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.join("");
      if (typeof chunk === "string" || chunk instanceof String) {
        return String(chunk);
      }
      return "";
    })
    .join(" ");
}

beforeEach(() => {
  updates.length = 0;
  proposalStatus = "pending";
  updateReturns = [{ id: SESSION_ID, currentStage: "plan_approved" }];
  sessionRow = {
    id: SESSION_ID,
    metadata: {},
    workspaceId: "ws-1",
    goal: "Ship the dev loop",
  };
  proposalExecRegistry._reset();
  registerDevApprovalExecutors();
});
afterEach(() => proposalExecRegistry._reset());

describe("registration", () => {
  it("registers both gates under their composite door keys", () => {
    expect(
      proposalExecRegistry.resolveExact("focus_session/dev.plan_approval")
    ).toBeDefined();
    expect(
      proposalExecRegistry.resolveExact("focus_session/dev.deploy_approval")
    ).toBeDefined();
  });
});

describe("apply stamps the session", () => {
  it("plan approval records the decision and advances the stage", async () => {
    const result = await executor("focus_session/dev.plan_approval").execute(
      args(DEV_PLAN_APPROVAL_TYPE, PLAN_PAYLOAD)
    );

    const values = sessionUpdate();
    expect(values.currentStage).toBe("plan_approved");
    // `metadata` is a drizzle SQL fragment (the JSONB `||` merge), and the
    // stamp is serialized INTO it — assert on the serialized parameter rather
    // than a plain object, so a regression to a clobbering `.set({metadata: {}})`
    // is visible instead of quietly passing.
    const metadataSql = metadataSqlText(values);
    expect(metadataSql).toContain("devLoop");
    expect(metadataSql).toContain("human-1");
    expect(metadataSql).toContain("pnpm typecheck");

    // The receipt is built from the UPDATE's own returning() rows.
    expect(result.effect).toEqual({
      applied: "verified",
      rows: 1,
      ids: [SESSION_ID],
      subject: "focus_session",
    });
    expect(result.success).toBe(true);
  });

  it("deploy approval records the commit, host and gate outcome", async () => {
    updateReturns = [{ id: SESSION_ID, currentStage: "deploy_approved" }];
    await executor("focus_session/dev.deploy_approval").execute(
      args(DEV_DEPLOY_APPROVAL_TYPE, DEPLOY_PAYLOAD)
    );

    const values = sessionUpdate();
    expect(values.currentStage).toBe("deploy_approved");
    const metadataSql = metadataSqlText(values);
    expect(metadataSql).toContain("0a1b2c3d4e5f60718293");
    expect(metadataSql).toContain("pod-prod (eve)");
    expect(metadataSql).toContain('"gatePassed":true');
  });

  it("reads a payload nested under data.data as well as a flat one", async () => {
    // Gate-made proposals nest the write under `data.data`; a directly-filed
    // one is flat. Both must stamp — reading only one shape is how a door's
    // approval half ends up stamping an empty object.
    await executor("focus_session/dev.plan_approval").execute(
      args(DEV_PLAN_APPROVAL_TYPE, { data: PLAN_PAYLOAD })
    );
    expect(metadataSqlText(sessionUpdate())).toContain("pnpm typecheck");
  });

  it("deploy does NOT erase the plan stamp (shallow JSONB merge trap)", async () => {
    sessionRow = {
      id: SESSION_ID,
      metadata: {
        devLoop: {
          plan: { approvedAt: "2026-09-01T00:00:00.000Z", proposalId: "p-0" },
        },
      },
      workspaceId: "ws-1",
      goal: "Ship the dev loop",
    };
    await executor("focus_session/dev.deploy_approval").execute(
      args(DEV_DEPLOY_APPROVAL_TYPE, DEPLOY_PAYLOAD)
    );
    const metadataSql = metadataSqlText(sessionUpdate());
    // Both halves survive: `devLoop` is REPLACED by the merge, so the executor
    // must fold the existing sub-object forward.
    expect(metadataSql).toContain("p-0");
    expect(metadataSql).toContain("0a1b2c3d4e5f60718293");
  });

  it("flips the proposal to approved with the reviewer stamped", async () => {
    await executor("focus_session/dev.plan_approval").execute(
      args(DEV_PLAN_APPROVAL_TYPE, PLAN_PAYLOAD)
    );
    const proposalRow = updates.find((u) => u.table === "proposals");
    expect(proposalRow?.values.reviewedBy).toBe("human-1");
  });
});

describe("it fails rather than reporting a stamp it did not make", () => {
  it("throws when the session no longer exists", async () => {
    sessionRow = null;
    await expect(
      executor("focus_session/dev.plan_approval").execute(
        args(DEV_PLAN_APPROVAL_TYPE, PLAN_PAYLOAD)
      )
    ).rejects.toThrow(/no longer exists/);
  });

  it("throws when the UPDATE affected zero rows", async () => {
    // The receipt contract: a `verified` effect may only be built from rows the
    // storage engine returned. Zero rows is a failure, never a green approval.
    updateReturns = [];
    await expect(
      executor("focus_session/dev.plan_approval").execute(
        args(DEV_PLAN_APPROVAL_TYPE, PLAN_PAYLOAD)
      )
    ).rejects.toThrow(/no row was updated/);
  });

  it("re-approve is an explained no-op, not a second stamp", async () => {
    proposalStatus = "approved";
    const result = await executor("focus_session/dev.plan_approval").execute(
      args(DEV_PLAN_APPROVAL_TYPE, PLAN_PAYLOAD)
    );
    expect(result.alreadyApproved).toBe(true);
    expect(result.effect?.applied).toBe("none");
    expect(updates).toHaveLength(0);
  });
});

describe("SOURCE SCAN — the executor can never run a command", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "dev-approval.ts"),
    "utf8"
  );

  it("the module exists and is the one under test (self-guard)", () => {
    expect(source).toContain("registerDevApprovalExecutors");
    expect(source.length).toBeGreaterThan(1000);
  });

  it("imports nothing that can spawn a process or touch the filesystem", () => {
    // A behavioural test only proves the command was not run on the path it
    // walked. This proves the CAPABILITY is absent from the module entirely,
    // which is the property that must survive every future edit.
    for (const forbidden of [
      "child_process",
      "node:child_process",
      "execa",
      "node:fs",
      'from "fs"',
      "node:vm",
    ]) {
      expect(
        source,
        `dev-approval.ts must not import ${forbidden}`
      ).not.toContain(forbidden);
    }
    for (const forbidden of ["execSync", "spawn(", "exec(", "eval("]) {
      expect(
        source,
        `dev-approval.ts must not call ${forbidden}`
      ).not.toContain(forbidden);
    }
  });

  it("reads the command strings only to STORE them", () => {
    // `gateCommand` / `deployCommand` appear exactly where they are copied onto
    // the stamp. If either ever appears next to a call, the test above fires.
    expect(source).toContain("gateCommand: asString(payload.gateCommand)");
    expect(source).toContain("deployCommand: asString(payload.deployCommand)");
  });
});
