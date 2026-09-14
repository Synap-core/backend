/**
 * Rule ENTITY + PROJECT scope, enforced at the firing side (founder decisions
 * R1/R2, 2026-09-14).
 *
 * Before this, `triggerConfig.entityId` / `.projectId` were read by nothing: a
 * rule authored "on" an entity or a project fired for every matching event.
 *
 * Behavioural, not shape-only: the db is mocked and the assertions are on which
 * automations actually opened a run. The DISCRIMINATING rows are the ones where
 * a wrong rule and a right rule disagree:
 *   - an entity-scoped rule vs an event about ANOTHER entity;
 *   - a project-scoped rule vs an event whose subject is NOT in the project;
 *   - a FAILED membership read (a wrong rule reads it as "no projects" and could
 *     still fire an unscoped neighbour — or, worse, treat failure as a match);
 *   - an unscoped rule in the same batch, which must still fire.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();

let selectResults: Array<Array<Record<string, unknown>>> = [];
let selectCall = 0;

/** Membership rows per entity id; `relationsThrows` simulates a failed read. */
let membership: Record<string, string[]> = {};
let relationsThrows = false;
let channelProject: Record<string, string | null> = {};
let sessionProject: Record<string, string | null> = {};
const relationsFindMany = vi.fn();

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.set = chain;
  p.where = () => p;
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.onConflictDoNothing = () => p;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

/** A drizzle `where` callback evaluated against a fake column bag. */
type WhereFn = (
  fields: Record<string, string>,
  ops: {
    and: (...a: unknown[]) => unknown[];
    eq: (col: string, val: unknown) => [string, unknown];
  }
) => unknown;

function readEqs(where: WhereFn): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = new Proxy({}, { get: (_t, k) => String(k) }) as Record<
    string,
    string
  >;
  const tree = where(fields, {
    and: (...a) => a,
    eq: (col, val) => [col, val],
  });
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "string" && node.length === 2) {
      out[node[0]] = node[1];
      return;
    }
    node.forEach(walk);
  };
  walk(tree);
  return out;
}

vi.mock("@synap/events", () => ({ getBoss: () => ({ send: bossSend }) }));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@synap/database", () => ({
  db: {
    query: {
      focusSessions: {
        findFirst: (args: {
          where: WhereFn;
          columns: Record<string, true>;
        }) => {
          if (!args.columns.projectId) return Promise.resolve(null);
          const { id } = readEqs(args.where);
          return Promise.resolve(
            typeof id === "string" && id in sessionProject
              ? { projectId: sessionProject[id] }
              : null
          );
        },
      },
      links: { findMany: () => Promise.resolve([]) },
      relations: {
        findMany: (args: { where: WhereFn }) => {
          relationsFindMany(args);
          if (relationsThrows)
            return Promise.reject(new Error("connection reset"));
          const eqs = readEqs(args.where);
          const targets = membership[eqs.sourceEntityId as string] ?? [];
          // The predicate must name the membership edge, not any relation.
          if (eqs.type !== "belongs_to_project") return Promise.resolve([]);
          return Promise.resolve(targets.map((t) => ({ targetEntityId: t })));
        },
      },
      channels: {
        findFirst: (args: { where: WhereFn }) => {
          const { id } = readEqs(args.where);
          return Promise.resolve(
            typeof id === "string" && id in channelProject
              ? { projectId: channelProject[id] }
              : undefined
          );
        },
      },
      proposals: { findFirst: () => Promise.resolve(undefined) },
    },
    select: () => {
      const result = selectResults[selectCall] ?? [];
      selectCall += 1;
      return makeThenable(result);
    },
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
  },
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    workspaceId: "workspace_id",
    createdBy: "created_by",
    runCount: 0,
  },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  skills: {},
  workspaceMembers: { workspaceId: "ws_member_workspace_id", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
  BELONGS_TO_PROJECT: "belongs_to_project",
}));

const { handleAutomationTriggerMatch, matchRuleScopeFilters } =
  await import("./automation-trigger-matcher.js");

const ENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJ_P = "11111111-1111-4111-8111-111111111111";
const PROJ_Q = "22222222-2222-4222-8222-222222222222";
const CHAN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function event(over: Record<string, unknown> = {}) {
  return {
    eventType: "entity.update.completed",
    subjectId: ENT_A,
    userId: "user-1",
    workspaceId: "ws-1",
    data: { id: ENT_A },
    ...over,
  } as Parameters<typeof handleAutomationTriggerMatch>[0]["data"];
}

function auto(id: string, triggerConfig: Record<string, unknown>) {
  return { id, workspaceId: "ws-1", triggerConfig, metadata: {} };
}

function fired(): string[] {
  return insertValues.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((v) => typeof v?.automationId === "string")
    .map((v) => v.automationId as string);
}

beforeEach(() => {
  bossSend.mockClear();
  insertValues.mockClear();
  relationsFindMany.mockClear();
  selectCall = 0;
  selectResults = [];
  membership = {};
  relationsThrows = false;
  channelProject = {};
  sessionProject = {};
});

describe("entity scope (R1)", () => {
  it("fires an entity-scoped rule for an event about THAT entity", async () => {
    selectResults = [
      [auto("scoped", { eventPattern: "entity.update.*", entityId: ENT_A })],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["scoped"]);
  });

  it("does NOT fire it for an event about ANOTHER entity (discriminating)", async () => {
    selectResults = [
      [auto("scoped", { eventPattern: "entity.update.*", entityId: ENT_B })],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual([]);
  });

  it("an unscoped rule in the same batch still fires", async () => {
    selectResults = [
      [
        auto("scoped-other", {
          eventPattern: "entity.update.*",
          entityId: ENT_B,
        }),
        auto("wide", { eventPattern: "entity.update.*" }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["wide"]);
  });

  it("a delete is still about its entity (the run-subject door drops deletes for routing, not for scope)", async () => {
    selectResults = [
      [auto("on-delete", { eventPattern: "entity.delete.*", entityId: ENT_A })],
    ];
    await handleAutomationTriggerMatch({
      data: event({ eventType: "entity.delete.completed" }),
    });
    expect(fired()).toEqual(["on-delete"]);
  });

  it("reads the parent entity of a facet event from data.entityId", async () => {
    selectResults = [
      [auto("facet", { eventPattern: "entity_facet.*", entityId: ENT_A })],
    ];
    await handleAutomationTriggerMatch({
      data: event({
        eventType: "entity_facet.attach.completed",
        subjectId: "facet-row",
        data: { entityId: ENT_A, facetId: "f" },
      }),
    });
    expect(fired()).toEqual(["facet"]);
  });

  it("an entity scope on a family that carries no entity never fires (fail closed)", async () => {
    selectResults = [
      [auto("proposal", { eventPattern: "proposal.*", entityId: ENT_A })],
    ];
    await handleAutomationTriggerMatch({
      data: event({
        eventType: "proposal.approved.completed",
        subjectId: "p-1",
        // A payload that HAPPENS to carry the id must not open the family.
        data: { proposalStatus: "approved", entityId: ENT_A },
      }),
    });
    expect(fired()).toEqual([]);
  });
});

describe("project scope (R2)", () => {
  it("fires a project-scoped rule for an entity that belongs to the project", async () => {
    membership = { [ENT_A]: [PROJ_P] };
    selectResults = [
      [auto("proj", { eventPattern: "entity.update.*", projectId: PROJ_P })],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["proj"]);
  });

  it("does NOT fire for an entity that is only in ANOTHER project (discriminating)", async () => {
    membership = { [ENT_A]: [PROJ_Q] };
    selectResults = [
      [auto("proj", { eventPattern: "entity.update.*", projectId: PROJ_P })],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual([]);
  });

  it("a FAILED membership read does not fire the scoped rule, and the unscoped one still fires", async () => {
    membership = { [ENT_A]: [PROJ_P] };
    relationsThrows = true;
    selectResults = [
      [
        auto("proj", { eventPattern: "entity.update.*", projectId: PROJ_P }),
        auto("wide", { eventPattern: "entity.update.*" }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["wide"]);
  });

  it("resolves membership ONCE per event, not once per scoped rule", async () => {
    membership = { [ENT_A]: [PROJ_P, PROJ_Q] };
    selectResults = [
      [
        auto("p1", { eventPattern: "entity.update.*", projectId: PROJ_P }),
        auto("p2", { eventPattern: "entity.update.*", projectId: PROJ_Q }),
        auto("p3", {
          eventPattern: "entity.update.*",
          projectId: "33333333-3333-4333-8333-333333333333",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["p1", "p2"]);
    expect(relationsFindMany).toHaveBeenCalledTimes(1);
  });

  it("issues no membership read when no candidate is project-scoped", async () => {
    selectResults = [[auto("wide", { eventPattern: "entity.update.*" })]];
    await handleAutomationTriggerMatch({ data: event() });
    expect(fired()).toEqual(["wide"]);
    expect(relationsFindMany).not.toHaveBeenCalled();
  });

  it("a channel message is on the project its channel belongs to", async () => {
    channelProject = { [CHAN]: PROJ_P };
    selectResults = [
      [
        auto("in", {
          eventPattern: "channel_message.created.completed",
          projectId: PROJ_P,
        }),
        auto("out", {
          eventPattern: "channel_message.created.completed",
          projectId: PROJ_Q,
        }),
      ],
    ];
    await handleAutomationTriggerMatch({
      data: event({
        eventType: "channel_message.created.completed",
        subjectId: "msg-1",
        data: { channelId: CHAN, messageRole: "user" },
      }),
    });
    expect(fired()).toEqual(["in"]);
  });

  it("a session event is on the session's project", async () => {
    sessionProject = { [SESSION]: PROJ_P };
    selectResults = [
      [
        auto("in", {
          eventPattern: "focus_session.stage_changed.*",
          projectId: PROJ_P,
        }),
        auto("out", {
          eventPattern: "focus_session.stage_changed.*",
          projectId: PROJ_Q,
        }),
      ],
    ];
    await handleAutomationTriggerMatch({
      data: event({
        eventType: "focus_session.stage_changed.completed",
        subjectId: SESSION,
        data: { sessionId: SESSION, toStage: "review" },
      }),
    });
    expect(fired()).toEqual(["in"]);
  });
});

describe("matchRuleScopeFilters (pure)", () => {
  const facts = { entityId: ENT_A, projectIds: new Set([PROJ_P]) };

  it("absent scope keys match everything", () => {
    expect(matchRuleScopeFilters("anything.at.all", {}, facts)).toBe(true);
  });

  it("an unreadable project set (null) never matches a project scope", () => {
    expect(
      matchRuleScopeFilters(
        "entity.update.completed",
        { projectId: PROJ_P },
        { entityId: ENT_A, projectIds: null }
      )
    ).toBe(false);
  });

  it("entity and project scopes are ANDed", () => {
    expect(
      matchRuleScopeFilters(
        "entity.update.completed",
        { entityId: ENT_A, projectId: PROJ_Q },
        facts
      )
    ).toBe(false);
  });
});
