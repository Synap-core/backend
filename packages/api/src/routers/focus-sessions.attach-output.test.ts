/**
 * `focusSessions.attachOutput` — the HUMAN door for "this object is this
 * session's output".
 *
 * `recordSessionArtifact` had only agent callers (the MCP entity door, the Hub
 * documents door), each reaching it as a side effect of creating the object
 * itself. A person who made a document by hand could not attribute it to the
 * session at all, so a session room's output list could only ever show agent
 * work.
 *
 * What can actually break here is the FLOOR (a foreign session's ledger being
 * writable) and the FORWARDING (a declared input that reaches no writer — the
 * severance class this repo keeps paying for). These read the ROW THAT WOULD BE
 * INSERTED rather than mocking the artifact writer, so a claim that
 * `expectedLabel` is recorded is a claim about the actual ledger values.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const SESSION = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";

const findFirstSpy = vi.fn();
const insertValuesSpy = vi.fn();
/**
 * The REFERENCED object's row (`isOutputRefVisible` reads it through `scopedDb`,
 * which goes to `db.query.documents.findFirst`). `undefined` ⇒ the caller cannot
 * see it — the visibility refusal, not a missing mock.
 */
let refRow: unknown = { id: DOC };
let insertThrows = false;
/** Simulate the unique index absorbing the write (0246). */
let insertConflicts = false;
/** What `db.query.artifacts.findFirst` answers when the writer re-selects. */
let existingArtifact: unknown = { id: "artifact-existing" };

const dialect = new PgDialect();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      // `accessScopeWhere` (the entity/document visibility floor the ref check
      // reads through) BUILDS `exists(db.select()…)` subqueries — it never runs
      // them. Delegating to the real query builder keeps the predicate honest
      // without opening a connection.
      select: (...args: unknown[]) =>
        (actual.db as { select: (...a: unknown[]) => unknown }).select(...args),
      // `query.<table>.findFirst` for ANY table: the tRPC layer reads
      // `syncGeneration` on every call, so a mock spelling out only
      // `focusSessions` breaks before the procedure body is reached.
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "focusSessions") return { findFirst: findFirstSpy };
          if (table === "artifacts")
            return { findFirst: async () => existingArtifact };
          // Every table the refId floor resolves through — one list, so a new
          // artifact kind that forgets its floor fails here loudly.
          if (
            table === "documents" ||
            table === "entities" ||
            table === "views" ||
            table === "automations" ||
            table === "playbooks"
          )
            return { findFirst: async () => refRow };
          return { findFirst: async () => undefined };
        },
      }),
      // The tRPC layer inserts on its own (sync generation), so the chain is
      // permissive and only the ARTIFACTS insert is captured.
      insert: (table: unknown) => {
        const isArtifacts = table === actual.artifacts;
        const chain: Record<string, unknown> = {
          values: (row: unknown) => {
            if (!isArtifacts) return chain;
            insertValuesSpy(row);
            if (insertThrows) throw new Error("ledger down");
            return chain;
          },
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          // `DO NOTHING` returns NO ROW when the unique index already holds the
          // claim — the case the writer must recover from by re-selecting.
          returning: async () =>
            isArtifacts && !insertConflicts ? [{ id: "artifact-1" }] : [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
    },
  };
});

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);
const insertedRow = () =>
  insertValuesSpy.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  insertThrows = false;
  insertConflicts = false;
  existingArtifact = { id: "artifact-existing" };
  refRow = { id: DOC };
  findFirstSpy.mockResolvedValue({
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    expectedOutputs: [{ kind: "document", label: "Spec" }],
  });
});

describe("focusSessions.attachOutput — owner floor", () => {
  it("rejects a session that is not the caller's", async () => {
    // The owner predicate is IN the query, so a foreign session comes back
    // empty and is indistinguishable from a missing one — on purpose.
    findFirstSpy.mockResolvedValue(undefined);
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "document",
        refId: DOC,
      })
    ).rejects.toThrow(/not found/i);
    expect(insertValuesSpy).not.toHaveBeenCalled();
  });

  it("puts the CALLER's id in the session lookup predicate, not just the id", async () => {
    // The test above passes with `eq(focusSessions.userId, ctx.userId)` DELETED
    // — an empty mock result proves nothing about the query that produced it.
    // This reads the predicate the door actually built, which is the only thing
    // that stops one user attaching outputs to another user's session.
    await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
    });
    const where = (findFirstSpy.mock.calls[0]![0] as { where: never }).where;
    const compiled = dialect.sqlToQuery(where);
    expect(compiled.sql).toMatch(/user_id"?\s*=/);
    expect(compiled.params).toContain("user-1");
    expect(compiled.params).toContain(SESSION);
  });
});

describe("focusSessions.attachOutput — pod-personal sessions", () => {
  it("records a workspace-less session's output with workspaceId null", async () => {
    // Until 0245 this threw PRECONDITION_FAILED: `artifacts.workspace_id` was
    // NOT NULL, so the room's whole purpose was off for the MAJORITY of
    // sessions (a pod-personal session is the common case, not the edge one).
    findFirstSpy.mockResolvedValue({
      id: SESSION,
      userId: "user-1",
      workspaceId: null,
    });
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
    });
    expect(result).toEqual({ ok: true, outputId: "artifact-1" });
    expect(insertedRow().workspaceId).toBeNull();
  });

  it("uses input.workspaceId ONLY when the session has none", async () => {
    findFirstSpy.mockResolvedValue({
      id: SESSION,
      userId: "user-1",
      workspaceId: null,
    });
    await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      workspaceId: WS,
    });
    expect(insertedRow().workspaceId).toBe(WS);
  });

  it("never lets input.workspaceId re-file an output away from its session", async () => {
    // The session's own lens wins. Otherwise a caller could park a row in a
    // workspace the session has nothing to do with.
    const other = "44444444-4444-4444-8444-444444444444";
    await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      workspaceId: other,
    });
    expect(insertedRow().workspaceId).toBe(WS);
  });
});

describe("focusSessions.attachOutput — the referenced object's floor", () => {
  it("refuses a refId the caller cannot see", async () => {
    // Without this, posting ANY uuid to your OWN session and re-reading
    // `focusSessions.outputs` returned that object's LIVE title — `resolveTitles`
    // joins by bare `inArray(id)`. The floor belongs at the write door.
    refRow = undefined;
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "document",
        refId: DOC,
      })
    ).rejects.toThrow(/no document/i);
    expect(insertValuesSpy).not.toHaveBeenCalled();
  });
});

describe("focusSessions.attachOutput — the write", () => {
  it("records the artifact with HUMAN provenance and no agent actor", async () => {
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      label: "Launch spec",
    });
    expect(result).toEqual({ ok: true, outputId: "artifact-1" });
    expect(insertedRow()).toMatchObject({
      sessionId: SESSION,
      workspaceId: WS,
      userId: "user-1",
      kind: "document",
      refId: DOC,
      title: "Launch spec",
      // The join reads this as `producedBy: "human"`.
      originKind: "user",
      actorId: null,
    });
  });

  it("writes expectedLabel onto the row — the slot claim must not be dropped", async () => {
    await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      expectedLabel: "Spec",
    });
    // Exactly the coordinate `joinSessionOutputs` rule 3 reads back.
    expect(insertedRow().props).toEqual({ expectedLabel: "Spec" });
  });

  it("claiming a slot writes no `done` stamp anywhere", async () => {
    await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      expectedLabel: "Spec",
    });
    // `status: "done"` belongs to satisfyExpectedOutputs alone; this door
    // touches the artifacts ledger only.
    expect(JSON.stringify(insertedRow())).not.toContain("done");
  });

  it("reports failure when the ledger write did not land", async () => {
    // recordSessionArtifact is best-effort by contract and swallows the error;
    // a PERSON who clicked "record this" must not be told `ok` regardless.
    insertThrows = true;
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "document",
        refId: DOC,
      })
    ).rejects.toThrow(/could not record/i);
  });

  it("rejects a kind the artifacts ledger cannot hold", async () => {
    // `automation` used to be the sentinel here and is a REAL kind since 0246,
    // which is exactly why this must name something the column still cannot
    // hold — a sentinel that quietly becomes valid turns the test green while
    // testing nothing.
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "proposal" as never,
        refId: DOC,
      })
    ).rejects.toThrow();
    expect(insertValuesSpy).not.toHaveBeenCalled();
  });
});

describe("focusSessions.attachOutput — idempotency (0246)", () => {
  it("reports OK with the EXISTING row's id when the unique index absorbs the write", async () => {
    // A retry after a timeout, or a double-click, used to write a SECOND
    // provenance row and the room then listed the object twice. Now the index
    // absorbs it — and the caller must be told the truth, which is that the
    // output IS recorded, not that recording failed.
    insertConflicts = true;
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
    });
    expect(result).toEqual({ ok: true, outputId: "artifact-existing" });
  });

  it("still reports failure when the row is absent AND no existing row is found", async () => {
    // The conflict path must not become a blanket "assume it worked": with no
    // winner to point at, there is no ledger row and the person must be told.
    insertConflicts = true;
    existingArtifact = undefined;
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "document",
        refId: DOC,
      })
    ).rejects.toThrow(/could not record/i);
  });

  it("asks for the conflict winner using the SLOT as part of the key", async () => {
    // `expectedLabel` is in the unique key on purpose: the same document may
    // satisfy two different declared outputs, so a re-select that ignored the
    // label would hand back the wrong row and collapse two real claims.
    insertConflicts = true;
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "document",
      refId: DOC,
      expectedLabel: "Spec",
    });
    // The row that WOULD have been inserted still carries the slot claim, which
    // is the value the re-select keys on — and the caller gets the winner.
    expect(insertedRow().props).toEqual({ expectedLabel: "Spec" });
    expect(result).toEqual({ ok: true, outputId: "artifact-existing" });
  });
});

describe("focusSessions.attachOutput — widened kinds (0246)", () => {
  it("accepts an automation as an output kind", async () => {
    const AUTOMATION = "77777777-7777-4777-8777-777777777777";
    refRow = { id: AUTOMATION };
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "automation",
      refId: AUTOMATION,
    });
    expect(result.ok).toBe(true);
    expect(insertedRow()).toMatchObject({
      kind: "automation",
      refId: AUTOMATION,
    });
  });

  it("accepts a playbook as an output kind", async () => {
    const PLAYBOOK = "88888888-8888-4888-8888-888888888888";
    refRow = { id: PLAYBOOK };
    const result = await caller().attachOutput({
      sessionId: SESSION,
      kind: "playbook",
      refId: PLAYBOOK,
    });
    expect(result.ok).toBe(true);
    expect(insertedRow()).toMatchObject({ kind: "playbook", refId: PLAYBOOK });
  });

  it("refuses an automation the caller cannot see", async () => {
    refRow = undefined;
    await expect(
      caller().attachOutput({
        sessionId: SESSION,
        kind: "automation",
        refId: "77777777-7777-4777-8777-777777777777",
      })
    ).rejects.toThrow(/no automation/i);
    expect(insertValuesSpy).not.toHaveBeenCalled();
  });
});
