/**
 * `synap_run_playbook` is an old name of `synap_start_session` with
 * `launch: true` (review B2 F5), through the REAL dispatch path:
 * `tools.execute` (the uuid door, the alias's argument mapping and the parse
 * against start_session's zod input, the error door) → the REAL handler map
 * (`mcpToolHandler`, which resolves the alias) → start_session's handler →
 * its launch branch. Only the edges are stubbed: the adapter's setup (it
 * hands the handler a minimal context) and the shared run door
 * `runPlaybookDoor` (Hub REST's too), which records what it was asked.
 *
 * Negative controls: drop `fixedArgs` from the alias (1 goes red: the call
 * is refused "goal is required", the run door never asked); map `subjectId`
 * to `subjectId` instead of `subjectEntityId` (the registry throws: start
 * session does not take it); remove the launch branch from start_session's
 * handler (1 goes red: createFocusSession is reached).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  starts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../hub-protocol/playbook-doors.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/playbook-doors.js")
  >()),
  runPlaybookDoor: vi.fn(async (_identity: unknown, input: never) => {
    h.runs.push(input);
    return { kind: "result", result: { status: "draft", run: null } };
  }),
}));
vi.mock(
  "../../../services/focus-sessions/create-session.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/focus-sessions/create-session.js")
    >()),
    createFocusSession: vi.fn(async (input: Record<string, unknown>) => {
      h.starts.push(input);
      throw new Error("a launch must never open a working session");
    }),
  })
);
vi.mock("../adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapter.js")>();
  return {
    ...actual,
    // The adapter's setup needs the DB; the handler it picks does not here.
    executeMCPToolViaHubProtocol: vi.fn(
      async (
        toolName: string,
        args: Record<string, unknown>,
        userId: string,
        apiKeyScopes: string[],
        _sessionUserId?: string,
        agentUserId?: string
      ) =>
        actual.mcpToolHandler(toolName)!({
          toolName,
          args,
          userId,
          apiKeyScopes,
          agentUserId,
          requestedWorkspaceId: args.workspaceId as string | undefined,
          caller: {} as never,
          lensCaller: {} as never,
          workspaceAccessible: true,
        })
    ),
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { tools } from "../tools/index.js";
import { runWithCallNotices } from "../call-notices.js";

const PB = "44444444-4444-4444-8444-444444444444";
const SUBJECT = "55555555-5555-4555-8555-555555555555";
const WS = "33333333-3333-4333-8333-333333333333";
const AGENT = "22222222-2222-4222-8222-222222222222";

const call = async (name: string, args: Record<string, unknown>) =>
  (
    await runWithCallNotices(() =>
      tools.execute(name, args, "user-1", ["mcp.read", "mcp.write"])
    )
  ).result;

const body = (r: CallToolResult) =>
  JSON.parse((r.content[0] as { type: "text"; text: string }).text) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  h.runs.length = 0;
  h.starts.length = 0;
});

describe("synap_run_playbook answers as synap_start_session launch: true", () => {
  it("1. the old argument shape reaches the shared run door, mapped", async () => {
    const result = await call("synap_run_playbook", {
      playbookId: PB,
      subjectId: SUBJECT,
      workspaceId: WS,
      params: { market: "EU fintech" },
      runner: { agentId: AGENT },
      stageRunners: { review: "self" },
      handToAgentId: ` ${AGENT} `,
      startAnother: true,
      reasoning: "the person asked",
    });
    expect(result.isError).toBeFalsy();
    expect(body(result)).toMatchObject({ status: "draft" });
    expect(h.starts).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      playbookId: PB,
      subjectId: SUBJECT,
      workspaceId: WS,
      params: { market: "EU fintech" },
      runner: { agentId: AGENT },
      stageRunners: { review: "self" },
      handToAgentId: AGENT,
      startAnother: true,
      reasoning: "the person asked",
      source: "mcp",
    });
  });

  it("2. a playbook named by `name` (the old alias of playbookName) is resolved by the door", async () => {
    await call("synap_run_playbook", { name: "Weekly review" });
    expect(h.runs[0]).toMatchObject({ playbookName: "Weekly review" });
    expect(h.runs[0]!.playbookId).toBeUndefined();
  });

  it("3. start_session's own names are not the old name's inputs", async () => {
    const result = await call("synap_run_playbook", {
      templateId: PB,
      goal: "x",
    });
    expect(result.isError).toBe(true);
    expect(h.runs).toEqual([]);
  });

  it("4. synap_start_session launch: true is the same launch; without it the launch inputs are refused", async () => {
    await call("synap_start_session", {
      launch: true,
      templateId: PB,
      subjectEntityId: SUBJECT,
    });
    expect(h.runs[0]).toMatchObject({ playbookId: PB, subjectId: SUBJECT });

    const refused = await call("synap_start_session", {
      goal: "Review the week",
      templateId: PB,
      runner: { agentId: AGENT },
    });
    expect(body(refused).error).toMatch(/`runner` only with launch: true/);
    expect(h.runs).toHaveLength(1);
    expect(h.starts).toEqual([]);
  });

  it("5. a launch takes only the playbook inputs: a start's own are refused, nothing run", async () => {
    const result = await call("synap_start_session", {
      launch: true,
      templateId: PB,
      goal: "My own goal",
      criteria: [{ key: "k", statement: "s" }],
    });
    expect(body(result).error).toMatch(/does not take `goal`, `criteria`/);
    expect(h.runs).toEqual([]);
  });
});
