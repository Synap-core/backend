/**
 * A pod-wide ROLE attach reaches the automation matcher.
 *
 * Founder pod 2026-10-13: a lead captured by an agent lands pod-wide (its facet
 * carries no workspace), and the matcher reactor dropped every null-workspace
 * event except an inbound message — so CRM's "Qualify a lead" activator
 * (`entity_facet.attach.completed`, filter `profileSlug: lead`) never fired.
 * The matcher already matches a null-workspace event across the user's spaces
 * and runs it in the automation's own space; the reactor must hand it over.
 *
 * Not widened, pinned below: any other pod-wide event (an entity create, a
 * facet update or detach) still does not reach the matcher.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn(async (..._args: unknown[]) => "job-id");

vi.mock("../boss.js", () => ({ getBoss: () => ({ send }) }));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: { server: { vectorSearchEnabled: true } },
}));

const { emitSideEffects } = await import("../side-effects.js");

const matcherJobs = () =>
  send.mock.calls
    .filter((c) => c[0] === "automation-trigger-match")
    .map((c) => c[1] as Record<string, unknown>);

beforeEach(() => send.mockClear());

describe("automation matcher reactor — pod-wide role attach", () => {
  it("hands a pod-wide lead attach to the matcher, profileSlug in data", async () => {
    await emitSideEffects({
      subjectType: "entity_facet",
      action: "attach",
      subjectId: "facet-1",
      userId: "user-1",
      workspaceId: null,
      data: { entityId: "entity-1", facetId: "facet-1", profileSlug: "lead" },
    });
    const jobs = matcherJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      eventType: "entity_facet.attach.completed",
      workspaceId: null,
      data: { profileSlug: "lead" },
    });
  });

  it("still keeps other pod-wide events away from the matcher", async () => {
    for (const [subjectType, action] of [
      ["entity", "create"],
      ["entity_facet", "update"],
      ["entity_facet", "detach"],
    ] as const) {
      await emitSideEffects({
        subjectType,
        action,
        subjectId: "x",
        userId: "user-1",
        workspaceId: null,
        data: {},
      });
    }
    expect(matcherJobs()).toHaveLength(0);
  });
});
