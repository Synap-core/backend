import { describe, it, expect } from "vitest";
import { missingRunArgs } from "../executors/playbook.js";

/**
 * The approval-time guard for a proposed playbook run.
 *
 * Before the gate stored run arguments, this refused whenever the PLAYBOOK
 * declared any — so the governed path (the default for every agent) could not
 * run a single parameterised playbook. 14 of the playbooks installed on the
 * live pod declare required params, so that was most of them.
 *
 * The rule now: refuse only when the playbook declares something THIS proposal
 * did not carry. Refusing is still right in that case — replaying a run whose
 * goalTemplate has `{}` substituted into it starts a session under a goal
 * nobody asked for, which is worse than not starting one.
 */
describe("missingRunArgs — approve or refuse a proposed run", () => {
  const base = {
    declaredParamCount: 0,
    hasSubjectProfile: false,
    carriedParams: undefined as Record<string, unknown> | undefined,
    carriedSubjectId: undefined as string | undefined,
  };

  it("a playbook that declares nothing replays exactly", () => {
    expect(missingRunArgs(base).refuse).toBe(false);
  });

  it("THE REGRESSION ROW: declared params that the proposal DID carry are approvable", () => {
    // This is the case that was refused outright before the gate was widened.
    // If it ever goes red again, the governed path has stopped working for
    // every parameterised playbook — not just for this one.
    expect(
      missingRunArgs({
        ...base,
        declaredParamCount: 1,
        carriedParams: { clientName: "Acme" },
      }).refuse
    ).toBe(false);
  });

  it("declared params the proposal did NOT carry are still refused", () => {
    const r = missingRunArgs({ ...base, declaredParamCount: 1 });
    expect(r.refuse).toBe(true);
    expect(r.needsParams).toBe(true);
  });

  it("a subject-profile playbook without a carried subject is refused", () => {
    const r = missingRunArgs({ ...base, hasSubjectProfile: true });
    expect(r.refuse).toBe(true);
    expect(r.needsSubject).toBe(true);
  });

  it("…and is approvable once the subject rides along", () => {
    expect(
      missingRunArgs({
        ...base,
        hasSubjectProfile: true,
        carriedSubjectId: "e1",
      }).refuse
    ).toBe(false);
  });

  it("params carried but subject missing still refuses, and says WHICH", () => {
    // The discriminating row for the two flags being separate: a message that
    // said "params" here would send the reader to fix the wrong thing.
    const r = missingRunArgs({
      ...base,
      declaredParamCount: 1,
      carriedParams: { a: 1 },
      hasSubjectProfile: true,
    });
    expect(r.refuse).toBe(true);
    expect(r.needsParams).toBe(false);
    expect(r.needsSubject).toBe(true);
  });

  it("an EMPTY carried params object counts as carried", () => {
    // `{}` is a caller who supplied nothing for a playbook whose params are all
    // optional — distinct from a proposal filed before the gate stored them,
    // which carries `undefined`. Folding the two would refuse a legitimate run.
    expect(
      missingRunArgs({ ...base, declaredParamCount: 2, carriedParams: {} })
        .refuse
    ).toBe(false);
  });
});
