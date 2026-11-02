/**
 * The governed rule door accepts ONE project-scoped schedule: a clock whose
 * every action runs a playbook filed in that project — what a schedule worker
 * enabled on a goal compiles to (goals that run, G). Any other project-scoped
 * schedule is refused as before (`scope.tripwire.test.ts`).
 *
 * Driven from the worker's own compile (`activatorRuleDecl` →
 * `compileRuleSentence`), never a hand-built flow, so the test breaks if the
 * worker stops compiling to what the exception admits.
 */
import { describe, expect, it } from "vitest";
import { activatorRuleDecl } from "../playbooks/playbook-activators.js";
import { compileRuleSentence } from "./compile.js";
import { applyRuleProjectScope, isClockFiledInProject } from "./scope.js";

const P = "77777777-7777-4777-8777-777777777777";
const T = "99999999-9999-4999-8999-999999999991";

function scheduleWorker(scope?: { projectId: string; trackId?: string }) {
  const decl = activatorRuleDecl({
    activator: { on: "schedule", cron: "0 9 * * *", mode: "propose" },
    playbookId: "66666666-6666-4666-8666-666666666666",
    playbookName: "Daily security check",
    profileSlug: "task",
    statusProperty: null,
    subject: { profileKind: "kind", lifecycleProperty: null },
    ...(scope ? { scope } : {}),
  });
  if (!("sentence" in decl)) throw new Error("schedule worker did not compile");
  const compiled = compileRuleSentence(decl.sentence as never);
  if (!compiled.ok) throw new Error(compiled.failure.reason);
  return compiled;
}

describe("a schedule worker enabled on a goal passes the ONE rule door", () => {
  it("its clock files every run in the goal's project: accepted, trigger unchanged", () => {
    const compiled = scheduleWorker({ projectId: P, trackId: T });
    expect(compiled.trigger.triggerType).toBe("cron");
    expect(isClockFiledInProject(compiled, P)).toBe(true);
    const scoped = applyRuleProjectScope(compiled, P);
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.compiled.trigger).toEqual(compiled.trigger);
    expect(scoped.scopeNote).toMatch(/every run is filed/);
  });

  it("the same clock scoped to ANOTHER project is refused by the WHEN", () => {
    const compiled = scheduleWorker({ projectId: P, trackId: T });
    const other = applyRuleProjectScope(
      compiled,
      "88888888-8888-4888-8888-888888888888"
    );
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.failure.clause).toBe("WHEN");
  });

  it("a space-wide schedule worker scoped to a project files nothing there: refused", () => {
    const compiled = scheduleWorker();
    expect(applyRuleProjectScope(compiled, P).ok).toBe(false);
  });

  it("a schedule with nothing but its trigger node files nothing: refused", () => {
    expect(
      isClockFiledInProject(
        {
          trigger: {
            triggerType: "cron",
            triggerConfig: { expression: "0 9 * * *" },
          },
          flow: { nodes: [{ type: "trigger", data: {} }] },
        },
        P
      )
    ).toBe(false);
  });

  it("a plain project-scoped schedule that does something else keeps being refused", () => {
    expect(
      isClockFiledInProject(
        {
          trigger: {
            triggerType: "cron",
            triggerConfig: { expression: "0 9 * * *" },
          },
          flow: {
            nodes: [
              { type: "trigger", data: {} },
              { type: "playbook_run", data: { projectId: P } },
              { type: "output", data: { outputType: "send_message" } },
            ],
          },
        },
        P
      )
    ).toBe(false);
  });
});
