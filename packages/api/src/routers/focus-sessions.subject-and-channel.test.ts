/**
 * `focusSessions` — the SUBJECT write door and the ROOM door.
 *
 * Two gaps this pins, both of which read from the browser as "the feature does
 * not exist" rather than as an error:
 *
 *   1. SUBJECT. `createFocusSession` has always accepted `subjectEntityId`, and
 *      the column has always been there — but neither tRPC door DECLARED it, so
 *      every browser-started session landed subject-less and the room's Subject
 *      row could only ever read "No subject". A field the service accepts and a
 *      door never declares is indistinguishable, from outside, from a field
 *      deliberately withheld.
 *   2. ROOM. `ensureSessionChannel` was called only by the CREATE paths, so an
 *      ad-hoc session that started channel-less stayed channel-less forever and
 *      its composer was permanently disabled.
 *
 * These drive the REAL tRPC procedures and read the actual `set()` payload / the
 * actual channel insert, so "the subject reaches the column" is a claim about
 * the row, not about a type.
 *
 * The floor is asserted through the SAME predicate the output doors use
 * (`isOutputRefVisible`), mocked here at its module boundary so this file tests
 * the DOOR's wiring — that a refusal happens and NOTHING is written — rather
 * than re-testing postgres visibility, which
 * `services/focus-sessions/__tests__/assert-output-ref-visible.test.ts` owns.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const ENTITY = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "55555555-5555-4555-8555-555555555555";

const findFirstSpy = vi.fn();
/**
 * Every literal a drizzle `where` chunk BINDS, harvested by walking the tree for
 * `Param`-shaped nodes. Used to prove the owner floor actually reaches the
 * query: an id-only load binds one value, an owner-floored load binds two.
 * Shape-free on purpose — it never inspects the operator, only what is bound.
 */
const boundValues = (
  node: unknown,
  out: unknown[] = [],
  // Drizzle's column/table graph is CYCLIC (a column points back at its table),
  // so an unguarded walk blows the stack and the door's real refusal is masked
  // by an INTERNAL_SERVER_ERROR that looks like a passing floor from a distance.
  seen: WeakSet<object> = new WeakSet()
): unknown[] => {
  if (node === null || typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);
  const rec = node as Record<string, unknown>;
  if ("value" in rec && typeof rec.value !== "object") out.push(rec.value);
  for (const v of Object.values(rec)) {
    if (Array.isArray(v)) v.forEach((x) => boundValues(x, out, seen));
    else if (v && typeof v === "object") boundValues(v, out, seen);
  }
  return out;
};
/** Every top-level `update().set()` payload, in order. */
const sets: Record<string, unknown>[] = [];
/** Every `insert(table).values()` payload, tagged with the table it targeted. */
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
/** What the mocked `ensureSessionChannel` will hand back. */
const refVisible = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      insert: (table: unknown) => {
        const chain: Record<string, unknown> = {
          values: (v: Record<string, unknown>) => {
            inserts.push({ table, values: v });
            return chain;
          },
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [{ id: CHANNEL }],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          sets.push(patch);
          return {
            where: () => {
              const r = {
                returning: async () => [{ id: SESSION, ...patch }],
                then: (resolve: (v: unknown) => void) => resolve([]),
              };
              return r;
            },
          };
        },
      }),
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "focusSessions") return { findFirst: findFirstSpy };
          return { findFirst: async () => undefined };
        },
      }),
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

// The visibility floor, at ITS module boundary — the door under test must be
// the thing that calls it and the thing that refuses on a `false`.
vi.mock(
  "../services/focus-sessions/assert-output-ref-visible.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, isOutputRefVisible: refVisible };
  }
);

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  userId: "user-1",
  workspaceId: WS,
  goal: "Ship the thing",
  status: "active",
  currentStage: null,
  channelId: null,
  subjectEntityId: null,
  expectedOutputs: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sets.length = 0;
  inserts.length = 0;
  refVisible.mockResolvedValue(true);
  findFirstSpy.mockResolvedValue(sessionRow());
});

/** The last session `set()` — the room mint writes one too, so filter by key. */
const lastSet = () => sets.at(-1)!;

describe("focusSessions.update — the SUBJECT anchor reaches the column", () => {
  it("SETS the subject, through the same floor an output ref goes through", async () => {
    await caller().update({ id: SESSION, subjectEntityId: ENTITY });

    // The floor was consulted, for the entity, as an ENTITY.
    expect(refVisible).toHaveBeenCalledWith({
      userId: "user-1",
      kind: "entity",
      refId: ENTITY,
    });
    expect(lastSet()).toMatchObject({ subjectEntityId: ENTITY });
  });

  it("CLEARS the subject on an explicit null, and does not consult the floor", async () => {
    await caller().update({ id: SESSION, subjectEntityId: null });
    // `null` names no object, so there is nothing to authorize.
    expect(refVisible).not.toHaveBeenCalled();
    // The distinguishing assertion: the key is PRESENT and null. A door that
    // treated `null` as "unset" would leave the key off entirely and the old
    // subject would survive — which is the un-clearable field this replaces.
    expect(lastSet()).toHaveProperty("subjectEntityId", null);
  });

  it("LEAVES the anchor alone when the field is omitted", async () => {
    await caller().update({ id: SESSION, progress: 40 });
    expect(lastSet()).not.toHaveProperty("subjectEntityId");
  });

  it("REFUSES an entity the caller cannot see, and writes NOTHING", async () => {
    refVisible.mockResolvedValue(false);
    await expect(
      caller().update({ id: SESSION, subjectEntityId: ENTITY })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Property 2, the one that is easy to get wrong: the refusal happened
    // BEFORE the write. A door that threw after assigning `set` would still
    // reject and still leave the row re-pointed.
    expect(sets).toHaveLength(0);
  });
});

describe("focusSessions.create — the SUBJECT anchor is sayable at the door", () => {
  it("carries subjectEntityId into the create service, floored", async () => {
    const createSpy = vi.fn().mockResolvedValue({
      status: "created",
      session: sessionRow({ subjectEntityId: ENTITY }),
    });
    vi.doMock("../services/focus-sessions/create-session.js", () => ({
      createFocusSession: createSpy,
    }));
    vi.resetModules();
    const { focusSessionsRouter: fresh } = await import("./focus-sessions.js");
    // The floor mock is module-scoped; re-arm it for the fresh graph.
    refVisible.mockResolvedValue(true);

    await fresh.createCaller(ctx).create({
      workspaceId: WS,
      goal: "Ship the thing",
      subjectEntityId: ENTITY,
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subjectEntityId: ENTITY })
    );
    vi.doUnmock("../services/focus-sessions/create-session.js");
    vi.resetModules();
  });
});

describe("focusSessions.ensureChannel — one room, never two", () => {
  it("MINTS a room for a channel-less session and returns its id", async () => {
    const res = await caller().ensureChannel({ sessionId: SESSION });
    expect(res).toEqual({ channelId: CHANNEL });
    // The room came from the ONE channel writer: a `channels` insert bound to
    // this session as its context object.
    const channelInsert = inserts.find(
      (i) => i.values.contextObjectType === "focus_session"
    );
    expect(channelInsert?.values).toMatchObject({
      contextObjectId: SESSION,
      workspaceId: WS,
    });
  });

  it("is IDEMPOTENT — a session that already has a room mints nothing", async () => {
    findFirstSpy.mockResolvedValue(sessionRow({ channelId: CHANNEL }));
    const res = await caller().ensureChannel({ sessionId: SESSION });
    expect(res).toEqual({ channelId: CHANNEL });
    // The discriminating assertion: a second writer would have inserted a
    // second `channels` row and returned a DIFFERENT id. Zero inserts is the
    // only outcome that rules that out.
    expect(
      inserts.filter((i) => i.values.contextObjectType === "focus_session")
    ).toHaveLength(0);
  });

  it("is FLOORED on the owner — someone else's session is NOT_FOUND", async () => {
    // The mock acts as a tiny database: it hands back the row ONLY when the
    // door's own predicate binds the caller's userId. An id-only load (the
    // shape this floor replaces) binds just the session id, gets the row, and
    // mints a room in a session it does not own — which is what makes this a
    // real negative control rather than a mock that always says no.
    // The stored row: id SESSION, owner "user-1". A predicate that binds any
    // other literal (here the stranger's userId) matches nothing.
    findFirstSpy.mockImplementation(async (args: { where: unknown }) => {
      const bound = boundValues(args?.where);
      const matches = bound.every((v) => v === SESSION || v === "user-1");
      return matches ? sessionRow({ userId: "user-1" }) : undefined;
    });
    // Same call, but the session belongs to someone else: the caller is
    // "user-2", so the floored predicate binds "user-2" and matches nothing.
    const stranger = focusSessionsRouter.createCaller({
      userId: "user-2",
      authenticated: true,
    } as never);
    await expect(
      stranger.ensureChannel({ sessionId: SESSION })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inserts).toHaveLength(0);
  });
});
