/**
 * Every `cell/define` proposal is filed with the fingerprint of the content its
 * approval writes (decision Q9, approval per fingerprint).
 *
 * Stamped in the governance gate, the one door every cell-filing door goes
 * through (MCP `synap_create_cell`, Hub `POST /cells/define`, Hub
 * `widgetDefinitions.upsertWidgetDef`), so no door can file a cell proposal
 * without it. Seam: the row handed to `insertPendingProposal`, what the pod
 * persists, driven through the real `checkPermissionOrPropose` with the engine
 * and every write seam mocked as `permission-check.policy-reason-not-stored.test.ts`
 * does. The approve executor refuses a payload that does not match its stamp
 * (`executors/cell.fingerprint.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGov, mockVerifyPermission, mockInsertPendingProposal, mockValues } =
  vi.hoisted(() => ({
    mockGov: vi.fn(),
    mockVerifyPermission: vi.fn(),
    mockInsertPendingProposal: vi.fn(),
    mockValues: vi.fn(),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  mockValues.mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
  });
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  const select = () => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      leftJoin: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue([]),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  };
  return {
    ...actual,
    db: {
      insert: vi.fn(() => ({ values: mockValues })),
      select,
      transaction: async (cb: (tx: unknown) => unknown) =>
        cb({ insert: vi.fn(() => ({ values: mockValues })) }),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(async () => null),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    verifyPermission: mockVerifyPermission,
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: mockGov,
  resolveGovernanceRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(),
}));
vi.mock("../lib/event-helpers.js", () => ({
  logEvent: vi.fn().mockResolvedValue("event-1"),
}));

import { checkPermissionOrPropose } from "./permission-check.js";
import {
  CELL_CONTENT_FINGERPRINT_KEY,
  cellContentFingerprint,
} from "../services/cells/cell-content-fingerprint.js";

const SOURCE = "export default function Cell() { return null; }";

const agentWrite = (
  subjectType: "cell" | "view",
  action: "define" | "create",
  data: Record<string, unknown>
) => ({
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType,
  action,
  source: "intelligence" as const,
  data,
});

/** The payload `createProposal` handed the ONE pending-proposal insert. */
const storedPayload = () =>
  (
    mockInsertPendingProposal.mock.calls.at(-1)?.[0] as
      { data: { data: Record<string, unknown> } } | undefined
  )?.data.data;

describe("the gate files a cell proposal with its content fingerprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "propose",
      reason: "An agent defines a cell.",
      reasonCode: "AGENT_STRUCTURE_WRITE",
    });
  });

  it("a cell/define proposal carries the fingerprint of what its approval writes", async () => {
    await checkPermissionOrPropose(
      agentWrite("cell", "define", { name: "My Cell", rendererSource: SOURCE })
    );
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(storedPayload()?.[CELL_CONTENT_FINGERPRINT_KEY]).toBe(
      cellContentFingerprint({
        rendererType: "frame",
        rendererSource: SOURCE,
      })
    );
  });

  it("a stamp the caller sent is replaced by the derived one", async () => {
    await checkPermissionOrPropose(
      agentWrite("cell", "define", {
        name: "My Cell",
        rendererSource: SOURCE,
        [CELL_CONTENT_FINGERPRINT_KEY]: "0".repeat(64),
      })
    );
    expect(storedPayload()?.[CELL_CONTENT_FINGERPRINT_KEY]).not.toBe(
      "0".repeat(64)
    );
  });

  it("another kind of proposal carries none", async () => {
    await checkPermissionOrPropose(
      agentWrite("view", "create", { name: "A view", rendererSource: SOURCE })
    );
    expect(storedPayload()).not.toHaveProperty(CELL_CONTENT_FINGERPRINT_KEY);
  });
});
