import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap_organize_library` — the MCP twin of tRPC `library.propose` and Hub
 * `POST /library/propose`: same schema, same governed door, same per-person
 * rate limit (`LIBRARY_READER_DOOR_LIMITS.propose`, one bucket for all three).
 *
 * Driven through the real handler. Stubbed at module seams only: the propose
 * door itself (`proposeLibraryOrganize`, pinned on a real Postgres in
 * `library.pglite.test.ts`); the schema is the real one.
 *
 * NOT covered: the Hub and tRPC doors (`library.agent-refused.test.ts`,
 * `library.agent-door.test.ts`).
 */

const h = vi.hoisted(() => ({
  proposed: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/library/organize.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/library/organize.js")
    >();
  return {
    ...actual,
    proposeLibraryOrganize: vi.fn(async (args: Record<string, unknown>) => {
      h.proposed.push(args);
      return { status: "proposed", proposalId: "p-1" };
    }),
  };
});

const { captureHandlers } = await import("./capture.js");
const { LIBRARY_READER_DOOR_LIMITS } =
  await import("../../../services/library/door-limits.js");

const GROUP = "11111111-1111-4111-8111-111111111111";
let user = 0;

function ctx(args: Record<string, unknown>, userId: string) {
  return {
    toolName: "synap_organize_library",
    args,
    userId,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
    keyType: "agent",
    caller: {},
    lensCaller: {},
  } as never;
}

const call = (args: Record<string, unknown>, userId: string) =>
  captureHandlers.synap_organize_library!(ctx(args, userId));

beforeEach(() => {
  h.proposed.length = 0;
  user++;
});

describe("synap_organize_library — parity with library.propose", () => {
  it("bad ops are a TOOL ERROR (isError), never an ok result; nothing is filed", async () => {
    const res = await call({ ops: [{ op: "group.drop" }] }, `u-${user}`);
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(
      /ops must be 1-50 of/
    );
    expect(h.proposed).toEqual([]);
  });

  it("valid ops reach the governed door with the agent caller", async () => {
    const res = await call(
      { ops: [{ op: "group.build", groupId: GROUP }], reasoning: "ready" },
      `u-${user}`
    );
    expect(res.isError).toBeFalsy();
    expect(h.proposed).toEqual([
      {
        userId: `u-${user}`,
        caller: { agentUserId: "agent-1", keyType: "agent" },
        ops: [{ op: "group.build", groupId: GROUP }],
        reasoning: "ready",
      },
    ]);
  });

  it("the same per-person limit as the Hub / tRPC doors: past it, TOO_MANY_REQUESTS and nothing filed", async () => {
    const max = LIBRARY_READER_DOOR_LIMITS.propose.max;
    const userId = `u-${user}`;
    for (let i = 0; i < max; i++) {
      await call({ ops: [{ op: "group.build", groupId: GROUP }] }, userId);
    }
    expect(h.proposed).toHaveLength(max);
    await expect(
      call({ ops: [{ op: "group.build", groupId: GROUP }] }, userId)
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.proposed).toHaveLength(max);
  });
});
