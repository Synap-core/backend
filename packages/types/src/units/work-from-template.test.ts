/**
 * The ONE "start from a playbook" rule (browser Home + relay new-work + relay
 * capture). Starting from a playbook BINDS it (founder, 27 Nov 2026): the
 * join is handed the playbook id for the pod's start door, and the surface
 * copies no steps. The door is a fake.
 */
import { describe, expect, it, vi } from "vitest";
import {
  describeWorkFromTemplate,
  startWorkFromTemplate,
  type WorkFromTemplateDoors,
} from "./work-from-template.js";
import { matchesTemplateQuery } from "./templates.js";

function doors(overrides: Partial<WorkFromTemplateDoors> = {}) {
  const d: WorkFromTemplateDoors = {
    startWork: vi.fn(async () => ({ id: "s-1" })),
    ...overrides,
  };
  return d;
}

const T = { id: "tpl", name: "Weekly review" };

describe("startWorkFromTemplate: binds the playbook", () => {
  it("starts the session WITH the playbook id, so the pod binds the run", async () => {
    const d = doors();
    const out = await startWorkFromTemplate(d, {
      goal: "Q3 review",
      template: T,
    });
    expect(out).toEqual({ kind: "started", sessionId: "s-1" });
    expect(d.startWork).toHaveBeenCalledTimes(1);
    expect(d.startWork).toHaveBeenCalledWith({
      goal: "Q3 review",
      templateId: "tpl",
    });
  });

  it("with no typed goal, the goal is the playbook name", async () => {
    const d = doors();
    await startWorkFromTemplate(d, { goal: "  ", template: T });
    expect(d.startWork).toHaveBeenCalledWith({
      goal: "Weekly review",
      templateId: "tpl",
    });
  });

  it("a reused twin is opened as it is", async () => {
    const d = doors({
      startWork: vi.fn(async () => ({ id: "twin", deduped: true })),
    });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({ kind: "reused", sessionId: "twin" });
    expect(describeWorkFromTemplate(out, "T")?.tone).toBe("info");
  });

  it("a join that created nothing is refused, not started", async () => {
    const d = doors({ startWork: vi.fn(async () => null) });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({
      kind: "refused",
      message: "Couldn't start Weekly review.",
    });
  });

  it("a join that THROWS (e.g. a playbook you cannot see) is refused with its reason", async () => {
    const d = doors({
      startWork: vi.fn(async () => {
        throw new Error("templateId tpl names no playbook you can see.");
      }),
    });
    const out = await startWorkFromTemplate(d, { goal: "x", template: T });
    expect(out).toEqual({
      kind: "refused",
      message:
        "Couldn't start Weekly review: templateId tpl names no playbook you can see.",
    });
    expect(describeWorkFromTemplate(out, "T")).toEqual({
      tone: "error",
      text: out.kind === "refused" ? out.message : "",
    });
  });

  it("a started run says nothing more: landing on it shows its steps", async () => {
    const out = await startWorkFromTemplate(doors(), {
      goal: "x",
      template: T,
    });
    expect(describeWorkFromTemplate(out, "T")).toBeNull();
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
