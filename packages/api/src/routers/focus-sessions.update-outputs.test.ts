/**
 * `focusSessions.update` — patching the declared deliverables without erasing
 * what the server owns.
 *
 * The board reads a session's `expectedOutputs`, lets a person rename or drop a
 * slot, and PATCHes the whole array back. Every field it does not know about —
 * the delegation, the reviewer's return note, the approval lineage behind a
 * `done` — used to be destroyed by that round-trip, twice over: the wire schema
 * STRIPPED the keys at the parse, and the door then ASSIGNED the array verbatim.
 *
 * These drive the real tRPC procedure and read the actual `set()` payload, so
 * "the delegation survives" is a claim about the row that reaches the column.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";

const findFirstSpy = vi.fn();
/** Every top-level `update().set()` payload, in order. */
const sets: Record<string, unknown>[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      // The tRPC read-only guard seeds `syncGeneration` on every call.
      insert: () => {
        const chain: Record<string, unknown> = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          sets.push(patch);
          return {
            where: () => ({
              returning: async () => [{ id: SESSION, ...patch }],
            }),
          };
        },
      }),
      // `query.<table>.findFirst` for ANY table — the tRPC layer reads
      // `syncGeneration` on every call, so a mock spelling out only
      // `focusSessions` breaks before the procedure body is reached.
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

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

/** The stored slots: one delegated, one satisfied, one returned. */
const STORED = [
  {
    kind: "document",
    label: "Spec",
    delegatedTo: "workspace-builder",
    delegatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    kind: "document",
    label: "Summary",
    status: "done",
    satisfiedByProposalId: "prop-1",
  },
  {
    kind: "entity",
    label: "Client record",
    returnedReason: "wrong company",
    returnedAt: "2026-09-02T00:00:00.000Z",
  },
];

const writtenOutputs = () =>
  sets.at(-1)!.expectedOutputs as Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  sets.length = 0;
  findFirstSpy.mockResolvedValue({
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    goal: "Ship the thing",
    status: "active",
    currentStage: null,
    expectedOutputs: STORED,
  });
});

describe("focusSessions.update — expectedOutputs is MERGED, not replaced", () => {
  it("a narrow four-field PATCH preserves the delegation, the lineage and the return note", async () => {
    await caller().update({
      id: SESSION,
      // Exactly what a client written against `{kind,label,icon,status}` sends.
      expectedOutputs: STORED.map((o) => ({
        kind: o.kind,
        label: o.label,
        ...(o.status ? { status: o.status as "done" } : {}),
      })),
    });

    const written = writtenOutputs();
    expect(written[0]).toMatchObject({
      label: "Spec",
      delegatedTo: "workspace-builder",
      delegatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(written[1]).toMatchObject({
      label: "Summary",
      status: "done",
      satisfiedByProposalId: "prop-1",
    });
    expect(written[2]).toMatchObject({
      label: "Client record",
      returnedReason: "wrong company",
      returnedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("still applies the caller's own edit to the fields the caller owns", async () => {
    await caller().update({
      id: SESSION,
      expectedOutputs: [{ kind: "view", label: "Spec", icon: "table" }],
    });
    expect(writtenOutputs()[0]).toMatchObject({
      kind: "view",
      icon: "table",
      delegatedTo: "workspace-builder",
    });
  });

  it("OMITTING a slot still deletes it — the wholesale semantic is unchanged", async () => {
    await caller().update({
      id: SESSION,
      expectedOutputs: [{ kind: "document", label: "Spec" }],
    });
    const written = writtenOutputs();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ label: "Spec" });
  });

  it("accepts the server-owned fields on the wire instead of stripping them", async () => {
    // The schema half of the defect: a caller that genuinely holds the current
    // slot must be able to round-trip it. The keys must survive the PARSE — a
    // strip there erases them before any merge can carry them.
    await caller().update({
      id: SESSION,
      expectedOutputs: [
        {
          kind: "document",
          label: "Spec",
          delegatedTo: "workspace-builder",
          delegatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    expect(writtenOutputs()[0]).toMatchObject({
      delegatedTo: "workspace-builder",
      delegatedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("REFUSES a patch that CHANGES a delegation instead of echoing it", async () => {
    // CORRECTED 2026-09-08. This case previously asserted that an explicit
    // change WINS, which is the wholesale bypass: the same rule that let
    // `delegatedTo` be reassigned let `status: "done"` and a forged `attestedBy`
    // through, with no receipt and no proposal. Round-tripping is a client
    // right; re-authoring a server stamp never was.
    await expect(
      caller().update({
        id: SESSION,
        expectedOutputs: [
          {
            kind: "document",
            label: "Spec",
            delegatedTo: "researcher",
            delegatedAt: "2026-09-05T00:00:00.000Z",
          },
        ],
      })
    ).rejects.toThrow(/server-stamped/i);
    // …and it is a refusal, not a partial write: nothing reached the column.
    expect(sets).toHaveLength(0);
  });
});
