import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRIPWIRE — every handle `diagnose` claims to resolve actually resolves to a
 * non-null kind, including the two correlationId-based fallbacks.
 *
 * WHY THIS EXISTS: `resolveObjectKind` is an ORDERED probe (`PROBE_ORDER`)
 * across nine row-id kinds, plus two more fallbacks that key off
 * `proposals.correlationId` and `events.correlationId` when no row id matched.
 * `diagnose.test.ts` locks the PURE math (scorecard, global health) and
 * asserts `PROBE_ORDER`'s shape, but nothing exercised the probe function
 * itself — so a probe with a broken predicate, a wrong table, or a fallback
 * that silently stopped matching would ship green. The bug class this guards:
 * a minted handle (a correlationId handed back from a capability run, or a run
 * that never got a proposal) hits `diagnose` and dead-ends at "no diagnosable
 * object" even though the underlying thing exists and the caller can see it —
 * exactly the failure this session hit with a capability-run correlationId.
 *
 * `db` is mocked with a per-TABLE result queue (same shape as
 * `relations.get-connections.test.ts`): each entry in `PROBE_ORDER`, plus the
 * two correlationId fallbacks, gets its own case with a seeded row so this
 * test proves each branch is REACHABLE and returns the kind it claims to.
 */

const { mockDb } = vi.hoisted(() => {
  // Per-table FIFO result queues — a table may be queried more than once in a
  // single resolveObjectKind() call (e.g. `proposals` is probed by row id
  // FIRST, then again by correlationId in the fallback), so each `.from(table)`
  // consumes the next queued result for that table.
  const queues = new Map<unknown, unknown[][]>();

  function push(table: unknown, rows: unknown[]) {
    if (!queues.has(table)) queues.set(table, []);
    queues.get(table)!.push(rows);
  }

  function reset() {
    queues.clear();
  }

  function chainFor(table: unknown) {
    const chain: {
      where: (...args: unknown[]) => typeof chain;
      orderBy: (...args: unknown[]) => typeof chain;
      limit: (...args: unknown[]) => Promise<unknown[]>;
    } = {
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => {
        const q = queues.get(table);
        const rows = q && q.length ? q.shift()! : [];
        return Promise.resolve(rows);
      }),
    };
    return chain;
  }

  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => chainFor(table)),
  }));

  return { mockDb: { select, __push: push, __reset: reset } };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb };
});

import {
  automationRuns,
  capabilities,
  documents,
  entities,
  events,
  focusSessions,
  playbookRuns,
  proposals,
  skills,
  tools,
  users,
  views,
} from "@synap/database";
import { PROBE_ORDER, resolveObjectKind } from "./resolve-object-kind.js";

const USER_ID = "user-1";
const ID = "00000000-0000-4000-8000-000000000099";

function reset() {
  mockDb.__reset();
  vi.clearAllMocks();
}

describe("resolveObjectKind — every PROBE_ORDER kind actually resolves", () => {
  beforeEach(reset);

  it("proposal: a matching row id resolves to kind 'proposal'", async () => {
    mockDb.__push(proposals, [
      {
        targetType: "entity",
        targetId: "abcdef01-2345-4678-8abc-def012345678",
      },
    ]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "proposal",
      id: ID,
      // `/resolve/:id` printed this exact label before it stopped probing for
      // itself — the label moved with the probe, it was not re-invented.
      displayName: "Proposal (entity:abcdef01…)",
    });
  });

  it("session: a matching row id resolves to kind 'session'", async () => {
    mockDb.__push(proposals, []); // proposal probe misses
    mockDb.__push(focusSessions, [{ goal: "Ship wave 3" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "session",
      id: ID,
      displayName: "Ship wave 3",
    });
  });

  it("capability: a matching `capabilities` row resolves to kind 'capability'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, [{ name: "Send mail" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "capability",
      id: ID,
      // WHICH table matched is load-bearing: `/resolve/:id` routes a
      // capabilities row, a skills row and a tools row to THREE different
      // browser doors. Collapsing them would send two of the three nowhere.
      subKind: "capability",
    });
  });

  it("capability: a bare `skills` row (no capabilities row) still resolves to kind 'capability'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, [{ name: "summarize" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "capability",
      id: ID,
      subKind: "skill",
    });
  });

  it("capability: a bare `tools` row (no capabilities/skills row) still resolves to kind 'capability'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, [{ name: "gmail" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "capability",
      id: ID,
      subKind: "tool",
    });
  });

  it("automation_run: a matching row id resolves to kind 'automation_run'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, [{ one: 1 }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({ kind: "automation_run", id: ID });
  });

  it("playbook_run: a matching row id resolves to kind 'playbook_run'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, [{ one: 1 }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({ kind: "playbook_run", id: ID });
  });

  it("agent: a matching agent-user row resolves to kind 'agent'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, [{ one: 1 }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({ kind: "agent", id: ID });
  });

  it("entity: the broad catch-all resolves to kind 'entity'", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, []);
    mockDb.__push(documents, []);
    mockDb.__push(entities, [{ title: "Acme", type: "company" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "entity",
      id: ID,
      // Display metadata comes off the row the probe ALREADY matched — the
      // consumer must never need a second per-kind lookup to print a title.
      displayName: "Acme",
      profileSlug: "company",
    });
  });

  it("view: a matching row id resolves to kind 'view' (a probe that existed ONLY in the old /resolve list)", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, [{ name: "Pipeline" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "view",
      id: ID,
      displayName: "Pipeline",
    });
  });

  it("document: a matching row id resolves to kind 'document' (also absorbed from the old /resolve list)", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, []);
    mockDb.__push(documents, [{ title: "Q3 memo" }]);
    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toMatchObject({
      kind: "document",
      id: ID,
      displayName: "Q3 memo",
    });
  });

  it("PROBE_ORDER has exactly one test case per declared kind (this file stays honest as kinds are added)", () => {
    // If a new kind is ever added to PROBE_ORDER, this fails loudly instead of
    // silently leaving it unverified — the point of the tripwire.
    expect(PROBE_ORDER).toEqual([
      "proposal",
      "session",
      "capability",
      "automation_run",
      "playbook_run",
      "agent",
      "view",
      "document",
      "entity",
    ]);
  });
});

describe("resolveObjectKind — correlationId fallbacks (a minted handle must always resolve)", () => {
  beforeEach(reset);

  it("a proposals.correlationId (no row-id match anywhere) resolves to the PROPOSAL's row id", async () => {
    // No row-id probe matches...
    mockDb.__push(proposals, []); // row-id probe
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, []);
    mockDb.__push(documents, []);
    mockDb.__push(entities, []);
    // ...but the correlationId fallback finds the proposal, and must return
    // its ROW id (not the correlationId the caller passed in).
    const proposalRowId = "00000000-0000-4000-8000-0000000000aa";
    mockDb.__push(proposals, [{ id: proposalRowId }]); // correlationId probe

    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toEqual({ kind: "proposal", id: proposalRowId });
    // The fallbacks carry NO display metadata — they matched no display row,
    // and fabricating one would be a claim nothing checked.
  });

  it("a capability_run ai_decision event's correlationId resolves to kind 'capability' (a direct/owner-bypass run with NO proposal)", async () => {
    mockDb.__push(proposals, []); // row-id probe
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, []);
    mockDb.__push(documents, []);
    mockDb.__push(entities, []);
    mockDb.__push(proposals, []); // correlationId fallback also misses

    const skillId = "00000000-0000-4000-8000-0000000000bb";
    mockDb.__push(events, [{ data: { kind: "capability_run", skillId } }]);

    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toEqual({ kind: "capability", id: skillId });
  });

  it("truly unknown id (every probe and both fallbacks miss) resolves to null, not a fabricated object", async () => {
    mockDb.__push(proposals, []);
    mockDb.__push(focusSessions, []);
    mockDb.__push(capabilities, []);
    mockDb.__push(skills, []);
    mockDb.__push(tools, []);
    mockDb.__push(automationRuns, []);
    mockDb.__push(playbookRuns, []);
    mockDb.__push(users, []);
    mockDb.__push(views, []);
    mockDb.__push(documents, []);
    mockDb.__push(entities, []);
    mockDb.__push(proposals, []);
    mockDb.__push(events, []);

    const result = await resolveObjectKind(ID, USER_ID);
    expect(result).toBeNull();
  });
});
