/**
 * The rule dry run applies RULE SCOPE (entity + project) through the live
 * matcher's own gate (`matchRuleScopeFilters`, imported from `@synap/jobs`).
 *
 * Before this, a scoped rule's preview counted every matching event in history
 * while the live rule fired only for its entity / project — the preview
 * over-counted exactly the rules users narrowed on purpose.
 *
 * The resolver is INJECTED (the live one reads the pod through jobs' own db
 * handle, which a barrel mock here cannot reach). The discriminating rows are
 * the out-of-scope events: a replay without the gate counts them.
 */

import { describe, it, expect, vi } from "vitest";
import type { AutomationTriggerConfig } from "@synap/database";
import {
  eventMatchesTrigger,
  matchStoredRows,
  scopeReplayCaveats,
  type ProjectIdsResolver,
} from "./dry-run.js";

const ENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJ_P = "11111111-1111-4111-8111-111111111111";
const PROJ_Q = "22222222-2222-4222-8222-222222222222";

const row = (id: string, subjectId: string) => ({
  id,
  type: "entity.update.completed",
  subjectId,
  data: { id: subjectId } as Record<string, unknown>,
});

const ROWS = [row("e1", ENT_A), row("e2", ENT_B), row("e3", ENT_A)];

const membership: Record<string, string> = { [ENT_A]: PROJ_P, [ENT_B]: PROJ_Q };

function resolver(
  impl?: (entityId: string | undefined) => ReadonlySet<string> | null
) {
  return vi.fn<ProjectIdsResolver>(async (input) =>
    impl
      ? impl(input.entityId)
      : new Set(input.entityId ? [membership[input.entityId]] : [])
  );
}

describe("dry run × entity scope", () => {
  const config: AutomationTriggerConfig = {
    eventPattern: "entity.update.*",
    entityId: ENT_A,
  };

  it("counts only events about the scoped entity (discriminating: ENT_B is excluded)", async () => {
    const r = resolver();
    const { matched } = await matchStoredRows(ROWS, config, r);
    expect(matched.map((m) => m.id)).toEqual(["e1", "e3"]);
    // Entity scope needs no membership read.
    expect(r).not.toHaveBeenCalled();
  });

  it("the pure predicate agrees row by row", () => {
    expect(eventMatchesTrigger(ROWS[0], config)).toBe(true);
    expect(eventMatchesTrigger(ROWS[1], config)).toBe(false);
  });
});

describe("dry run × project scope", () => {
  const config: AutomationTriggerConfig = {
    eventPattern: "entity.update.*",
    projectId: PROJ_P,
  };

  it("counts only events on the scoped project, reading membership once per subject", async () => {
    const r = resolver();
    const { matched, unreadableCount } = await matchStoredRows(ROWS, config, r);
    expect(matched.map((m) => m.id)).toEqual(["e1", "e3"]);
    expect(unreadableCount).toBe(0);
    // e1 and e3 share a subject ⇒ 2 reads for 3 rows.
    expect(r).toHaveBeenCalledTimes(2);
  });

  it("a row whose membership cannot be read is NOT counted, and is reported", async () => {
    const r = resolver((entityId) =>
      entityId === ENT_A ? null : new Set([PROJ_P])
    );
    const { matched, unreadableCount } = await matchStoredRows(ROWS, config, r);
    expect(matched.map((m) => m.id)).toEqual(["e2"]);
    expect(unreadableCount).toBe(2);
    expect(scopeReplayCaveats(config, unreadableCount)).toEqual([
      "Project membership is checked as it is today, not as it was when each event happened.",
      "2 events could not be checked against the project and were not counted.",
    ]);
  });

  it("an unscoped rule counts every matching event and reads no membership", async () => {
    const r = resolver();
    const { matched } = await matchStoredRows(
      ROWS,
      { eventPattern: "entity.update.*" },
      r
    );
    expect(matched).toHaveLength(3);
    expect(r).not.toHaveBeenCalled();
    expect(scopeReplayCaveats({ eventPattern: "entity.update.*" }, 0)).toEqual(
      []
    );
  });
});
