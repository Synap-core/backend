/**
 * An activator's `only` (`WorkerOnly`, `@synap-core/types/workers`): the
 * worker keeps a subject only when its property holds one of the listed
 * values, before it proposes or starts anything. The case that asked for it:
 * Content OS splits production by what is made (text, image, video), each
 * process proposing its own run when a post enters Briefed; with `only` on
 * `post-format`, a carousel files no video proposal and a video no carousel one.
 *
 * SEAM: the real step (`executePlaybookRun`) with the subject read from a
 * stubbed `db.query.entities.findFirst`, the runner and the propose door
 * recorded, as `playbook-run.unless.test.ts`.
 *
 * NOT covered: the compile that puts `only` on the node's worker spec and the
 * schema that admits it (`playbook-activators.test.ts`), the matcher firing it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  proposals: 0,
  subject: null as null | {
    id: string;
    workspaceId: string | null;
    properties: Record<string, unknown> | null;
  },
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
    return {
      run: { id: "r-1", status: "running" },
      session: { id: "s-1", channelId: null },
    };
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

const VIDEO_WORKER = {
  key: "enters_status:Briefed",
  size: "per_thing" as const,
  profileSlug: "post",
  status: "Briefed",
  only: { property: "post-format", in: ["Short Video", "Long Video"] },
};

const step = (data: Record<string, unknown>) =>
  executePlaybookRun(
    {
      playbookId: "pb-video",
      playbookName: "Produce a video",
      ...data,
    } as never,
    { trigger: { payload: {}, subject: "post-1" }, steps: {} } as never,
    "ws-1",
    "owner-1",
    { automationId: "auto-1", automationRunId: "run-1" } as never
  );

const post = (properties: Record<string, unknown>) => ({
  id: "post-1",
  workspaceId: "ws-1",
  properties,
});

beforeEach(() => {
  h.runs.length = 0;
  h.proposals = 0;
  h.subject = null;
});

describe("an activator's only keeps a thing by its value", () => {
  it("a carousel files NO video proposal: the step is skipped by name", async () => {
    h.subject = post({ "post-status": "Briefed", "post-format": "Carousel" });
    const out = await step({ mode: "propose", worker: VIDEO_WORKER });
    expect(out).toEqual({
      status: "skipped",
      reason: "only_values",
      property: "post-format",
    });
    expect(h.proposals).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("a video post files its one proposal, whatever the case of its value", async () => {
    h.subject = post({
      "post-status": "Briefed",
      "post-format": "short video",
    });
    const out = await step({ mode: "propose", worker: VIDEO_WORKER });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-1" });
    expect(h.proposals).toBe(1);
  });

  it("a run-mode worker starts nothing for an unlisted value, and runs a listed one", async () => {
    h.subject = post({ "post-format": "Article" });
    await step({ mode: "run", worker: VIDEO_WORKER });
    expect(h.runs).toHaveLength(0);
    h.subject = post({ "post-format": "Long Video" });
    await step({ mode: "run", worker: VIDEO_WORKER });
    expect(h.runs).toHaveLength(1);
  });

  it("a post with no format is left out: only keeps what it names", async () => {
    h.subject = post({ "post-status": "Briefed" });
    const out = await step({ mode: "propose", worker: VIDEO_WORKER });
    expect(out).toMatchObject({ status: "skipped", reason: "only_values" });
    expect(h.proposals).toBe(0);
  });

  it("a worker with no only is unchanged: a carousel files its proposal as before", async () => {
    const { only: _only, ...plain } = VIDEO_WORKER;
    h.subject = post({ "post-format": "Carousel" });
    const out = await step({ mode: "propose", worker: plain });
    expect(out).toMatchObject({ status: "proposed" });
    expect(h.proposals).toBe(1);
  });
});
