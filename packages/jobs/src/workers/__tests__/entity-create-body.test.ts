/**
 * `entity_create` output — the optional long-form `body` field.
 *
 * Contract under test (automation-executor.ts, case "entity_create"):
 *   - `body` ABSENT  → byte-identical to the previous behavior: no body door is
 *     touched, no entity id is pre-minted, no `documentId` is passed or returned.
 *   - `body` PRESENT + long → materialized through the canonical door
 *     (`EntityBodyService.setBody`) under a PRE-MINTED entity id, and that same
 *     id is the id the entity is created with, carrying `documentId` — i.e. the
 *     `entities.documentId` link. `documentId` is echoed in the step output.
 *   - `body` PRESENT + short → the service returns `{ inlineContent }`; the body
 *     lands in `properties.content` and NO document is linked (no orphan).
 *   - gate PROPOSED → the body is NOT materialized (no entity id exists yet, and
 *     a document written now would orphan on rejection); it travels on the
 *     proposal payload as `content`, the key the approve path already reads.
 *   - `dedupeBy` SKIP → returns before the gate, so no document is created for a
 *     duplicate (a retried step cannot mint a second document).
 *
 * WHAT THIS PROVES / DOES NOT: the db, the body service and the materializer are
 * mocked, so this locks CONTROL FLOW and the exact arguments crossing each door.
 * It does NOT prove Postgres behavior (the dedupe predicate, the FK, the actual
 * `documents` row) — that needs a live-PG integration run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

const mocks = vi.hoisted(() => ({
  setBody: vi.fn(),
  materializeEntity: vi.fn(),
  gate: vi.fn(),
  // Queue of rows each successive db.select(...).limit() resolves to, in call
  // order (dedupe lookup when `dedupeBy` is set, then the owner-user lookup).
  selectRows: [] as unknown[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class EntityBodyService {
    constructor(_db: unknown, _eventRepo: unknown) {}
    setBody = mocks.setBody;
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              mocks.selectRows.length ? mocks.selectRows.shift() : []
            ),
        }),
      }),
    }),
  };
  return {
    ...actual,
    db,
    EntityBodyService,
    materializeEntity: mocks.materializeEntity,
  };
});

vi.mock("../../utils/automation-governance.js", () => ({
  checkAutomationWriteOrPropose: mocks.gate,
}));

// Import AFTER the mocks so the executor picks up the mocked exports.
const { executeOutputStep } = await import("../automation-executor.js");

const OWNER = "user-owner";
const WORKSPACE = "ws-1";

const context = (): StepContext => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "auto-1", state: {} },
});

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "root-run-1",
  chainAutomationIds: [] as string[],
};

const runEntityCreate = (config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType: "entity_create", config },
    context(),
    WORKSPACE,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-ec", stepRunId: "sr-1" }
  );

/** Long enough (>= 600 chars) that the real heuristic would materialize it. */
const LONG_BODY = `# Weekly report\n\n${"Signal detected across the pipeline. ".repeat(30)}`;

describe("entity_create — optional long-form body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.gate.mockResolvedValue({ granted: true });
    mocks.materializeEntity.mockImplementation(
      async (input: Record<string, unknown>) => ({
        entity: {
          id: (input.id as string) ?? "db-minted-id",
          title: input.title ?? "Untitled",
        },
        reused: false,
      })
    );
  });

  it("(a) body ABSENT — no body door touched, no id pre-minted, no documentId", async () => {
    // owner-user lookup
    mocks.selectRows = [[{ userType: "human" }]];

    const result = await runEntityCreate({
      profileSlug: "report",
      title: "No body",
      properties: { status: "draft" },
    });

    expect(mocks.setBody).not.toHaveBeenCalled();
    const input = mocks.materializeEntity.mock.calls[0][0];
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("documentId");
    expect(input.properties).toEqual({ status: "draft" });
    expect(result).toEqual({
      status: "created",
      entityId: "db-minted-id",
      title: "No body",
    });
    expect(result).not.toHaveProperty("documentId");
  });

  it("(a2) whitespace-only body is treated as absent", async () => {
    mocks.selectRows = [[{ userType: "human" }]];
    await runEntityCreate({
      profileSlug: "report",
      title: "T",
      body: "   \n ",
    });
    expect(mocks.setBody).not.toHaveBeenCalled();
    expect(mocks.materializeEntity.mock.calls[0][0]).not.toHaveProperty("id");
  });

  it("(b) long body — document created under the pre-minted id AND linked via entities.documentId", async () => {
    mocks.selectRows = [[{ userType: "agent" }]];
    mocks.setBody.mockResolvedValue({ documentId: "doc-99" });

    const result = await runEntityCreate({
      profileSlug: "report",
      title: "AI Report",
      properties: { status: "final" },
      body: LONG_BODY,
    });

    expect(mocks.setBody).toHaveBeenCalledTimes(1);
    const bodyArgs = mocks.setBody.mock.calls[0][0];
    expect(bodyArgs.text).toBe(LONG_BODY);
    expect(bodyArgs.userId).toBe(OWNER);
    expect(bodyArgs.workspaceId).toBe(WORKSPACE);
    expect(bodyArgs.title).toBe("AI Report");
    // Provenance travels verbatim — an agent-owned automation stays ai_agent.
    expect(bodyArgs.provenance).toMatchObject({
      createdByKind: "ai_agent",
      agentUserId: OWNER,
      createdByUserId: OWNER,
      correlationId: "root-run-1",
    });

    const input = mocks.materializeEntity.mock.calls[0][0];
    // THE LINK: the entity is created with the SAME id the document was
    // namespaced under, and carries documentId.
    expect(typeof bodyArgs.entityId).toBe("string");
    expect(input.id).toBe(bodyArgs.entityId);
    expect(input.documentId).toBe("doc-99");
    // The body never leaks into properties on the document path.
    expect(input.properties).toEqual({ status: "final" });

    expect(result).toMatchObject({
      status: "created",
      entityId: bodyArgs.entityId,
      documentId: "doc-99",
    });
  });

  it("(c) short body — inline branch: properties.content set, NO document linked", async () => {
    mocks.selectRows = [[{ userType: "human" }]];
    mocks.setBody.mockResolvedValue({ inlineContent: "short note" });

    const result = await runEntityCreate({
      profileSlug: "note",
      title: "Short",
      properties: { status: "draft" },
      body: "short note",
    });

    const input = mocks.materializeEntity.mock.calls[0][0];
    expect(input.properties).toEqual({
      status: "draft",
      content: "short note",
    });
    expect(input).not.toHaveProperty("documentId");
    expect(result).not.toHaveProperty("documentId");
    expect(result).toMatchObject({ status: "created" });
  });

  it("(d) PROPOSED — body is not materialized; it rides the proposal as `content`", async () => {
    mocks.gate.mockResolvedValue({ proposed: true, proposalId: "prop-7" });

    const result = await runEntityCreate({
      profileSlug: "report",
      title: "AI Report",
      body: LONG_BODY,
    });

    expect(mocks.setBody).not.toHaveBeenCalled();
    expect(mocks.materializeEntity).not.toHaveBeenCalled();
    expect(mocks.gate.mock.calls[0][0].data).toMatchObject({
      profileSlug: "report",
      title: "AI Report",
      content: LONG_BODY,
    });
    expect(result).toEqual({
      status: "proposed",
      proposalId: "prop-7",
      bodyDeferred: true,
    });
  });

  it("(d2) PROPOSED without a body — gate data carries no `content` key and no bodyDeferred flag", async () => {
    mocks.gate.mockResolvedValue({ proposed: true, proposalId: "prop-8" });

    const result = await runEntityCreate({ profileSlug: "report", title: "T" });

    expect(mocks.gate.mock.calls[0][0].data).not.toHaveProperty("content");
    expect(result).toEqual({ status: "proposed", proposalId: "prop-8" });
  });

  it("(e) dedupeBy duplicate — skips BEFORE the gate, so no document is created", async () => {
    // dedupe lookup finds an existing entity
    mocks.selectRows = [[{ id: "existing-1" }]];

    const result = await runEntityCreate({
      profileSlug: "report",
      title: "AI Report",
      properties: { url: "https://x.test/a" },
      dedupeBy: "url",
      body: LONG_BODY,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "duplicate" });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.setBody).not.toHaveBeenCalled();
    expect(mocks.materializeEntity).not.toHaveBeenCalled();
  });
});
