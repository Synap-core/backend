/**
 * `synap_update_session({moveToWorkspaceId})` — the session space move (D12)
 * REACHES `updateFocusSession` as its `workspaceId`, and the URL lens's
 * injected `workspaceId` NEVER does.
 *
 * Why a distinct arg: `routers/mcp/index.ts` injects the `?workspaceId=` lens
 * into EVERY tool call's args. Forwarding `args.workspaceId` would file a
 * "move to <lens>" proposal on every update of a session living elsewhere.
 * The service is the only thing replaced; the move's floor and its
 * always-propose rule live there and have their own suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const captured = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/update-session.js")
    >();
  return {
    ...actual,
    updateFocusSession: async (params: Record<string, unknown>) => {
      captured.calls.push(params);
      return { status: "updated", session: { id: params.sessionId } };
    },
  };
});

const { sessionHandlers } = await import("../handlers/session.js");

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const LENS_WS = "66666666-6666-4666-8666-666666666666";
const TARGET_WS = "77777777-7777-4777-8777-777777777777";

const run = (args: Record<string, unknown>) =>
  sessionHandlers.synap_update_session!({
    toolName: "synap_update_session",
    args: { sessionId: SESSION_ID, ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.write", "mcp.read"],
    workspaceAccessible: false,
    caller: {} as never,
    lensCaller: {} as never,
  } as never);

const lastCall = () => captured.calls.at(-1)!;

beforeEach(() => {
  captured.calls.length = 0;
});

describe("synap_update_session — moveToWorkspaceId", () => {
  it("is advertised (nullable) in the manifest, and workspaceId is not the move", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../tools/mcp-tools.manifest.json"),
        "utf8"
      )
    ) as { tools: Array<{ name: string; inputSchema: any }> };
    const tool = manifest.tools.find((t) => t.name === "synap_update_session");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.moveToWorkspaceId.type).toEqual([
      "string",
      "null",
    ]);
  });

  it("a space id REACHES the service as workspaceId", async () => {
    await run({ moveToWorkspaceId: TARGET_WS });
    expect(lastCall()).toHaveProperty("workspaceId", TARGET_WS);
  });

  it("null REACHES the service as null (make it personal)", async () => {
    await run({ moveToWorkspaceId: null });
    expect(lastCall()).toHaveProperty("workspaceId", null);
  });

  it("the lens-injected workspaceId alone moves nothing", async () => {
    await run({ workspaceId: LENS_WS, goal: "Ship it" });
    expect(lastCall()).not.toHaveProperty("workspaceId");
  });
});
