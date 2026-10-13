/**
 * `synap_create_playbook` — the caller's focus session reaches the gate.
 *
 * The defect this pins (ticket 2e296a58, #15 remainder): `playbooks.create`
 * built its gate options without `sessionId`, so a playbook an agent created
 * inside a session — or the proposal for it — was filed under no session even
 * though the MCP door had already resolved one and put it on the caller ctx.
 *
 * SEAM: the REAL MCP handler → the REAL `createPlaybookDoor` → the REAL hub
 * caller context → the REAL `playbooks.create` → the gate. Only the gate, the
 * row store and infrastructure middlewares are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000c1";

const h = vi.hoisted(() => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.orderBy = () => selectChain;
  selectChain.limit = async () => [];
  selectChain.then = (resolve: (v: unknown) => unknown) => resolve([]);
  const db = {
    select: () => selectChain,
    insert: () => {
      throw new Error("no insert expected on the propose path");
    },
    query: {
      workspaceMembers: { findFirst: async () => ({ role: "editor" }) },
      workspaces: { findFirst: async () => ({ archivedAt: null }) },
    },
  };
  return { db, permCalls: [] as Array<Record<string, unknown>> };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  }),
  invalidateSyncGenerationCache: () => undefined,
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  previewPermissionDecision: async () => ({ decision: "propose" }),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return {
      granted: false,
      proposalId: "prop-1",
      proposalType: "playbook.create",
      summary: "Create playbook",
      reasoning: "needs review",
      reviewPath: "/open/prop-1",
      reviewUrl: "https://pod/open/prop-1",
    };
  },
}));
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkspaceRole: async () => "owner",
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { buildHandlers } from "./mcp/handlers/build.js";
import type { McpToolContext } from "./mcp/handlers/shared.js";

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("synap_create_playbook — sessionId reaches the gate", () => {
  it("the session the MCP door resolved is handed to playbooks.create's gate", async () => {
    const res = await buildHandlers.synap_create_playbook!({
      toolName: "synap_create_playbook",
      args: { name: "Qualify a lead", goalTemplate: "Qualify it" },
      userId: "user-1",
      apiKeyScopes: ["mcp.read", "mcp.write"],
      agentUserId: AGENT,
      sessionId: SESSION,
      requestedWorkspaceId: WORKSPACE,
      workspaceAccessible: true,
    } as unknown as McpToolContext);

    expect(JSON.stringify(res)).toContain("prop-1");
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "playbook",
      action: "create",
      agentUserId: AGENT,
      sessionId: SESSION,
    });
  });
});
