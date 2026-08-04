/**
 * Contract test for `buildCapabilityComposition` — the FROZEN Capability
 * Composition read (T6). Pins the derivations a parallel frontend depends on:
 *   · members come from the `member_of` graph, ONE row per link;
 *   · `wired` is per-kind — a skill needs a `requires --> tool` edge (the T4
 *     orphaned-verb signal), a playbook/automation must not be archived;
 *   · `gaps` names each unwired member in human language;
 *   · `health` rolls up runs (failed / stuck / lastRunAt) over the materialized
 *     playbook + automation flows;
 *   · `provenance` reads the container's templateKey/contentHash stamp.
 *
 * getLinksFor / listRuns / db are mocked — assertions are on the composed shape.
 */
import { describe, expect, it, vi } from "vitest";

const { mockGetLinksFor, mockListRuns } = vi.hoisted(() => ({
  mockGetLinksFor: vi.fn(),
  mockListRuns: vi.fn(),
}));

vi.mock("../links/links-service.js", () => ({
  getLinksFor: mockGetLinksFor,
}));
vi.mock("../runs/index.js", () => ({
  listRuns: mockListRuns,
}));

// db.select().from(table).where() → rows registered for that table object. The
// real table objects are preserved (importOriginal) so the builder's imports key
// the same map entries this test fills.
const rowsByTable = new Map<unknown, unknown[]>();
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => {
        let tbl: unknown;
        const chain: Record<string, unknown> = {
          from: (t: unknown) => {
            tbl = t;
            return chain;
          },
          // `where()` is terminal for the builder's reads AND chains into
          // `.orderBy()` for the list door — make it a thenable that also
          // carries orderBy (returning the same thenable), so both await paths
          // resolve to the table's registered rows.
          where: () => {
            const rows = rowsByTable.get(tbl) ?? [];
            const thenable = {
              orderBy: () => Promise.resolve(rows),
              then: (res: (v: unknown) => unknown) =>
                Promise.resolve(rows).then(res),
            };
            return thenable;
          },
        };
        return chain;
      },
    },
  };
});

import {
  buildCapabilityComposition,
  listCapabilityCompositions,
} from "./capability-composition.js";
import {
  capabilities,
  tools,
  skills,
  playbooks,
  automations,
  links,
} from "@synap/database";

const CAP_ID = "cap-1";
const memberLink = (fromType: string, fromId: string) => ({
  fromType,
  fromId,
  toType: "capability",
  toId: CAP_ID,
  linkType: "member_of",
});

describe("buildCapabilityComposition", () => {
  it("derives members, wired flags, gaps, health, and provenance", async () => {
    mockGetLinksFor.mockImplementation(async (_u: string, type: string) => {
      if (type === "capability") {
        return [
          memberLink("tool", "t1"),
          memberLink("skill", "s1"),
          memberLink("skill", "s2"),
          memberLink("playbook", "p1"),
          memberLink("automation", "a1"),
          // Noise that must be IGNORED (wrong linkType / wrong direction).
          {
            fromType: "skill",
            fromId: "s9",
            toType: "capability",
            toId: CAP_ID,
            linkType: "grants",
          },
        ];
      }
      return [];
    });

    rowsByTable.set(tools, [{ id: "t1", name: "Linear" }]);
    rowsByTable.set(skills, [
      { id: "s1", name: "list_issues" },
      { id: "s2", name: "orphan_verb" },
    ]);
    rowsByTable.set(playbooks, [
      { id: "p1", name: "Qualify lead", status: "active" },
    ]);
    rowsByTable.set(automations, [
      { id: "a1", name: "Enrich", status: "archived" },
    ]);
    // wired-skills query (requires --> tool): only s1 has a parent tool.
    rowsByTable.set(links, [{ fromId: "s1" }]);

    const failedAt = new Date("2026-08-01T12:00:00.000Z");
    mockListRuns.mockImplementation(
      async (input: { flowType: string; flowId: string }) => {
        if (input.flowType === "playbook" && input.flowId === "p1") {
          return [
            { status: "failed", startedAt: failedAt, completedAt: failedAt },
            {
              status: "completed",
              startedAt: new Date("2026-07-30T00:00:00.000Z"),
              completedAt: new Date(),
            },
          ];
        }
        return []; // archived automation has no runs
      }
    );

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "CRM",
        approved: true,
        metadata: { templateKey: "crm-core", contentHash: "abc123" },
      },
    });

    // Members: one per member_of link, correct wired flags.
    expect(result.members).toEqual(
      expect.arrayContaining([
        { kind: "tool", id: "t1", name: "Linear", wired: true },
        { kind: "skill", id: "s1", name: "list_issues", wired: true },
        { kind: "skill", id: "s2", name: "orphan_verb", wired: false },
        { kind: "playbook", id: "p1", name: "Qualify lead", wired: true },
        { kind: "automation", id: "a1", name: "Enrich", wired: false },
      ])
    );
    expect(result.members).toHaveLength(5); // the `grants` noise link is dropped

    // Gaps: the orphaned verb and the archived automation, in human language.
    expect(result.gaps).toContain(
      'Verb "orphan_verb" has no parent tool (unwired)'
    );
    expect(result.gaps).toContain('Automation "Enrich" is archived (unwired)');
    expect(result.gaps).toHaveLength(2);

    // Health: the failed playbook run drives status=failed; lastRunAt is newest.
    expect(result.health.failedRuns).toBe(1);
    expect(result.health.stuckRuns).toBe(0);
    expect(result.health.status).toBe("failed");
    expect(result.health.lastRunAt).toBe(failedAt.toISOString());

    // Provenance from the container's metadata stamp.
    expect(result.provenance).toEqual({
      templateKey: "crm-core",
      contentHash: "abc123",
    });
    expect(result.approved).toBe(true);
  });

  it("reports unknown health and null provenance for a bare, flow-less capability", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [{ id: "t1", name: "Linear" }]);
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: { id: CAP_ID, name: "Bare", approved: false, metadata: null },
    });

    expect(result.health).toEqual({
      status: "unknown",
      failedRuns: 0,
      stuckRuns: 0,
    });
    expect(result.provenance).toBeNull();
    expect(result.gaps).toEqual([]);
  });
});

describe("listCapabilityCompositions — the whole-pod map door", () => {
  it("returns one CapabilityComposition per visible container, keyed by container id", async () => {
    // Two containers; each has a single tool member with no runs.
    mockGetLinksFor.mockImplementation(async (_u: string, type: string) =>
      type === "capability" ? [memberLink("tool", "t1")] : []
    );
    mockListRuns.mockResolvedValue([]);
    rowsByTable.clear();
    rowsByTable.set(capabilities, [
      { id: "cap-1", name: "CRM", approved: true, metadata: null },
      { id: "cap-2", name: "Ops", approved: false, metadata: null },
    ]);
    rowsByTable.set(tools, [{ id: "t1", name: "Linear" }]);

    const result = await listCapabilityCompositions({ userId: "user-1" });

    expect(result).toHaveLength(2);
    // `.id` is the CONTAINER id — the 1:1 join key for the atlas node.
    expect(result.map((c) => c.id)).toEqual(["cap-1", "cap-2"]);
    expect(result[0].members).toEqual([
      { kind: "tool", id: "t1", name: "Linear", wired: true },
    ]);
    expect(result[1].approved).toBe(false);
  });

  it("returns an empty array when the caller sees no containers", async () => {
    rowsByTable.clear();
    rowsByTable.set(capabilities, []);
    const result = await listCapabilityCompositions({
      userId: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toEqual([]);
  });
});
