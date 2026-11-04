/**
 * An activator's `unless` (`WorkerUnless`, `@synap-core/types/workers`): the
 * worker leaves out a subject that carries the property, before it proposes
 * or starts anything. The case that asked for it: Content OS's Repurpose
 * (`enters_status: Published`, propose) filed one proposal per account a post
 * went out on, because each copy or repost written for another account
 * (`post-copy-of`) enters Published too. With `unless: { property:
 * "post-copy-of", present: true }` the original files one; a copy files none.
 *
 * SEAM: the real step (`executePlaybookRun`) with the subject read from a
 * stubbed `db.query.entities.findFirst` (the row the step reads), the runner
 * and the propose door recorded. Asserted: what the step returns, and whether
 * the runner / the proposal door were reached at all.
 *
 * NOT covered: the compile that puts `unless` on the node's worker spec
 * (`playbook-activators.test.ts`), the schema that admits it
 * (`playbook-process.unless.test.ts` there), the matcher firing the rule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  proposals: 0,
  subject: null as null | { id: string; workspaceId: string | null; properties: Record<string, unknown> | null },
}));

vi.mock("@synap/database", () => ({
  db: { query: { entities: { findFirst: async () => h.subject } } },
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  isNull: (...a: unknown[]) => a,
  entities: { id: "id" },
  events: {},
  countWorkerPendingApprovals: async () => 0,
  WORKER_HELD_OUTPUT_KEY: "__held",
}));
vi.mock("../capability-dispatch.js", () => ({
  getPlaybookRunner: () => async (input: Record<string, unknown>) => {
    h.runs.push(input);
    return { run: { id: "r-1", status: "running" }, session: { id: "s-1", channelId: null } };
  },
  getSessionScheduler: () => null,
  getPlaybookReadinessGate: () => async () => ({ ready: true }),
}));
vi.mock("../../utils/automation-governance.js", () => ({
  guardProducerEffect: async () => ({ proceed: true }),
  PolicyBlockedError: class extends Error {},
  proposeRulePlaybookRun: async () => {
    h.proposals++;
    return { proposalId: "p-1", deduped: false };
  },
}));

const { executePlaybookRun } = await import("./playbook-run.js");

const REPURPOSE_WORKER = {
  key: "enters_status:Published",
  size: "per_thing" as const,
  profileSlug: "post",
  status: "Published",
  unless: { property: "post-copy-of", present: true as const },
};

const step = (data: Record<string, unknown>) =>
  executePlaybookRun(
    { playbookId: "pb-repurpose", playbookName: "Repurpose", ...data } as never,
    { trigger: { payload: {}, subject: "post-1" }, steps: {} } as never,
    "ws-1",
    "owner-1",
    { automationId: "auto-1", automationRunId: "run-1" } as never
  );

const post = (properties: Record<string, unknown>) => ({ id: "post-1", workspaceId: "ws-1", properties });

beforeEach(() => {
  h.runs.length = 0;
  h.proposals = 0;
  h.subject = null;
});

describe("an activator's unless leaves the thing out", () => {
  it("a copy (it carries post-copy-of) files NO proposal: the step is skipped by name", async () => {
    h.subject = post({ "post-status": "Published", "post-copy-of": "post-0" });
    const out = await step({ mode: "propose", worker: REPURPOSE_WORKER });
    expect(out).toEqual({ status: "skipped", reason: "unless_property", property: "post-copy-of" });
    expect(h.proposals).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("the original (no post-copy-of) files its one proposal", async () => {
    h.subject = post({ "post-status": "Published" });
    const out = await step({ mode: "propose", worker: REPURPOSE_WORKER });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-1" });
    expect(h.proposals).toBe(1);
  });

  it("a run-mode worker starts nothing for a left-out thing, and runs an original", async () => {
    h.subject = post({ "post-copy-of": "post-0" });
    await step({ mode: "run", worker: REPURPOSE_WORKER });
    expect(h.runs).toHaveLength(0);
    h.subject = post({});
    await step({ mode: "run", worker: REPURPOSE_WORKER });
    expect(h.runs).toHaveLength(1);
  });

  it("an empty value is not present: an empty string or list leaves nothing out", async () => {
    h.subject = post({ "post-copy-of": "  " });
    await step({ mode: "propose", worker: REPURPOSE_WORKER });
    h.subject = post({ "post-copy-of": [] });
    await step({ mode: "propose", worker: REPURPOSE_WORKER });
    expect(h.proposals).toBe(2);
  });

  it("a worker with no unless is unchanged: a copy files its proposal as before", async () => {
    h.subject = post({ "post-copy-of": "post-0" });
    const { unless: _unless, ...plain } = REPURPOSE_WORKER;
    void _unless;
    await step({ mode: "propose", worker: plain });
    expect(h.proposals).toBe(1);
  });
});
