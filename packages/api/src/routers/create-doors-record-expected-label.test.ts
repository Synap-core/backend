/**
 * The HUMAN create doors claim a declared session slot.
 *
 * `expectedLabel` reached only the Hub/MCP create doors: an agent creating a
 * document or a view inside a session could say WHICH deliverable it was for,
 * and a person doing the same thing could not. Worse, the two tRPC doors
 * recorded no session artifact at all — a document written by the person the
 * session belongs to produced an object the session's own outputs board could
 * not join to the slot that asked for it.
 *
 * These pin the wiring end to end: the input reaches the ONE writer
 * (`recordSessionArtifact`) with the label, and it is gated on the VERIFIED
 * `ctx.sessionId` header handle so a call outside a session writes no ledger
 * row at all.
 *
 * The writer itself is a spy — it has its own tests and its own tripwire; what
 * was missing here was the CALL, so that is what is asserted.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced), as are storage and the view repository.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const VIEW = "55555555-5555-4555-8555-555555555555";

const recordSessionArtifact = vi.fn(
  async (_params: Record<string, unknown>) => undefined
);
vi.mock(
  "../services/focus-sessions/record-session-artifact.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      recordSessionArtifact: (...a: unknown[]) =>
        (recordSessionArtifact as unknown as (...x: unknown[]) => unknown)(
          ...a
        ),
    };
  }
);

const createdView = { id: VIEW, name: "Pipeline board" };

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const insertChain = () => {
    const chain: Record<string, unknown> = {
      values: () => chain,
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      returning: async () => [{ id: "doc-1", title: "The spec" }],
      then: (resolve: (v: unknown) => void) => resolve([]),
    };
    return chain;
  };
  const db = {
    insert: insertChain,
    transaction: async (cb: (t: unknown) => unknown) =>
      cb({ insert: insertChain }),
    query: new Proxy({} as Record<string, unknown>, {
      get: () => ({ findFirst: async () => undefined }),
    }),
  };
  return {
    ...actual,
    db,
    getDb: async () => db,
    // The view write itself is not what these pin — the ledger call after it is.
    ViewRepository: class {
      create = async () => createdView;
    },
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: () => "path/doc.md",
    upload: async () => ({ url: "u", path: "path/doc.md", size: 3 }),
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(),
  getBoss: vi.fn(),
}));

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("../utils/workspace-placement.js", () => ({
  resolveWorkspacePlacement: vi.fn(async () => ({ workspaceId: WS })),
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));

const { documentsRouter } = await import("./documents.js");
const { viewsRouter } = await import("./views.js");

const ctx = (sessionId?: string) =>
  ({
    userId: "user-1",
    authenticated: true,
    workspaceId: null,
    sessionId,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("documents.create — the human door can claim a declared slot", () => {
  it("records the artifact against the session, carrying the label", async () => {
    await documentsRouter
      .createCaller(ctx(SESSION))
      .create({ title: "The spec", expectedLabel: "Spec" });

    expect(recordSessionArtifact).toHaveBeenCalledTimes(1);
    expect(recordSessionArtifact.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      kind: "document",
      refId: "doc-1",
      expectedLabel: "Spec",
      userId: "user-1",
    });
  });

  it("records without a label when none is claimed — a claim is never invented", async () => {
    await documentsRouter
      .createCaller(ctx(SESSION))
      .create({ title: "The spec" });

    expect(recordSessionArtifact.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      expectedLabel: undefined,
    });
  });

  it("passes NO session when the request carries none", async () => {
    await documentsRouter.createCaller(ctx()).create({ title: "The spec" });
    // The recorder no-ops on a null session; what matters is that the door
    // never substitutes one of its own.
    expect(recordSessionArtifact.mock.calls[0]![0]).toMatchObject({
      sessionId: undefined,
    });
  });
});

describe("views.create — the human door can claim a declared slot", () => {
  it("records the artifact against the session, carrying the label", async () => {
    await viewsRouter.createCaller(ctx(SESSION)).create({
      name: "Pipeline board",
      type: "table",
      scopeProfileIds: ["44444444-4444-4444-8444-444444444444"],
      expectedLabel: "Pipeline board",
    });

    expect(recordSessionArtifact).toHaveBeenCalledTimes(1);
    expect(recordSessionArtifact.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      kind: "view",
      refId: VIEW,
      title: "Pipeline board",
      expectedLabel: "Pipeline board",
    });
  });

  it("passes NO session when the request carries none", async () => {
    await viewsRouter.createCaller(ctx()).create({
      name: "Pipeline board",
      type: "table",
      scopeProfileIds: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(recordSessionArtifact.mock.calls[0]![0]).toMatchObject({
      sessionId: undefined,
      expectedLabel: undefined,
    });
  });
});
