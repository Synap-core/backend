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

const { mockGetLinksFor, mockListRuns, mockGetCapabilityMemberParts } =
  vi.hoisted(() => ({
    mockGetLinksFor: vi.fn(),
    mockListRuns: vi.fn(),
    // Derives from whatever `mockGetLinksFor` is configured to return for
    // this test — mirrors the real `getCapabilityMemberParts`'s
    // tool|skill|command member-part scope (distinct from the builder's own
    // tool/skill/playbook/automation `idsByKind`) without every test having
    // to register a second, separately-shaped fixture.
    mockGetCapabilityMemberParts: vi.fn(async (capabilityIds: string[]) => {
      const capId = capabilityIds[0];
      const rows = await mockGetLinksFor("unused", "capability", capId);
      return (rows ?? [])
        .filter(
          (l: {
            linkType: string;
            toType: string;
            toId: string;
            fromType: string;
          }) =>
            l.linkType === "member_of" &&
            l.toType === "capability" &&
            l.toId === capId &&
            (l.fromType === "tool" ||
              l.fromType === "skill" ||
              l.fromType === "command")
        )
        .map((l: { fromType: string; fromId: string; toId: string }) => ({
          kind: l.fromType,
          id: l.fromId,
          capabilityId: l.toId,
        }));
    }),
  }));

vi.mock("../links/links-service.js", () => ({
  getLinksFor: mockGetLinksFor,
  getCapabilityMemberParts: mockGetCapabilityMemberParts,
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
  channels,
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
          memberLink("skill", "s3"),
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
      { id: "s1", name: "list_issues", kind: "declarative" },
      { id: "s2", name: "orphan_verb", kind: "declarative" },
      // A builtin `code` verb: self-standing, needs NO parent tool → wired, no gap.
      { id: "s3", name: "entity.create", kind: "code" },
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
        // Builtin code verb: wired despite no parent tool (self-standing).
        { kind: "skill", id: "s3", name: "entity.create", wired: true },
        { kind: "playbook", id: "p1", name: "Qualify lead", wired: true },
        { kind: "automation", id: "a1", name: "Enrich", wired: false },
      ])
    );
    expect(result.members).toHaveLength(6); // the `grants` noise link is dropped

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

describe("buildCapabilityComposition — isBridge + mode classification", () => {
  it("a capability whose tool member PRODUCED a channel ⇒ isBridge:true, mode:standing (derived_produced)", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    // Callable-looking tool kind (`'api'`) — the produced edge alone must still
    // flip isBridge/mode, independent of the tool's own kind.
    rowsByTable.set(tools, [
      { id: "t1", name: "Discord Bot", config: {}, kind: "api" },
    ]);
    // No skill members ⇒ the wired-skills query never runs, so this `links`
    // fixture feeds ONLY the produced-channel-count query.
    rowsByTable.set(links, [{ channelId: "ch1" }]);
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Discord",
        approved: true,
        metadata: null,
      },
    });

    expect(result.isBridge).toBe(true);
    expect(result.mode).toBe("standing");
    expect(result.modeSource).toBe("derived_produced");
  });

  it("a capability with 0 produced edges but ≥1 externalSource-slug channel ⇒ isBridge:true, mode:standing (derived_produced) — the Discord-legacy case", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    // Member tool's name IS the provider slug (`tools.name` == provider slug),
    // the fallback-match key `resolveCapabilityChannelIds` also relies on.
    rowsByTable.set(tools, [
      { id: "t1", name: "discord", config: {}, kind: "api" },
    ]);
    rowsByTable.set(links, []); // NO produced edges — the legacy-slug gap
    // 9 legacy channels born with a bare `source: "discord"` origin, pre-0234,
    // never re-stamped with a `produced` edge.
    rowsByTable.set(
      channels,
      Array.from({ length: 9 }, (_, i) => ({ id: `ch${i}` }))
    );
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Discord Channel Ingest",
        approved: true,
        metadata: null,
      },
    });

    expect(result.isBridge).toBe(true);
    expect(result.mode).toBe("standing");
    expect(result.modeSource).toBe("derived_produced");
  });

  it("a verb-only api-tool capability with no connection ⇒ isBridge:false, mode:unknown", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [
      { id: "t1", name: "fal.ai", config: {}, kind: "api" },
    ]);
    rowsByTable.set(links, []); // no produced edges
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "fal.ai",
        approved: true,
        metadata: null,
      },
    });

    expect(result.isBridge).toBe(false);
    expect(result.mode).toBe("unknown");
    expect(result.modeSource).toBe("unknown");
  });

  it("a command-borne produced edge ⇒ isBridge:true (part-scope parity with resolveCapabilityChannelIds's tool|skill|command)", async () => {
    // A `command` member, NOT a `tool` — the builder's own `idsByKind` never
    // tracks `command` (MEMBER_KINDS = tool/skill/playbook/automation), so
    // this only counts if `countBridgeChannels` resolves its produced-edge
    // scope via `getCapabilityMemberParts` (tool|skill|command) rather than
    // the builder's own `idsByKind`.
    mockGetLinksFor.mockResolvedValue([memberLink("command", "cmd1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, []); // no tool members at all
    rowsByTable.set(links, [{ channelId: "ch1" }]); // cmd1 --produced--> ch1
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Command-borne bridge",
        approved: true,
        metadata: null,
      },
    });

    expect(result.isBridge).toBe(true);
    expect(result.mode).toBe("standing");
    expect(result.modeSource).toBe("derived_produced");
  });

  it("a connected-provider tool member ⇒ isBridge:true even with mode:unknown (no liveness signal)", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [
      { id: "t1", name: "Google Workspace", config: {}, kind: "provider" },
    ]);
    rowsByTable.set(links, []); // no produced channels
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Google Workspace",
        approved: true,
        metadata: null,
      },
    });

    // isBridge (product classification) is true — a connected provider IS a
    // real external connection — but mode (health semantics) stays unknown,
    // since there's no declared/transport/produced liveness signal.
    expect(result.isBridge).toBe(true);
    expect(result.mode).toBe("unknown");
  });
});

describe("buildCapabilityComposition — description + extractionPolicy", () => {
  it("passes description through verbatim and returns null when absent", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [
      { id: "t1", name: "Linear", config: {}, kind: "api" },
    ]);
    rowsByTable.set(links, []);
    mockListRuns.mockResolvedValue([]);

    const withDescription = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "CRM",
        description: "Runs the CRM pipeline.",
        approved: true,
        metadata: null,
      },
    });
    expect(withDescription.description).toBe("Runs the CRM pipeline.");

    const withoutDescription = await buildCapabilityComposition({
      userId: "user-1",
      capability: { id: CAP_ID, name: "CRM", approved: true, metadata: null },
    });
    expect(withoutDescription.description).toBeNull();
  });

  it("normalizes present discord extraction-policy keys off tool metadata", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [
      {
        id: "t1",
        name: "discord",
        config: {},
        kind: "external",
        metadata: {
          discord: {
            reactCapture: true,
            captureFlows: [{ channelId: "c1" }, { channelId: "c2" }],
            captureChannel: "chan-123",
            eventSync: { enabled: true },
          },
        },
      },
    ]);
    rowsByTable.set(links, []);
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Discord Bot",
        approved: true,
        metadata: null,
      },
    });

    expect(result.extractionPolicy).toEqual({
      reactCapture: true,
      captureFlows: 2,
      captureChannel: "chan-123",
      eventSync: true,
    });
  });

  it("returns null when no member tool metadata carries recognized keys", async () => {
    mockGetLinksFor.mockResolvedValue([memberLink("tool", "t1")]);
    rowsByTable.clear();
    rowsByTable.set(tools, [
      { id: "t1", name: "Linear", config: {}, kind: "api", metadata: null },
    ]);
    rowsByTable.set(links, []);
    mockListRuns.mockResolvedValue([]);

    const result = await buildCapabilityComposition({
      userId: "user-1",
      capability: {
        id: CAP_ID,
        name: "Linear",
        approved: true,
        metadata: null,
      },
    });

    expect(result.extractionPolicy).toBeNull();
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
