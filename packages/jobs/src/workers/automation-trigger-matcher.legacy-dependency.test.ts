/**
 * LEGACY DEPENDENCY RULES — a stored `relation.*` rule filtered on
 * `relationType: blocks | depends_on` keeps firing after those relations moved
 * onto the ONE dependency edge, links `blocked_by` (backend 4eacdeaf).
 *
 * Driven through the real `handleAutomationTriggerMatch` loop with the db
 * mocked (harness copied from the rule-scope suite), asserting on the run row
 * that was opened AND its `triggerPayload` — reachability of the relation-shaped
 * payload the rule's THEN-steps template against, not just "it matched".
 *
 * Discriminating rows (where a wrong rule and a right rule disagree):
 *   - DIRECTION: `X blocked_by Y` is `Y blocks X` but `X depends_on Y` — a
 *     swapped mapping fires with the endpoints reversed;
 *   - a session↔session `blocked_by` (no relation reading) must NOT fire;
 *   - an UNFILTERED `relation.create` rule must NOT be widened onto links;
 *   - a `relationType: mentions` rule must NOT fire;
 *   - a `replaces` link must NOT fire.
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

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

const X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function linkEvent(over: Record<string, unknown> = {}, action = "create") {
  return {
    eventType: `link.${action}.completed`,
    subjectId: "link-row-1",
    userId: "user-1",
    workspaceId: "ws-1",
    data: {
      linkType: "blocked_by",
      fromType: "entity",
      fromId: X,
      toType: "entity",
      toId: Y,
      ...over,
    },
  } as Parameters<typeof handleAutomationTriggerMatch>[0]["data"];
}

function auto(id: string, triggerConfig: Record<string, unknown>) {
  return { id, workspaceId: "ws-1", triggerConfig, metadata: {} };
}

function runs(): Array<Record<string, unknown>> {
  return insertValues.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((v) => typeof v?.automationId === "string");
}

function fired(): string[] {
  return runs().map((v) => v.automationId as string);
}

function payloadOf(id: string): Record<string, unknown> {
  const run = runs().find((r) => r.automationId === id);
  return (run?.triggerPayload ?? {}) as Record<string, unknown>;
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

describe("legacy relation rules on the dependency edge", () => {
  it("fires a `relation.create` + relationType=blocks rule as `Y blocks X`", async () => {
    selectResults = [
      [
        auto("on-blocks", {
          eventPattern: "relation.create.completed",
          relationType: "blocks",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent() });
    expect(fired()).toEqual(["on-blocks"]);
    const p = payloadOf("on-blocks");
    expect(p.eventType).toBe("relation.create.completed");
    expect(p.data).toMatchObject({
      relationType: "blocks",
      fromEntityId: Y,
      toEntityId: X,
      linkType: "blocked_by",
    });
  });

  it("fires a filters.relationType=depends_on rule as `X depends_on Y`", async () => {
    selectResults = [
      [
        auto("on-depends", {
          eventPattern: "relation.*",
          filters: { relationType: "depends_on" },
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent() });
    expect(fired()).toEqual(["on-depends"]);
    expect(payloadOf("on-depends").data).toMatchObject({
      relationType: "depends_on",
      fromEntityId: X,
      toEntityId: Y,
    });
  });

  it("a `$in` over both slugs fires ONCE", async () => {
    selectResults = [
      [
        auto("either", {
          eventPattern: "relation.create.completed",
          filters: { relationType: { $in: ["blocks", "depends_on"] } },
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent() });
    expect(fired()).toEqual(["either"]);
  });

  it("a link delete reaches a `relation.delete` rule, not a create rule", async () => {
    selectResults = [
      [
        auto("on-create", {
          eventPattern: "relation.create.completed",
          relationType: "blocks",
        }),
        auto("on-delete", {
          eventPattern: "relation.delete.completed",
          relationType: "blocks",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent({}, "delete") });
    expect(fired()).toEqual(["on-delete"]);
  });

  it("does NOT fire for a session↔session dependency (no relation reading)", async () => {
    selectResults = [
      [
        auto("on-blocks", {
          eventPattern: "relation.create.completed",
          relationType: "blocks",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({
      data: linkEvent({ fromType: "session", toType: "session" }),
    });
    expect(fired()).toEqual([]);
  });

  it("does NOT widen an unfiltered or non-dependency relation rule, nor fire on `replaces`", async () => {
    selectResults = [
      [
        auto("any-relation", { eventPattern: "relation.create.completed" }),
        auto("on-mentions", {
          eventPattern: "relation.create.completed",
          relationType: "mentions",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent() });
    expect(fired()).toEqual([]);

    selectCall = 0;
    selectResults = [
      [
        auto("on-blocks", {
          eventPattern: "relation.create.completed",
          relationType: "blocks",
        }),
      ],
    ];
    await handleAutomationTriggerMatch({
      data: linkEvent({ linkType: "replaces" }),
    });
    expect(fired()).toEqual([]);
  });

  it("a NEW `link.create.completed` + linkType rule fires on the real payload", async () => {
    selectResults = [
      [
        auto("on-link", {
          eventPattern: "link.create.completed",
          filters: { linkType: "blocked_by" },
        }),
      ],
    ];
    await handleAutomationTriggerMatch({ data: linkEvent() });
    expect(fired()).toEqual(["on-link"]);
    const p = payloadOf("on-link");
    expect(p.eventType).toBe("link.create.completed");
    expect(p.data).not.toHaveProperty("relationType");
  });
});
