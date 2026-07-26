/**
 * Pod-wide (NULL-workspace) event automations must be selectable.
 *
 * The defect this locks: the workspace predicate was
 *   `workspaceId != null ? eq(automations.workspaceId, workspaceId)
 *                        : inArray(automations.workspaceId, <floor>)`
 * NEITHER branch can match a NULL column (SQL `= NULL` and `IN (...)` are both
 * never-true for NULL), so an automation with `workspace_id IS NULL` could never
 * fire for ANY event — pod-wide event automations were structurally dead.
 *
 * The db is mocked, so the predicate is not executed by Postgres; instead the
 * drizzle operators are stubbed into inspectable markers and the WHERE tree
 * handed to the automations select is asserted to UNION the NULL-workspace
 * branch with the workspace-equality / accessible-floor branch under a single
 * `or` (presence alone would also accept the zero-row `and(eq, isNull)`).
 * Plus the behavioural half: a pod-wide automation that IS returned fires, its
 * run is stamped with the EVENT's workspace (not NULL) — the
 * no-cross-workspace-widening property — and a pod-wide automation matched by a
 * pod-wide event, where no workspace exists on either side, is skipped rather
 * than dispatched with a NULL workspace.
 *
 * What is NOT proven here: Postgres' actual evaluation of the predicate. The
 * shape is locked; the runtime behaviour needs a live PG run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();
// WHERE trees passed to each db.select(...).where(...) call, in order.
const whereArgs: unknown[] = [];

let selectResults: Array<
  Array<{
    id: string;
    triggerConfig: Record<string, unknown>;
    workspaceId: string | null;
  }>
> = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.set = chain;
  p.where = (arg: unknown) => {
    whereArgs.push(arg);
    return p;
  };
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const selectSpy = vi.fn((..._args: unknown[]) => {
  const result = selectResults[selectCall] ?? [];
  selectCall += 1;
  return makeThenable(result);
});

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: bossSend }),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Operators return inspectable markers so the predicate SHAPE is assertable.
vi.mock("@synap/database", () => ({
  db: {
    query: {
      focusSessions: { findFirst: () => Promise.resolve(null) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: (...args: unknown[]) => selectSpy(...args),
    insert: () => makeThenable([{ id: "run-pod-wide" }]),
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
  playbookAutomations: {},
  workspaceMembers: { workspaceId: "ws_member_workspace_id", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

type Marker = { op?: string; col?: unknown; args?: unknown[] };

/** True when `node` is an `isNull(col)` marker, or an `and(...)` containing one. */
function isPodWideBranch(node: unknown, col: string): boolean {
  const n = node as Marker;
  if (n?.op === "isNull" && n.col === col) return true;
  // The pod-wide branch is OWNER-BOUND: `and(isNull(workspace_id), eq(created_by, userId))`.
  if (n?.op === "and") {
    return ((n.args ?? []) as Marker[]).some(
      (a) => a?.op === "isNull" && a.col === col
    );
  }
  return false;
}

/**
 * Depth-first search for an `or(...)` node that UNIONS the workspace-equality
 * branch with the NULL-workspace branch — i.e. a pod-wide branch and a sibling
 * `eq`/`inArray` on the same column under the SAME `or`.
 *
 * Presence alone is not enough: `and(eq(ws, X), isNull(ws))` also "contains" an
 * isNull but is a zero-row predicate, so it must not pass — hence the sibling
 * requirement under a shared `or`.
 */
function hasWorkspaceUnion(node: unknown, col: string): boolean {
  if (node == null || typeof node !== "object") return false;
  const n = node as Marker;
  if (n.op === "or") {
    const args = (n.args ?? []) as Marker[];
    const hasNullBranch = args.some((a) => isPodWideBranch(a, col));
    const hasScopedBranch = args.some(
      (a) => (a?.op === "eq" || a?.op === "inArray") && a.col === col
    );
    if (hasNullBranch && hasScopedBranch) return true;
  }
  return (n.args ?? []).some((child) => hasWorkspaceUnion(child, col));
}

/**
 * The pod-wide branch must be OWNER-BOUND. A bare `isNull(workspace_id)` is
 * bounded by nothing, so on a multi-member pod one user's pod-wide automation
 * would fire on another user's events. Locks the `createdBy` pairing.
 */
function podWideBranchIsOwnerBound(node: unknown, col: string): boolean {
  if (node == null || typeof node !== "object") return false;
  const n = node as Marker;
  if (n.op === "and") {
    const args = (n.args ?? []) as Marker[];
    if (
      args.some((a) => a?.op === "isNull" && a.col === col) &&
      args.some((a) => a?.op === "eq" && a.col === "created_by")
    ) {
      return true;
    }
  }
  return (n.args ?? []).some((child) => podWideBranchIsOwnerBound(child, col));
}

const ENTITY_EVENT = {
  eventType: "entity.create.completed",
  subjectId: "entity-1",
  userId: "user-1",
  data: { profileSlug: "person" },
} as const;

describe("pod-wide automation selection", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    insertValues.mockClear();
    whereArgs.length = 0;
    selectCall = 0;
    selectResults = [];
  });

  it("includes the NULL-workspace branch for a workspace-scoped event", async () => {
    selectResults = [[]]; // no automations — we only inspect the predicate

    await handleAutomationTriggerMatch({
      data: { ...ENTITY_EVENT, workspaceId: "ws-1" },
    });

    expect(whereArgs).toHaveLength(1);
    // OR-union with the workspace equality — not merely "an isNull somewhere".
    expect(hasWorkspaceUnion(whereArgs[0], "workspace_id")).toBe(true);
  });

  it("owner-bounds the pod-wide branch (createdBy paired with the NULL check)", async () => {
    selectResults = [[]];

    await handleAutomationTriggerMatch({
      data: { ...ENTITY_EVENT, workspaceId: "ws-1" },
    });

    // A bare `isNull(workspace_id)` is bounded by nothing: on a multi-member pod
    // one user's pod-wide automation would fire on another user's events. The
    // NULL check must be AND-ed with `createdBy = userId`.
    expect(podWideBranchIsOwnerBound(whereArgs[0], "workspace_id")).toBe(true);
  });

  it("includes the NULL-workspace branch for a pod-wide (null-workspace) event", async () => {
    // [0] workspace-member floor, [1] pod-visible workspaces, [2] automations
    selectResults = [[], [], []];

    await handleAutomationTriggerMatch({
      data: { ...ENTITY_EVENT, workspaceId: null },
    });

    const automationsWhere = whereArgs[whereArgs.length - 1];
    // OR-union with the accessible-floor `inArray` — an empty floor must not
    // be able to swallow the pod-wide branch.
    expect(hasWorkspaceUnion(automationsWhere, "workspace_id")).toBe(true);
  });

  it("fires a matching pod-wide automation and runs it in the EVENT's workspace", async () => {
    selectResults = [
      [
        {
          id: "auto-pod-wide",
          triggerConfig: { eventPattern: "entity.create.*" },
          workspaceId: null, // pod-wide
        },
      ],
    ];

    await handleAutomationTriggerMatch({
      data: { ...ENTITY_EVENT, workspaceId: "ws-1" },
    });

    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload] = bossSend.mock.calls[0] as [
      string,
      { automationId: string; workspaceId: string | null },
    ];
    expect(queue).toBe("automation-execute");
    expect(payload.automationId).toBe("auto-pod-wide");
    // The run executes in the event's workspace — the pod-wide automation gains
    // no access beyond the workspace the event happened in.
    expect(payload.workspaceId).toBe("ws-1");

    const runValues = insertValues.mock.calls[0][0] as {
      workspaceId: string | null;
    };
    expect(runValues.workspaceId).toBe("ws-1");
  });

  it("does not dispatch when a pod-wide event matches a pod-wide automation (no workspace to run in)", async () => {
    // BOTH sides NULL: `workspaceId ?? automationWorkspaceId` is NULL, and the
    // executor's payload is typed `workspaceId: string` with every downstream
    // read scoped by `eq(..., workspaceId)`. Dispatching NULL would open a run
    // that sits in `running` against an empty scope. Skip loudly instead.
    selectResults = [
      [], // workspace-member floor
      [], // pod-visible workspaces
      [
        {
          id: "auto-pod-wide",
          triggerConfig: { eventPattern: "entity.create.*" },
          workspaceId: null,
        },
      ],
    ];

    await handleAutomationTriggerMatch({
      data: { ...ENTITY_EVENT, workspaceId: null },
    });

    expect(bossSend).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
