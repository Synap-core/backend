/**
 * A provider call that governance turns into a proposal never stores a
 * credential in the proposal row (S4): `data.body` is READ by reviewers and
 * agents (`proposals.get`, Hub `view=full`, MCP `detail:"full"`). The
 * claude-managed-agents start verb's session create carries each repo mount's
 * `authorization_token` — exactly the shape driven here.
 *
 * And because the secret was never stored, the approved replay REFUSES a body
 * that still carries the redaction marker instead of sending it as the
 * credential.
 *
 * Harness: the not-enabled suite's (db / gate / proposal-insert stubs), with the
 * gate answering `propose`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const TOOL_ROW = {
  id: "tool-send",
  name: "gmail_send",
  approved: false,
  createdBy: "owner-1",
  credentialRef: "nango://gmail",
  authBinding: "static",
  workspaceId: null,
};
let toolRows: unknown[] = [TOOL_ROW];
let seededMessaging: unknown[] = [];
const inserted: any[] = [];
const sendMessage = vi.fn(async () => undefined);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        channels: {
          findFirst: async () => ({ id: "ch-1", externalSource: "unipile" }),
        },
      },
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: () => {
            // gateMessagingSend selects {id, approved, createdBy} — no name.
            const isMessagingSeed =
              table === (actual as any).tools &&
              cols &&
              !("name" in cols) &&
              "createdBy" in cols;
            const rows =
              table === (actual as any).tools
                ? isMessagingSeed
                  ? seededMessaging
                  : cols
                    ? [{ id: "tool-send", name: "gmail_send" }]
                    : toolRows
                : [];
            return {
              limit: async () => rows,
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({ sendMessage }),
}));

vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({ decision: "propose" }),
}));

vi.mock("../services/capabilities/capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async () => new Map(),
}));
vi.mock("../services/links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityMemberParts: async () => [],
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: any) => {
    inserted.push(input);
    return { id: `prop-${inserted.length}` };
  },
}));

const { triggerProviderAction } = await import("./external-dispatch.js");
const { REDACTED_SECRET_VALUE, redactSecretKeys } =
  await import("../utils/redact-secrets.js");

const SESSION_CREATE = {
  agent: "agent_1",
  title: "Synap: Settings page",
  metadata: { synap_session_id: "s-1", idempotencyKey: "keep-me" },
  initial_events: [
    { type: "user.message", content: [{ type: "text", text: "go" }] },
  ],
  resources: [
    {
      type: "github_repository",
      url: "https://github.com/synap/app",
      authorization_token: "ghp_realTokenValue1234567890",
      checkout: { type: "branch", name: "synap/abc" },
    },
  ],
  apiKey: "sk-live-should-not-land",
  client_secret: "s3cr3t",
  vaultRef: { token: "vault://abc" },
};

describe("triggerProviderAction — a proposed provider call stores no credential", () => {
  beforeEach(() => {
    inserted.length = 0;
    toolRows = [{ ...TOOL_ROW, approved: true }];
  });

  it("the proposal's data.body has every secret-bearing value redacted, and nothing else", async () => {
    const out = await triggerProviderAction({
      userId: "owner-1",
      agentUserId: "agent-1",
      provider: "nango://gmail",
      method: "POST",
      path: "/v1/sessions",
      body: SESSION_CREATE,
      workspaceId: "ws-1",
    });
    expect(out.proposed).toBe(true);
    expect(inserted).toHaveLength(1);
    const body = inserted[0].data.body;
    expect(JSON.stringify(body)).not.toContain("ghp_realTokenValue");
    expect(JSON.stringify(body)).not.toContain("sk-live-should-not-land");
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
    expect(body.resources[0].authorization_token).toBe(REDACTED_SECRET_VALUE);
    expect(body.apiKey).toBe(REDACTED_SECRET_VALUE);
    // Reviewable: the rest of the call is intact, a vault REF is kept.
    expect(body.resources[0].url).toBe("https://github.com/synap/app");
    expect(body.resources[0].checkout).toEqual({
      type: "branch",
      name: "synap/abc",
    });
    expect(body.metadata.idempotencyKey).toBe("keep-me");
    expect(body.vaultRef.token).toBe("vault://abc");
  });

  it("the approved replay of a redacted body is refused — the marker is never sent as the credential", async () => {
    const out = await triggerProviderAction({
      userId: "owner-1",
      provider: "nango://gmail",
      method: "POST",
      path: "/v1/sessions",
      body: redactSecretKeys(SESSION_CREATE),
      workspaceId: "ws-1",
      alreadyApproved: true,
      sourceProposalId: "prop-1",
    });
    expect(out.success).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/cannot be replayed/);
  });
});
