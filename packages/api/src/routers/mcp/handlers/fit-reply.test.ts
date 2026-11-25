/**
 * Reads a PROGRAM depends on fit under the reply cap instead of coming back
 * cut (finding 69fdd2e6). On 2026-11-09 the founder's Mac worker stalled on
 * `synap_get_thread_context` (one room, 20 messages: 22,886 characters) and on
 * lean `synap_get_session` reads (18,043-19,814 characters): the cap turned
 * each into `{truncated, head}`, which no program can parse.
 *
 *   - `fitReply`: a reply over the budget keeps the head of its largest lists
 *     and the start of its longest strings, stays valid JSON, says what it
 *     left out; a reply within budget is the same object.
 *   - `synap_get_thread_context` through the real handler, `ok()` and the
 *     cap: each message clipped, the oldest left out with a cursor on.
 *   - the lean session header: the fields a worker reads, never the long
 *     columns.
 *
 * Negative control: with the clip and `fitReply` taken out of the thread
 * handler, the room cases come back cut by the cap (red).
 */
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));

import { capReply, REPLY_CAP_CHARS } from "../reply-cap.js";
import { FIT_BUDGET_CHARS, fitReply } from "./fit-reply.js";
import { readHandlers, THREAD_MESSAGE_MAX_CHARS } from "./read.js";
import { ok, untrusted, type McpToolContext } from "./shared.js";
import {
  LEAN_HEADER_TEXT_MAX,
  projectLeanSessionHeader,
} from "../../../services/focus-sessions/session-lean.js";

const text = (r: CallToolResult) => {
  const b = r.content?.[0];
  if (!b || b.type !== "text") throw new Error("expected text");
  return b.text;
};

describe("fitReply", () => {
  it("a reply within budget is the same object, with no notice", () => {
    const data = { a: [1, 2, 3], b: "x" };
    expect(fitReply(data)).toBe(data);
  });

  it("over budget: keeps the head of the largest list, stays valid JSON under the budget, says what it left out", () => {
    const data = {
      id: "s-1",
      items: Array.from({ length: 40 }, (_, i) => ({
        i,
        note: "n".repeat(900),
      })),
      small: [1, 2],
    };
    const out = fitReply(data);
    const json = text(ok(out));
    expect(json.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(
      FIT_BUDGET_CHARS + 400
    );
    expect(out.id).toBe("s-1");
    expect(out.items[0].i).toBe(0);
    expect(out.small).toEqual([1, 2]);
    expect(out.fit?.omitted.items).toBe(40 - out.items.length);
    // The input is never changed.
    expect(data.items).toHaveLength(40);
  });

  it("a long string keeps its start; a fenced (third-party) string stays fenced", () => {
    const out = fitReply({
      mine: "m".repeat(30_000),
      theirs: untrusted("t".repeat(30_000), "a teammate's note"),
    });
    const json = text(ok(out));
    expect(json.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const parsed = JSON.parse(json);
    expect(parsed.mine.endsWith("…")).toBe(true);
    expect(parsed.theirs).toMatch(/untrusted/i);
    expect(parsed.fit.clipped).toEqual(
      expect.arrayContaining(["mine", "theirs"])
    );
  });
});

describe("synap_get_thread_context fits under the cap", () => {
  const AGENT = "agent-1";
  const CALLER = "user-1";
  /** `n` messages, newest first (as `getThreadContext` answers), each `size` characters. */
  const room = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(n - i).padStart(12, "0")}`,
      role: "assistant",
      content: `[tool-install] checkpoint ${n - i}: ${"y".repeat(size)}`,
      timestamp: new Date(Date.UTC(2026, 10, 9, 22, 0, n - i)).toISOString(),
      authorType: "agent",
      userId: AGENT,
      routedTeammateId: AGENT,
      routedSource: "session",
      sessionId: null,
    }));
  const read = async (
    messages: ReturnType<typeof room>,
    args: Record<string, unknown> = {}
  ) => {
    const asked: Array<Record<string, unknown>> = [];
    const caller = {
      context: {
        getThreadContext: async (input: Record<string, unknown>) => {
          asked.push(input);
          const limit = typeof input.limit === "number" ? input.limit : 50;
          return {
            thread: { id: "t-1", userId: CALLER },
            contextSummary: null,
            metadata: null,
            messages: messages.slice(0, limit),
            hasMore: messages.length > limit,
            nextCursor: messages.length > limit ? messages[limit - 1].id : null,
            recentEntities: [],
            linkedEntityIds: [],
            linkedDocumentIds: [],
            linkedEntities: [],
            linkedDocuments: [],
          };
        },
      },
    };
    const ctx = {
      toolName: "synap_get_thread_context",
      args: { threadId: "11111111-1111-4111-8111-111111111111", ...args },
      userId: CALLER,
      apiKeyScopes: ["mcp.read"],
      caller,
      lensCaller: caller,
    } as unknown as McpToolContext;
    // What the dispatcher does with every reply (`adapter.ts`).
    const res = capReply(
      "synap_get_thread_context",
      await readHandlers.synap_get_thread_context!(ctx)
    );
    return { body: text(res), asked };
  };

  it("the founder's room (20 agent posts of ~1,100 characters, 22,886 on the wire): parseable, the newest kept, a cursor on", async () => {
    const msgs = room(20, 1_050);
    const { body } = await read(msgs, { limit: 20 });
    expect(body.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const parsed = JSON.parse(body);
    expect(parsed.truncated).toBeUndefined();
    const shown = parsed.messages as Array<{ id: string }>;
    // The fit fills the budget (a halving left 5 of 20 and a third of it unused).
    expect(shown.length).toBeGreaterThan(5);
    const perMessage = body.length / shown.length;
    expect(body.length).toBeGreaterThan(FIT_BUDGET_CHARS - 2 * perMessage);
    expect(shown.map((m) => m.id)).toEqual(
      msgs.slice(0, shown.length).map((m) => m.id)
    );
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe(shown[shown.length - 1].id);
  });

  it("a small room is read whole, with no fit notice", async () => {
    const { body } = await read(room(5, 300));
    const parsed = JSON.parse(body);
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.fit).toBeUndefined();
  });

  it("a message over the clip keeps its start, says so, and stays fenced", async () => {
    const { body } = await read(room(1, 30_000));
    const [m] = JSON.parse(body).messages;
    expect(m.truncated).toBe(true);
    expect(m.contentChars).toBe(
      30_000 + "[tool-install] checkpoint 1: ".length
    );
    expect(m.content).toMatch(/untrusted/i);
    expect(m.content.length).toBeLessThan(THREAD_MESSAGE_MAX_CHARS + 600);
  });

  it("50 long messages: the newest are kept, the oldest left out, and the cursor reads on from the last one shown", async () => {
    const msgs = room(50, 1_900);
    const { body } = await read(msgs);
    expect(body.length).toBeLessThanOrEqual(REPLY_CAP_CHARS);
    const parsed = JSON.parse(body);
    expect(parsed.truncated).toBeUndefined();
    const shown = parsed.messages as Array<{ id: string }>;
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(50);
    expect(shown[0].id).toBe(msgs[0].id);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe(shown[shown.length - 1].id);
    expect(parsed.fit.omitted.messages).toBe(50 - shown.length);
  });

  it("a cursor is passed on to the read; a malformed one is not", async () => {
    const cursor = "22222222-2222-4222-8222-222222222222";
    expect((await read(room(2, 10), { cursor })).asked[0].cursor).toBe(cursor);
    expect(
      (await read(room(2, 10), { cursor: "nope" })).asked[0].cursor
    ).toBeUndefined();
  });
});

describe("the lean session header", () => {
  it("carries what a worker reads (playbook, params, declared output kinds), never the long columns", () => {
    const header = projectLeanSessionHeader({
      id: "s-1",
      title: "Consolidate findings",
      goal: "g".repeat(2_000),
      status: "active",
      channelId: "c-1",
      playbookId: "p-1",
      parentSessionId: "parent-1",
      expectedOutputs: [
        { key: "pr", label: "PR", kind: "pull_request", owner: "agent" },
      ],
      stages: [
        {
          key: "build",
          name: "Build",
          goal: "x".repeat(4_000),
          criteria: [{ statement: "y".repeat(2_000) }],
          expectedOutputs: [{ key: "code", label: "Code", kind: "code" }],
        },
      ],
      metadata: {
        prompt: "p".repeat(2_500),
        runTurns: Array.from({ length: 40 }, () => ({ text: "r".repeat(200) })),
        params: { repo: "synap-backend", takes: ["f1", "f2"], blob: { a: 1 } },
      },
    });
    const json = JSON.stringify(header);
    expect(json.length).toBeLessThan(1_500);
    expect(header).toMatchObject({
      id: "s-1",
      channelId: "c-1",
      playbookId: "p-1",
      parentSessionId: "parent-1",
      expectedOutputs: [{ key: "pr", kind: "pull_request" }],
      stages: [{ key: "build", expectedOutputs: [{ kind: "code" }] }],
      metadata: { params: { repo: "synap-backend", takes: ["f1", "f2"] } },
    });
    expect((header.goal as string).length).toBe(LEAN_HEADER_TEXT_MAX);
    expect(json).not.toMatch(/runTurns|prompt|criteria/);
  });
});
