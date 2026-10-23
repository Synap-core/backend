/**
 * `synap_update_rule` — the MCP door onto the governed rule EDIT.
 *
 * Before it, an MCP agent could create a rule but not propose a correction to
 * one it had written. What these pin:
 *  - The tool routes through `skillsRouter.updateRule` — the procedure the app
 *    calls — never a second `updateRuleGoverned` call site.
 *  - The acting AGENT rides the caller context (that is what makes the edit
 *    PROPOSE), and `"proposed"` comes back as success with the review link.
 *  - FULL SHAPE: `scope` is required (a defaulted scope would silently move a
 *    workspace rule pod-wide), and the three states of `expiresAt` / `sentence`
 *    survive the hop: absent is not sent, `null` is sent as `null`.
 *  - A rule the caller cannot see is a plain `not_found` that says where ids
 *    come from — not a crash.
 *  - Registered where `synap_create_rule` is: advertised, in the same profile
 *    group, with teaching keys and a capability brief under the `rule/update`
 *    door.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  createRule: vi.fn(),
  updateRule: vi.fn(),
  callerCtxArgs: [] as unknown[],
}));

vi.mock("../../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      createRule: h.createRule,
      updateRule: h.updateRule,
    }),
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
import { tools } from "../tools/index.js";
import { TOOL_GROUPS } from "../tool-profiles.js";
import { MCP_TOOL_TEACHING_KEYS } from "../tool-verb-aliases.js";
import { DOOR_TOOL_NAMES } from "../door-tool-names.generated.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const RULE_ID = "44444444-4444-4444-8444-444444444444";

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

async function call(
  args: Record<string, unknown>,
  over: Partial<McpToolContext> = {}
): Promise<Record<string, unknown>> {
  const handler = ruleHandlers.synap_update_rule;
  if (!handler) throw new Error("synap_update_rule is not registered");
  const res = await handler({
    toolName: "synap_update_rule",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    sessionId: null,
    ...over,
  } as unknown as McpToolContext);
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

const EDIT = {
  ruleId: RULE_ID,
  intent: "Notify the founder when a deal is created",
  scope: "pod",
};

beforeEach(() => {
  h.updateRule.mockReset();
  h.createRule.mockReset();
  h.callerCtxArgs = [];
});

describe("synap_update_rule routes through the one governed edit door", () => {
  it("calls skillsRouter.updateRule with the rule id and the full shape", async () => {
    h.updateRule.mockResolvedValue({ status: "proposed", proposalId: "p1" });
    await call(EDIT);
    expect(h.updateRule).toHaveBeenCalledTimes(1);
    expect(h.updateRule.mock.calls[0][0]).toEqual({
      id: RULE_ID,
      intent: EDIT.intent,
      scope: { kind: "pod" },
      automationIds: [],
    });
  });

  it("threads the acting AGENT into the caller context, so the edit proposes", async () => {
    h.updateRule.mockResolvedValue({ status: "proposed", proposalId: "p1" });
    await call(EDIT);
    expect(h.callerCtxArgs[0]).toBe(USER);
    expect(h.callerCtxArgs[5]).toBe(AGENT);
  });

  it("'proposed' is success: it carries the review link", async () => {
    h.updateRule.mockResolvedValue({
      status: "proposed",
      proposalId: "55555555-5555-4555-8555-555555555555",
    });
    const out = await call(EDIT);
    expect(out.status).toBe("proposed");
    expect(String(out.link)).toContain("55555555-5555-4555-8555-555555555555");
  });
});

describe("full shape and the three states", () => {
  it("requires scope — a defaulted scope would silently move the rule", async () => {
    const out = await call({ ruleId: RULE_ID, intent: "x" });
    expect(h.updateRule).not.toHaveBeenCalled();
    expect(String(out.error)).toContain("scope");
  });

  it("forwards null as CLEAR for expiresAt and sentence", async () => {
    h.updateRule.mockResolvedValue({ status: "proposed", proposalId: "p" });
    await call({ ...EDIT, expiresAt: null, sentence: null });
    const input = h.updateRule.mock.calls[0][0];
    expect(input.expiresAt).toBeNull();
    expect(input.sentence).toBeNull();
  });

  it("forwards a new sentence, review date and draft flag", async () => {
    h.updateRule.mockResolvedValue({ status: "proposed", proposalId: "p" });
    await call({
      ...EDIT,
      sentence: VALID_SENTENCE,
      expiresAt: "2027-01-31T00:00:00Z",
      draft: true,
    });
    expect(h.updateRule.mock.calls[0][0]).toMatchObject({
      sentence: VALID_SENTENCE,
      expiresAt: "2027-01-31T00:00:00Z",
      draft: true,
    });
  });

  it("uses the ambient lens for a workspace-scoped edit and as the visibility lens", async () => {
    h.updateRule.mockResolvedValue({ status: "proposed", proposalId: "p" });
    await call({ ...EDIT, scope: "workspace" }, { lensWorkspaceId: WORKSPACE });
    expect(h.updateRule.mock.calls[0][0].scope).toEqual({
      kind: "workspace",
      workspaceId: WORKSPACE,
    });
    expect(h.callerCtxArgs[2]).toBe(WORKSPACE);
  });

  it("refuses an unreadable sentence naming the field, without calling the door", async () => {
    const out = await call({
      ...EDIT,
      sentence: { trigger: { triggerType: "event" }, conditions: [] },
    });
    expect(h.updateRule).not.toHaveBeenCalled();
    expect(out.status).toBe("denied");
    expect((out.invalidSentence as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("a rule the caller cannot see", () => {
  it("is a not_found that says where rule ids come from", async () => {
    h.updateRule.mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND", message: "Rule not found" })
    );
    const out = await call(EDIT);
    expect(out.status).toBe("not_found");
    expect(String(out.error)).toContain("synap_get_proposal");
  });

  it("rejects a non-uuid ruleId before any read", async () => {
    const out = await call({ ...EDIT, ruleId: "my rule" });
    expect(h.updateRule).not.toHaveBeenCalled();
    expect(String(out.error)).toContain("ruleId");
  });
});

describe("registered wherever synap_create_rule is", () => {
  it("is advertised, with ruleId, intent and scope required", async () => {
    const def = (await tools.list()).find(
      (t) => t.name === "synap_update_rule"
    );
    expect(def).toBeDefined();
    expect(def!.inputSchema.required).toEqual(
      expect.arrayContaining(["ruleId", "intent", "scope"])
    );
    expect(def!.description).toMatch(/proposed.*SUCCESS/);
  });

  it("sits in the same profile group as synap_create_rule", () => {
    expect(TOOL_GROUPS.governance).toContain("synap_create_rule");
    expect(TOOL_GROUPS.governance).toContain("synap_update_rule");
  });

  it("has teaching keys under the rule.update door", () => {
    expect(MCP_TOOL_TEACHING_KEYS.synap_update_rule).toContain("rule.update");
  });

  it("is in the generated door tool-name table", () => {
    expect(DOOR_TOOL_NAMES.synap_update_rule?.["pod-mcp"]).toBe(
      "synap_update_rule"
    );
  });
});
