/**
 * THE playbook-method renderer — one text for both doors that bind a
 * playbook: the IS executor's kickoff and the MCP binding replies
 * (`synap_start_session { templateId }`, `synap_update_session
 * { followPlaybookId }`).
 *
 * The executor half is driven through the REAL executor (DB, channel insert
 * and IS trigger faked at their module seams), so a kickoff that stopped
 * going through the renderer, or a renderer that changed the kickoff's
 * format, reads red here.
 */
import { describe, it, expect, vi } from "vitest";
import type { PlaybookStage } from "@synap/playbooks";

const insertChannelMessage = vi.fn(async (_args: { content: string }) => ({
  messageId: "msg-1",
}));

const CONTEXT_SKILL = "Read the brief first. Never ship on Friday.";
// The context-skill lookup answers one approved instruction skill.
const db = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [{ body: CONTEXT_SKILL }] }),
        }),
      }),
    }),
  }),
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => db,
    insertChannelMessage: (args: { content: string }) =>
      insertChannelMessage(args),
  };
});
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock("../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
}));
vi.mock("../agent-identity-service.js", () => ({
  resolveActiveAgentBySlug: async () => null,
}));

const { renderPlaybookMethod, buildStageSection, PLAYBOOK_HOW_TO_HEADING } =
  await import("./playbook-method.js");
const { IsAgentExecutor } = await import("./executors/is-agent-executor.js");

const STAGE = {
  key: "draft",
  name: "Draft",
  goal: "Write the first version.",
  expectedOutputs: [{ kind: "document", label: "Draft document" }],
  suggestedTasks: ["Outline", "Write"],
  lessons: ["Keep it under a page."],
} as unknown as PlaybookStage;

describe("renderPlaybookMethod", () => {
  it("renders the context skill, then the current stage with its goal, outputs, tasks and lessons", () => {
    const text = renderPlaybookMethod({
      contextSkill: CONTEXT_SKILL,
      stage: STAGE,
    });
    expect(text).toBe(
      [
        `${PLAYBOOK_HOW_TO_HEADING}\n${CONTEXT_SKILL}`,
        buildStageSection(STAGE),
      ].join("\n\n")
    );
    expect(text).toContain("## Current stage: Draft");
    expect(text).toContain("Write the first version.");
    expect(text).toContain("Expected outputs: Draft document");
    expect(text).toContain("Suggested tasks: Outline, Write");
    expect(text).toContain("- Keep it under a page.");
  });

  it("omits what the playbook does not declare: no skill, no stage ⇒ empty", () => {
    expect(renderPlaybookMethod({ contextSkill: null, stage: null })).toBe("");
    expect(renderPlaybookMethod({ contextSkill: "  ", stage: STAGE })).toBe(
      buildStageSection(STAGE)
    );
  });
});

describe("the IS executor renders its kickoff through the same renderer", () => {
  it("kickoff = context skill + goal + current stage, the pre-refactor format", async () => {
    insertChannelMessage.mockClear();
    const result = await new IsAgentExecutor().run({
      workspaceId: "ws-1",
      userId: "user-1",
      sessionId: "sess-1",
      channelId: "chan-1",
      goal: "do the thing",
      capabilities: [],
      playbookId: "pb-1",
      currentStage: "draft",
      stages: [STAGE],
    } as never);
    expect(result.status).toBe("running");
    const sent = insertChannelMessage.mock.calls[0]![0].content;
    // The exact bytes the executor posted before the renderer was shared.
    expect(sent).toBe(
      `${PLAYBOOK_HOW_TO_HEADING}\n${CONTEXT_SKILL}\n\ndo the thing\n\n${buildStageSection(STAGE)}`
    );
    expect(sent).toBe(
      renderPlaybookMethod({
        contextSkill: CONTEXT_SKILL,
        body: "do the thing",
        stage: STAGE,
      })
    );
  });
});
