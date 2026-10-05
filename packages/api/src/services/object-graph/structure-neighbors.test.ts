/**
 * The FK-shaped neighbours of the kinds the node page made focusable — track,
 * proposal, run (and the session/project ends of a track) — driven through the
 * REAL `getObjectGraph` envelope, so deleting the fold from the merge goes red
 * here (the seam), not only in a direct call.
 *
 * The DB is faked at `getDb()` and answers per TABLE from a queue, in call
 * order: the fold's own read of a table comes first, its hydration second. A
 * far end the hydration does not return is "invisible to the caller" — it must
 * be DROPPED, never surfaced as a bare id. What a fake cannot prove is the SQL
 * floor itself; `hydration-floor-owner-private.test.ts` pins that by source.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queues: new Map<unknown, Record<string, unknown>[][]>(),
  /** Optional answer by (table, selected columns) — wins over the queue. */
  answer: null as
    | null
    | ((
        table: unknown,
        cols: Record<string, unknown> | undefined
      ) => Record<string, unknown>[] | undefined),
  links: [] as Record<string, unknown>[],
}));

vi.mock("../links/links-service.js", () => ({
  getLinksFor: vi.fn(async () => h.links),
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: vi.fn(async () => ({})),
}));
// Naming a proposal runs it through the session-redaction read; identity here.
vi.mock("../proposals/session-content-redaction.js", () => ({
  redactUnreadableSessionTargets: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      then: (
        resolve: (v: Record<string, unknown>[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const fakeDb = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        chain(h.answer?.(table, cols) ?? h.queues.get(table)?.shift() ?? []),
    }),
  };
  return {
    ...actual,
    getDb: async () => fakeDb,
    loadFacetSlugsBatch: vi.fn(async () => new Map()),
  };
});

import * as schema from "@synap/database";
import { getObjectGraph } from "./graph-service.js";
import { deriveNodeNeighbourhood } from "@synap-core/types/connections";

const USER = "user-owner";
const TRACK = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const PLAYBOOK = "33333333-3333-4333-8333-333333333333";
const S1 = "44444444-4444-4444-8444-444444444444";
const S2 = "55555555-5555-4555-8555-555555555555";
const PROPOSAL = "66666666-6666-4666-8666-666666666666";
const ENTITY = "77777777-7777-4777-8777-777777777777";
const RUN = "88888888-8888-4888-8888-888888888888";
const AUTOMATION = "99999999-9999-4999-8999-999999999999";

function queue(table: unknown, ...reads: Record<string, unknown>[][]) {
  h.queues.set(table, reads);
}

beforeEach(() => {
  h.queues = new Map();
  h.answer = null;
  h.links = [];
});

describe("track focus", () => {
  it("lists its project, its method and its VISIBLE sessions — and is found", async () => {
    queue(
      schema.projectTracks,
      // hydrate the focus itself
      [{ id: TRACK, name: "Creator partnerships", status: "active" }],
      // the fold's own read of the focus row
      [{ projectId: PROJECT, playbookId: PLAYBOOK }]
    );
    // fold: two sessions carry track_id; hydration sees only S1 (S2 is
    // another user's session the session floor refuses).
    queue(
      schema.focusSessions,
      [{ id: S1 }, { id: S2 }],
      [{ id: S1, goal: "Email Théo", workspaceId: null }]
    );
    queue(schema.projects, [{ id: PROJECT, name: "Launch", status: "active" }]);
    queue(schema.playbooks, [{ id: PLAYBOOK, name: "Creator outreach" }]);

    const env = await getObjectGraph(USER, "track", TRACK);
    expect(env.found).toBe(true);
    expect(env.object).toMatchObject({
      kind: "track",
      name: "Creator partnerships",
    });
    const byId = Object.fromEntries(env.neighbors.map((n) => [n.id, n]));
    expect(byId[PROJECT]).toMatchObject({
      kind: "project",
      edgeType: "member_of",
      direction: "outgoing",
      via: "structure",
    });
    expect(byId[PLAYBOOK]).toMatchObject({
      edgeType: "instantiated_from",
      direction: "outgoing",
    });
    expect(byId[S1]).toMatchObject({
      kind: "session",
      name: "Email Théo",
      direction: "incoming",
    });
    // Invisible far end: dropped, never a bare id.
    expect(byId[S2]).toBeUndefined();

    // And the shared model places them in the Navigator's zones.
    const nb = deriveNodeNeighbourhood(
      { kind: "track", id: TRACK },
      env.neighbors
    );
    expect(nb.servesAndBlocks.items.map((i) => i.id)).toEqual([PROJECT]);
    expect(nb.cameFrom.items.map((i) => i.id)).toEqual([PLAYBOOK]);
    expect(nb.workingOnIt.items.map((i) => i.id)).toEqual([S1]);
  });

  it("an invisible track contributes no edges and is not found", async () => {
    // Nothing hydrates and the fold's floored read returns no row.
    const env = await getObjectGraph(USER, "track", TRACK);
    expect(env.found).toBe(false);
    expect(env.neighbors).toEqual([]);
  });
});

describe("proposal focus", () => {
  it("is named by its display sentence and lists what it governed + where it was filed", async () => {
    const row = {
      id: PROPOSAL,
      proposalType: "update",
      targetType: "entity",
      targetId: ENTITY,
      data: {},
      status: "approved",
      workspaceId: null,
      sessionId: S1,
    };
    queue(
      schema.proposals,
      [row], // hydrate the focus
      [row] // the fold's floored read
    );
    queue(
      schema.entities,
      [], // entities materialized by it (none beyond the target)
      [{ id: ENTITY, title: "Théo Renard", type: "person", workspaceId: null }]
    );
    queue(schema.focusSessions, [
      { id: S1, goal: "Email Théo", workspaceId: null },
    ]);

    const env = await getObjectGraph(USER, "proposal", PROPOSAL);
    expect(env.found).toBe(true);
    expect(env.object.kind).toBe("proposal");
    // A sentence, never the bare proposal type column.
    expect(env.object.name).not.toBe("update");
    const nb = deriveNodeNeighbourhood(
      { kind: "proposal", id: PROPOSAL },
      env.neighbors
    );
    expect(nb.became.items.map((i) => i.id)).toEqual([ENTITY]);
    expect(nb.cameFrom.items.map((i) => i.id)).toEqual([S1]);
  });
});

describe("run focus", () => {
  it("is named by its automation, addressed as an automation run, and lists its rule + subject", async () => {
    const runRow = {
      id: RUN,
      automationId: AUTOMATION,
      subjectEntityId: ENTITY,
      status: "completed",
      workspaceId: null,
    };
    queue(schema.automationRuns, [runRow], [runRow]);
    queue(
      schema.automations,
      [{ id: AUTOMATION, name: "Creator captured → outreach" }], // run naming
      [
        {
          id: AUTOMATION,
          name: "Creator captured → outreach",
          triggerType: "event",
        },
      ]
    );
    queue(schema.entities, [
      { id: ENTITY, title: "Théo Renard", type: "person", workspaceId: null },
    ]);

    const env = await getObjectGraph(USER, "run", RUN);
    expect(env.object).toMatchObject({
      kind: "run",
      name: "Creator captured → outreach",
      subtype: "automation",
    });
    const nb = deriveNodeNeighbourhood({ kind: "run", id: RUN }, env.neighbors);
    expect(nb.cameFrom.items.map((i) => i.id)).toEqual([AUTOMATION]);
    expect(nb.related.items.map((i) => i.id)).toEqual([ENTITY]);
  });
});

describe("session focus", () => {
  const SESSION_ROW = {
    id: S1,
    title: "Audit linkage",
    goal: "Audit every place we link things, list the gaps with file:line evidence and propose waves.\nSecond line.",
    status: "active",
    workspaceId: null,
  };
  /** Fold read (it selects `playbookId`) vs hydration (select *). */
  function sessionDb(fold: Record<string, unknown>) {
    h.answer = (table, cols) => {
      if (table === schema.focusSessions) {
        return cols && "playbookId" in cols ? [fold] : [SESSION_ROW];
      }
      if (table === schema.projects)
        return [{ id: PROJECT, name: "Synap", status: "active" }];
      if (table === schema.playbooks)
        return [{ id: PLAYBOOK, name: "Dev session" }];
      if (table === schema.projectTracks)
        return [{ id: TRACK, name: "Linkage", status: "active" }];
      return undefined;
    };
  }

  it("lists its project and its playbook (the context it works inside), named by title", async () => {
    sessionDb({ trackId: TRACK, projectId: PROJECT, playbookId: PLAYBOOK });
    const env = await getObjectGraph(USER, "session", S1);
    // Named by its short title, never the goal paragraph.
    expect(env.object.name).toBe("Audit linkage");
    const byId = Object.fromEntries(env.neighbors.map((n) => [n.id, n]));
    expect(byId[PROJECT]).toMatchObject({
      kind: "project",
      edgeType: "member_of",
      direction: "outgoing",
      via: "structure",
    });
    expect(byId[PLAYBOOK]).toMatchObject({
      kind: "playbook",
      edgeType: "instantiated_from",
      direction: "outgoing",
      via: "structure",
    });
    const nb = deriveNodeNeighbourhood(
      { kind: "session", id: S1 },
      env.neighbors
    );
    expect(nb.servesAndBlocks.items.map((i) => i.id).sort()).toEqual(
      [PROJECT, TRACK].sort()
    );
    expect(nb.cameFrom.items.map((i) => i.id)).toEqual([PLAYBOOK]);
  });

  it("an untitled session is named by the goal's first line", async () => {
    sessionDb({ trackId: null, projectId: null, playbookId: null });
    h.answer = ((inner) => (table, cols) =>
      table === schema.focusSessions && !(cols && "playbookId" in cols)
        ? [{ ...SESSION_ROW, title: null }]
        : inner!(table, cols))(h.answer);
    const env = await getObjectGraph(USER, "session", S1);
    // The goal's FIRST line, clipped by the one title door — never the paragraph.
    expect(env.object.name).toMatch(/^Audit every place we link things/);
    expect(env.object.name).not.toContain("Second line");
    expect(env.object.name.length).toBeLessThan(SESSION_ROW.goal.length);
  });

  it("does not repeat a playbook / project a stored link already names", async () => {
    sessionDb({ trackId: null, projectId: PROJECT, playbookId: PLAYBOOK });
    h.links = [
      {
        fromType: "session",
        fromId: S1,
        toType: "playbook",
        toId: PLAYBOOK,
        linkType: "instantiated_from",
      },
      {
        fromType: "session",
        fromId: S1,
        toType: "project",
        toId: PROJECT,
        linkType: "targets",
      },
    ];
    const env = await getObjectGraph(USER, "session", S1);
    const rows = env.neighbors.map((n) => `${n.kind}:${n.edgeType}:${n.via}`);
    expect(rows.sort()).toEqual(
      ["playbook:instantiated_from:links", "project:targets:links"].sort()
    );
  });

  it("an unreadable session contributes no context edges", async () => {
    // The floored fold read returns nothing; nothing hydrates.
    h.answer = (table) => (table === schema.focusSessions ? [] : undefined);
    const env = await getObjectGraph(USER, "session", S1);
    expect(env.found).toBe(false);
    expect(env.neighbors).toEqual([]);
  });
});
