/**
 * AN APPROVED WORK GUIDELINE MUST REACH THE AGENT THAT BLOCKS.
 *
 * THE DEFECT this pins: approving `governance.work_guideline` wrote a
 * `config_settings` row scoped `workKind = <blockedReason>`, and nothing ever
 * read it — `resolveGuidelines` matches a workKind row only when `workKind` is
 * passed, and no caller passed it. Success receipt, nothing changed.
 *
 * Driven through the REAL doors (`blockExpectedOutput`, `updateFocusSession`)
 * and the REAL resolver (`resolveGuidelines` — only its injected `db` handle is
 * stubbed, like `config-settings.test.ts`). No live Postgres in the api suite,
 * so the stub hands back the rows the SQL floor would already have filtered;
 * the in-memory workKind match — the part that was never reached — is real.
 *
 * Negative controls (run by hand, recorded in the wave report): dropping the
 * `workKind` pass-through in `findWorkGuidelines` turns the two "carries the
 * text" tests red; deleting the `guidanceForBlockedSlots` call from either door
 * turns that door's test red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";

// ── fixture state ───────────────────────────────────────────────────────────
let guidelineRows: unknown[] = [];
let guidelineReadFails = false;
let guidelineSelects = 0;
let storedOutputs: ExpectedOutput[] = [];

const SESSION = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  goal: "Ship the billing page",
  currentStage: null,
};

function guideline(
  id: string,
  scopeKind: string,
  scopeRef: string | null,
  text: string
) {
  return {
    id,
    scopeKind,
    scopeRef,
    value: { text },
    shape: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };
}

const dbStub = {
  // `resolveGuidelines`: select().from().where(), awaited directly.
  select: () => ({
    from: () => ({
      where: () => {
        guidelineSelects += 1;
        return {
          then: (
            resolve: (r: unknown[]) => void,
            reject: (e: Error) => void
          ) =>
            guidelineReadFails
              ? reject(new Error("connection reset"))
              : resolve(guidelineRows),
        };
      },
    }),
  }),
  query: {
    focusSessions: {
      findFirst: async () => ({ ...SESSION, expectedOutputs: storedOutputs }),
    },
  },
  // `updateFocusSession`'s row-locked RMW.
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [{ expectedOutputs: storedOutputs }],
          }),
        }),
      }),
      update: () => ({
        set: (values: { expectedOutputs?: ExpectedOutput[] }) => ({
          where: () => ({
            returning: async () => {
              if (values.expectedOutputs)
                storedOutputs = values.expectedOutputs;
              return [{ ...SESSION, ...values }];
            },
          }),
        }),
      }),
    }),
};

// PARTIAL mocks only — a total mock of a module this code imports goes dark the
// day that module gains an export.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: dbStub,
}));
vi.mock("../delegate-output.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateExpectedOutputsLocked: async (
    _id: string,
    mutate: (c: ExpectedOutput[]) => ExpectedOutput[] | null
  ) => {
    const next = mutate(storedOutputs);
    if (!next) return false;
    storedOutputs = next;
    return true;
  },
}));
vi.mock("../assert-output-ref-visible.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findUnreachableOutputRefs: async () => [],
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ allowed: true }),
}));

const { blockExpectedOutput } = await import("../block-output.js");
const { updateFocusSession } = await import("../update-session.js");
const { guidanceForBlockedSlots, newlyBlockedSlots } =
  await import("../block-guidelines.js");

const CREDENTIAL_TEXT =
  "Stripe keys live in the team vault under billing/ — fetch it with the vault tool before asking.";

beforeEach(() => {
  guidelineRows = [
    guideline("g-cred", "workKind", "credential", CREDENTIAL_TEXT),
    // A default-scoped interpret instruction matches EVERY context — it must
    // never be reported as guidance about a kind of block.
    guideline("g-default", "default", null, "Always reply in French."),
  ];
  guidelineReadFails = false;
  guidelineSelects = 0;
  storedOutputs = [{ kind: "document", label: "Stripe restricted key" }];
});

describe("blockExpectedOutput — the block door carries matching guidance", () => {
  it("a credential block returns the credential guideline's text", async () => {
    const result = await blockExpectedOutput({
      sessionId: SESSION.id,
      userId: SESSION.userId,
      expectedLabel: "Stripe restricted key",
      blockedReason: "credential",
      why: "the live-account key",
    });
    expect(result.status).toBe("blocked");
    const guidance = (result as { blockGuidelines?: unknown }).blockGuidelines;
    expect(guidance).toMatchObject({
      status: "matched",
      matches: [
        {
          expectedLabel: "Stripe restricted key",
          blockedReason: "credential",
          guidelines: [{ id: "g-cred", text: CREDENTIAL_TEXT }],
        },
      ],
    });
    expect(JSON.stringify(guidance)).not.toContain("French");
    // The slot is STILL filed on the human — guidance annotates, never retires.
    expect(storedOutputs[0]).toMatchObject({
      owner: "human",
      blockedReason: "credential",
    });
    expect(storedOutputs[0]).not.toHaveProperty("retiredAt");
  });

  it("a capability block looks, finds no match, and says nothing", async () => {
    const result = await blockExpectedOutput({
      sessionId: SESSION.id,
      userId: SESSION.userId,
      expectedLabel: "Stripe restricted key",
      blockedReason: "capability",
    });
    expect(result.status).toBe("blocked");
    expect(guidelineSelects).toBe(1);
    expect(result).not.toHaveProperty("blockGuidelines");
  });

  it("a failed guideline read keeps the block and reports `unavailable`, never an empty match", async () => {
    guidelineReadFails = true;
    const result = await blockExpectedOutput({
      sessionId: SESSION.id,
      userId: SESSION.userId,
      expectedLabel: "Stripe restricted key",
      blockedReason: "credential",
    });
    expect(result.status).toBe("blocked");
    expect(
      (result as { blockGuidelines?: { status: string } }).blockGuidelines
        ?.status
    ).toBe("unavailable");
    expect(storedOutputs[0]).toMatchObject({ owner: "human" });
  });
});

describe("updateFocusSession — the MCP append door carries matching guidance", () => {
  it("appending a human-owned credential slot returns the guideline text", async () => {
    const result = await updateFocusSession({
      sessionId: SESSION.id,
      userId: SESSION.userId,
      addOutput: {
        kind: "document",
        label: "Live webhook secret",
        owner: "human",
        blockedReason: "credential",
        why: "the webhook signing secret",
      },
    });
    expect(result.status).toBe("updated");
    expect(
      (result as { blockGuidelines?: unknown }).blockGuidelines
    ).toMatchObject({
      status: "matched",
      matches: [
        {
          expectedLabel: "Live webhook secret",
          guidelines: [{ text: CREDENTIAL_TEXT }],
        },
      ],
    });
    expect(storedOutputs.at(-1)).toMatchObject({
      label: "Live webhook secret",
      owner: "human",
      status: "pending",
    });
  });

  it("an agent-owned append performs NO guideline lookup", async () => {
    const result = await updateFocusSession({
      sessionId: SESSION.id,
      userId: SESSION.userId,
      addOutput: { kind: "document", label: "Draft copy" },
    });
    expect(result.status).toBe("updated");
    expect(guidelineSelects).toBe(0);
    expect(result).not.toHaveProperty("blockGuidelines");
  });
});

describe("guidanceForBlockedSlots / newlyBlockedSlots — who gets looked up", () => {
  it("no blockedReason, or not human-owned ⇒ no lookup at all", async () => {
    const out = await guidanceForBlockedSlots({
      userId: "user-1",
      workspaceId: null,
      slots: [
        { label: "a", owner: "human" },
        { label: "b", owner: "agent", blockedReason: "credential" },
        { label: "c", blockedReason: "credential" },
      ],
    });
    expect(out).toBeUndefined();
    expect(guidelineSelects).toBe(0);
  });

  it("an echoed, already-blocked slot is not a new declaration; a changed reason is", () => {
    const before: ExpectedOutput[] = [
      { kind: "d", label: "Key", owner: "human", blockedReason: "credential" },
      { kind: "d", label: "Tool", owner: "human", blockedReason: "decision" },
    ];
    const after: ExpectedOutput[] = [
      { kind: "d", label: "key", owner: "human", blockedReason: "credential" },
      { kind: "d", label: "Tool", owner: "human", blockedReason: "capability" },
      { kind: "d", label: "Fresh", owner: "human", blockedReason: "physical" },
      { kind: "d", label: "Mine" },
    ];
    expect(newlyBlockedSlots(before, after).map((s) => s.label)).toEqual([
      "Tool",
      "Fresh",
    ]);
  });
});
