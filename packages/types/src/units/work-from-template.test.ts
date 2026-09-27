/**
 * The ONE "start from a work template" rule (browser Home + relay new-work +
 * relay capture). Doors are fakes; `startWork` creates, awaits `onCreated`,
 * then opens — the order every surface's join keeps, so the seed is observed
 * at the real join point (BEFORE the open).
 */
import { describe, expect, it, vi } from "vitest";
import {
  describeWorkFromTemplate,
  startWorkFromTemplate,
  type WorkFromTemplateDoors,
} from "./work-from-template.js";
import { matchesTemplateQuery } from "./templates.js";

function doors(
  overrides: Partial<WorkFromTemplateDoors> & { deduped?: boolean } = {}
) {
  const calls: string[] = [];
  const { deduped, ...rest } = overrides;
  const d: WorkFromTemplateDoors = {
    getTemplate: vi.fn(async () => ({
      stages: [
        { key: "frame", name: "Frame", category: "plan" },
        { key: "ship", name: "Ship", category: "execute" },
      ],
    })),
    seedSteps: vi.fn(async (input: { id: string; stages: unknown[] }) => {
      calls.push(`seed:${input.id}:${input.stages.length}`);
      return { id: input.id };
    }),
    startWork: vi.fn(async (goal, onCreated) => {
      calls.push(`create:${goal}`);
      const created = { id: deduped ? "twin" : "s-1", deduped };
      await onCreated(created);
      calls.push(`open:${created.id}`);
      return created.id;
    }),
    ...rest,
  };
  return { d, calls };
}

const T = { id: "tpl", name: "Weekly review" };

describe("startWorkFromTemplate: seeds, never binds", () => {
  it("creates plain work, copies the steps, THEN opens it", async () => {
    const { d, calls } = doors();
    const out = await startWorkFromTemplate(d, {
      goal: "Q3 review",
      template: T,
    });
    expect(out).toEqual({ kind: "started", sessionId: "s-1", steps: 2 });
    expect(calls).toEqual(["create:Q3 review", "seed:s-1:2", "open:s-1"]);
    // Never a binding: the join is handed only a goal, no template id.
    expect(d.startWork).toHaveBeenCalledWith("Q3 review", expect.any(Function));
  });

  it("with no typed goal, the goal is the template name", async () => {
    const { d, calls } = doors();
    await startWorkFromTemplate(d, { goal: "  ", template: T });
    expect(calls[0]).toBe("create:Weekly review");
  });

  it("a failed template read starts NOTHING (not blank work that lost its steps)", async () => {
    const { d } = doors({
      getTemplate: vi.fn(async () => {
        throw new Error("500");
      }),
    });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out.kind).toBe("refused");
    expect(d.startWork).not.toHaveBeenCalled();
  });

  it("a reused twin is opened as it is, never re-seeded", async () => {
    const { d } = doors({ deduped: true });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({ kind: "reused", sessionId: "twin" });
    expect(d.seedSteps).not.toHaveBeenCalled();
  });

  it("a failed seed is SAID; the work still opens", async () => {
    const { d, calls } = doors({
      seedSteps: vi.fn(async () => {
        throw new Error("bad category");
      }),
    });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({
      kind: "unseeded",
      sessionId: "s-1",
      message: "bad category",
    });
    expect(calls).toContain("open:s-1");
    expect(describeWorkFromTemplate(out, "T")?.tone).toBe("error");
  });

  it("a join that created nothing is refused, not started", async () => {
    const { d } = doors({ startWork: vi.fn(async () => null) });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out.kind).toBe("refused");
  });

  it("a join that THROWS is refused with its reason, never an unhandled rejection", async () => {
    const { d } = doors({
      startWork: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({
      kind: "refused",
      message: "Couldn't start Weekly review: offline",
    });
  });

  it("a template with no steps starts quietly (landing says it)", async () => {
    const { d } = doors({ getTemplate: vi.fn(async () => ({ stages: [] })) });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({ kind: "started", sessionId: "s-1", steps: 0 });
    expect(d.seedSteps).not.toHaveBeenCalled();
    expect(describeWorkFromTemplate(out, "T")).toBeNull();
  });

  it('says "steps", the glossary word, never "phases"', () => {
    const text = describeWorkFromTemplate(
      { kind: "started", sessionId: "s", steps: 3 },
      "T"
    )?.text;
    expect(text).toContain("3 steps");
    expect(text).not.toMatch(/phase/i);
  });
});

describe("matchesTemplateQuery: the picker input filters AND is the goal", () => {
  const r = { name: "Weekly review", description: "Look back at the week" };
  it("empty matches all; name and description match case-insensitively", () => {
    expect(matchesTemplateQuery(r, "  ")).toBe(true);
    expect(matchesTemplateQuery(r, "WEEKLY")).toBe(true);
    expect(matchesTemplateQuery(r, "look back")).toBe(true);
  });
  it("a goal that names no template matches none (Just start still takes it)", () => {
    expect(matchesTemplateQuery(r, "Draft the Q3 pricing page")).toBe(false);
    expect(matchesTemplateQuery({ name: "x", description: null }, "y")).toBe(
      false
    );
  });
});
