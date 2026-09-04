/**
 * `synap_create_rule` — the MCP door onto the COMPILED rule path.
 *
 * What these assert, and why each one is worth a test:
 *  - The tool routes through `skillsRouter.createRule` (the same procedure the
 *    browser calls), NOT a second call into `createRuleGoverned`. One authority,
 *    one governance path.
 *  - A REFUSAL reaches the agent verbatim, clause and all. The compiler's whole
 *    value is naming the failing clause; flattening it to "invalid" would make
 *    the refusal unactionable, which is the failure mode this door exists to
 *    avoid.
 *  - `"proposed"` is SUCCESS: it comes back with the review link + the
 *    reinforcement hint every governed write carries (both injected by `ok()`).
 *  - An UNREADABLE sentence never reaches the door — a rule filed with a
 *    sentence nobody could parse would be prose that silently never runs.
 *
 * No database: the tRPC caller is mocked at the module seam, which is exactly
 * the boundary this handler's job ends at.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createRule: vi.fn(),
  callerCtxArgs: [] as unknown[],
}));

vi.mock("../../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({ createRule: h.createRule }),
  },
}));

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async (...args: unknown[]) => {
    h.callerCtxArgs = args;
    return {};
  },
}));

import { ruleHandlers } from "./rule.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";

function ctx(
  args: Record<string, unknown>,
  over: Partial<McpToolContext> = {}
) {
  return {
    toolName: "synap_create_rule",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    sessionId: null,
    ...over,
  } as unknown as McpToolContext;
}

async function call(
  args: Record<string, unknown>,
  over: Partial<McpToolContext> = {}
): Promise<Record<string, unknown>> {
  const handler = ruleHandlers.synap_create_rule;
  if (!handler) throw new Error("synap_create_rule is not registered");
  const res = await handler(ctx(args, over));
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

/** The minimum sentence shape the wire schema accepts. */
const VALID_SENTENCE = {
  trigger: {
    triggerType: "event",
    subjectCategory: "entity",
    profileSlug: "deal",
    actionVerb: "created",
  },
  conditions: [],
  actions: [{ type: "notify", config: { message: "new deal" } }],
};

beforeEach(() => {
  h.createRule.mockReset();
  h.callerCtxArgs = [];
});

describe("synap_create_rule routes through the one governed door", () => {
  it("calls skillsRouter.createRule — not a second createRuleGoverned call site", async () => {
    h.createRule.mockResolvedValue({
      status: "created",
      ruleId: "rule-1",
      automationIds: [],
    });
    await call({ intent: "Acme prefers async" });
    expect(h.createRule).toHaveBeenCalledTimes(1);
  });

  it("threads the acting AGENT identity into the caller context (that is what makes an agent write propose)", async () => {
    h.createRule.mockResolvedValue({ status: "proposed", proposalId: "p1" });
    await call({ intent: "always notify me" });
    // createHubProtocolCallerContext(userId, scopes, workspaceId, sourceMsg, sessionId, agentUserId)
    expect(h.callerCtxArgs[0]).toBe(USER);
    expect(h.callerCtxArgs[5]).toBe(AGENT);
  });
});

describe("scope", () => {
  it("defaults to pod when nothing names a workspace", async () => {
    h.createRule.mockResolvedValue({
      status: "created",
      ruleId: "r",
      automationIds: [],
    });
    await call({ intent: "never email on weekends" });
    expect(h.createRule.mock.calls[0][0].scope).toEqual({ kind: "pod" });
  });

  it("uses the ambient MCP lens as the workspace when the caller passed none", async () => {
    h.createRule.mockResolvedValue({
      status: "created",
      ruleId: "r",
      automationIds: [],
    });
    await call({ intent: "tag new deals" }, { lensWorkspaceId: WORKSPACE });
    expect(h.createRule.mock.calls[0][0].scope).toEqual({
      kind: "workspace",
      workspaceId: WORKSPACE,
    });
  });

  it("refuses scope:'workspace' with no workspace rather than picking one", async () => {
    const out = await call({ intent: "x", scope: "workspace" });
    expect(h.createRule).not.toHaveBeenCalled();
    expect(String(out.error)).toContain("needs a workspaceId");
  });
});

describe("refusals reach the agent intact", () => {
  it("forwards the compiler's named clause verbatim", async () => {
    h.createRule.mockResolvedValue({
      status: "denied",
      reason:
        'The WHEN cannot fire: unknown subject type (compiled pattern "notification.created.completed").',
      failure: {
        clause: "WHEN",
        reason: "unknown subject type",
      },
    });
    const out = await call({ intent: "notify me", sentence: VALID_SENTENCE });
    expect(out.status).toBe("denied");
    expect(out.failure).toEqual({
      clause: "WHEN",
      reason: "unknown subject type",
    });
    expect(String(out.reason)).toContain("The WHEN cannot fire");
  });

  it("never files a rule whose sentence could not be read, and says which field is wrong", async () => {
    const out = await call({
      intent: "notify me",
      sentence: {
        trigger: { triggerType: "event" },
        conditions: [],
        actions: [{ type: "send_email", config: {} }],
      },
    });
    expect(h.createRule).not.toHaveBeenCalled();
    expect(out.status).toBe("denied");
    const issues = out.invalidSentence as { path: string }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes("actions"))).toBe(true);
    // A wire-shape error is NOT dressed up as a clause failure — that would
    // point the author at the wrong row of their sentence.
    expect(out.failure).toBeUndefined();
  });

  it("rejects a non-instant expiresAt before it costs a proposal", async () => {
    const out = await call({ intent: "x", expiresAt: "next friday" });
    expect(h.createRule).not.toHaveBeenCalled();
    expect(String(out.error)).toContain("expiresAt");
  });
});

describe("'proposed' is success", () => {
  it("carries the review link and the reinforcement hint", async () => {
    h.createRule.mockResolvedValue({
      status: "proposed",
      proposalId: "44444444-4444-4444-8444-444444444444",
    });
    const out = await call({ intent: "always cc legal", scope: "pod" });
    expect(out.status).toBe("proposed");
    expect(typeof out.link).toBe("string");
    expect(String(out.link)).toContain("44444444-4444-4444-8444-444444444444");
    expect(String(out.hint)).toContain("link");
  });

  it("passes the non-fatal needsBehaviour signal through to the agent", async () => {
    h.createRule.mockResolvedValue({
      status: "created",
      ruleId: "r",
      automationIds: [],
      needsBehaviour: { shape: "notify", reason: "stored as prose" },
    });
    const out = await call({ intent: "ping me when a deal closes" });
    expect(out.needsBehaviour).toEqual({
      shape: "notify",
      reason: "stored as prose",
    });
  });
});

describe("a valid sentence is forwarded to the compiler", () => {
  it("passes the parsed sentence through unchanged", async () => {
    h.createRule.mockResolvedValue({
      status: "proposed",
      proposalId: "p2",
    });
    await call({ intent: "notify on new deals", sentence: VALID_SENTENCE });
    expect(h.createRule.mock.calls[0][0].sentence).toEqual(VALID_SENTENCE);
  });

  it("omits `sentence` entirely for a prose-only fact rule", async () => {
    h.createRule.mockResolvedValue({
      status: "created",
      ruleId: "r",
      automationIds: [],
    });
    await call({ intent: "Acme prefers async" });
    expect("sentence" in h.createRule.mock.calls[0][0]).toBe(false);
  });
});
