import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap_capture` `table` (ticket a8884743): a register of 57 expense lines,
 * each naming its receipt by number, is ONE proposal through the existing
 * graph lane, with one relation per matched receipt to the EXISTING receipt
 * entity. A receipt number nothing matches is reported in the reply; a table
 * over the cap is refused before any read or write.
 *
 * Driven through the real MCP capture handler. Stubbed at module seams only:
 * the `linkBy` read (its fixture applies exact equality, as the SQL does), the
 * submit core and dry run, and the intake side-effects.
 */

const h = vi.hoisted(() => ({
  // Existing receipt entities, by receipt number: R-001 … R-055 exist.
  receipts: new Map<string, string>(),
  submitResult: undefined as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveProjectPlacement: vi.fn(async () => ({
      projectId: null,
      rung: null,
    })),
    resolveIdentity: vi.fn(async () => ({
      match: null,
      crossKindCandidates: [],
    })),
  };
});

vi.mock("../../../services/capture-agent/capture-table-links.js", () => ({
  findLinkByMatches: vi.fn(
    async (_db: unknown, input: { values: string[] }) => {
      const matches = new Map<string, string[]>();
      for (const value of input.values) {
        const id = h.receipts.get(value);
        if (id) matches.set(value, [id]);
      }
      return matches;
    }
  ),
}));
vi.mock("../../../services/capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: vi.fn(async () => h.submitResult),
  dryRunCaptureGraph: vi.fn(
    async (
      _db: unknown,
      input: { entities: unknown[]; relations: unknown[] }
    ) => ({
      entityCount: input.entities.length,
      relationCount: input.relations.length,
      relationsFailed: [],
      invalidEntities: [],
      unresolvedProfiles: [],
      planProblems: [],
      unmodeledProperties: [],
      modeledFields: [],
    })
  ),
}));
vi.mock("../../../services/intake/ensure-intake-session.js", () => ({
  ensureIntakeSession: vi.fn(async () => ({
    sessionId: "S-1",
    status: "verified",
    requestedSessionIgnored: false,
  })),
}));
vi.mock("../../../utils/permission-check.js", () => ({
  resolveAgentRunReceipt: vi.fn(async () => "S-RUN-RECEIPT"),
}));
vi.mock("../../../services/intake/record-structure-intake.js", () => ({
  recordStructureIntake: vi.fn(async () => null),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  computeCaptureGraphIdempotencyKey: () => "k".repeat(64),
}));

const { captureHandlers } = await import("./capture.js");
const { submitCaptureGraph, dryRunCaptureGraph } =
  await import("../../../services/capture-agent/submit-capture-graph.js");
const { findLinkByMatches } =
  await import("../../../services/capture-agent/capture-table-links.js");

async function call(args: Record<string, unknown>) {
  const result = await captureHandlers.synap_capture!({
    toolName: "synap_capture",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.write"],
    agentUserId: "agent-1",
    sessionId: "S-1",
    requestedWorkspaceId: undefined,
    confinedWorkspaceId: undefined,
    workspaceAccessible: false,
    caller: {},
    lensCaller: {},
  } as never);
  const block = (result.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(block!.text) as Record<string, unknown>;
}

const num = (i: number) => `R-${String(i).padStart(3, "0")}`;

/** 57 expense lines; lines 56 and 57 name receipts the pod does not hold. */
const register = (n = 57) => ({
  profileSlug: "expense",
  columns: ["title", "amount", "currency", "vendor", "receipt"],
  rows: Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return [`Expense line ${i}`, 10 + i, "EUR", `Vendor ${i}`, num(i)];
  }),
  linkBy: [
    {
      column: "receipt",
      profileSlug: "document",
      property: "receipt",
      type: "references",
    },
  ],
});

beforeEach(() => {
  vi.mocked(submitCaptureGraph).mockClear();
  vi.mocked(dryRunCaptureGraph).mockClear();
  vi.mocked(findLinkByMatches).mockClear();
  h.receipts = new Map(
    Array.from({ length: 55 }, (_, k) => [num(k + 1), `receipt-${k + 1}`])
  );
  h.submitResult = {
    proposalId: "prop-1",
    entityCount: 112,
    relationCount: 55,
    bindingCount: 0,
    reviewUrl: "https://x/open/prop-1",
    summary: "summary",
    applied: false,
    sessionId: "S-1",
    scope: { workspaceId: null, projectId: null, sessionId: "S-1" },
    writeReceipt: {
      state: "pending",
      proposalId: "prop-1",
      effectiveWorkspaceId: null,
      projectId: null,
      source: "agent",
    },
  };
});

describe("synap_capture table: 57 expense lines linked to receipts by number", () => {
  it("files ONE proposal: 57 new expenses, each matched receipt linked as an existing entity", async () => {
    const out = await call({ table: register() });

    expect(submitCaptureGraph).toHaveBeenCalledTimes(1);
    const [submitted] = vi.mocked(submitCaptureGraph).mock.calls[0]!;
    const input = submitted as unknown as {
      entities: Array<Record<string, unknown>>;
      relations: Array<{ sourceRef: string; targetRef: string; type: string }>;
      summary?: string;
    };
    const created = input.entities.filter((e) => !e.existingEntityId);
    expect(created).toHaveLength(57);
    expect(created.every((e) => e.profileSlug === "expense")).toBe(true);
    expect(created[0]).toMatchObject({
      ref: "rows[0]",
      title: "Expense line 1",
      properties: {
        amount: 11,
        currency: "EUR",
        vendor: "Vendor 1",
        receipt: "R-001",
      },
    });

    const linked = input.entities.filter((e) => e.existingEntityId);
    expect(linked).toHaveLength(55);
    expect(linked.every((e) => e.profileSlug === "document")).toBe(true);
    const idOfRef = new Map(
      linked.map((e) => [e.ref as string, e.existingEntityId as string])
    );

    // Line i references receipt i, exactly: no row is linked to another's.
    expect(input.relations).toHaveLength(55);
    for (const r of input.relations) {
      const row = Number(/^rows\[(\d+)\]$/.exec(r.sourceRef)![1]);
      expect(r.type).toBe("references");
      expect(idOfRef.get(r.targetRef)).toBe(`receipt-${row + 1}`);
    }

    // The review card names the size of the change, not the first row.
    expect(input.summary).toMatch(/^Import 57 expenses/);
    expect(input.summary).toContain("linking 55 already in your pod");

    expect(out.status).toBe("proposed");
    expect(out.table).toEqual({
      rows: 57,
      linkBy: [
        {
          column: "receipt",
          linked: 55,
          unmatched: [
            { row: 55, value: "R-056" },
            { row: 56, value: "R-057" },
          ],
          ambiguous: [],
        },
      ],
    });
    expect(out.tableNote).toContain("unmatched");
  });

  it("looks the receipts up by exact value, once per distinct number", async () => {
    await call({ table: register() });
    expect(findLinkByMatches).toHaveBeenCalledTimes(1);
    const [, lookup] = vi.mocked(findLinkByMatches).mock.calls[0]!;
    expect(lookup.linkBy).toEqual({
      column: "receipt",
      profileSlug: "document",
      property: "receipt",
      type: "references",
    });
    expect(lookup.values).toHaveLength(57);
    expect(lookup.values[0]).toBe("R-001");
  });

  it("validate:true runs the same expansion and writes nothing", async () => {
    const out = await call({ table: register(), validate: true });
    expect(submitCaptureGraph).not.toHaveBeenCalled();
    expect(dryRunCaptureGraph).toHaveBeenCalledTimes(1);
    const [, checked] = vi.mocked(dryRunCaptureGraph).mock.calls[0]!;
    const input = checked as unknown as {
      entities: unknown[];
      relations: unknown[];
    };
    expect(input.entities).toHaveLength(57 + 55);
    expect(input.relations).toHaveLength(55);
    expect(out.dryRun).toBe(true);
    expect(out.status).toBe("valid");
    expect(out.summary).toMatch(/^Import 57 expenses/);
    expect(
      (out.table as { linkBy: Array<{ unmatched: unknown[] }> }).linkBy[0]!
        .unmatched
    ).toHaveLength(2);
  });

  it("refuses 501 rows by the named cap, before any read or write", async () => {
    const out = await call({ table: register(501) });
    expect(findLinkByMatches).not.toHaveBeenCalled();
    expect(submitCaptureGraph).not.toHaveBeenCalled();
    expect(out.error).toContain("CAPTURE_TABLE_MAX_ROWS");
    expect(out.limit).toEqual({
      name: "CAPTURE_TABLE_MAX_ROWS",
      max: 500,
      rows: 501,
    });
  });
});
