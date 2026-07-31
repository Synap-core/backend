/**
 * Phase 1 agent-turn observability — stream accumulation + response shape.
 *
 * Covers:
 *   1. Success path: content + step frames → fullContent + aiSteps
 *   2. Abort mid-stream after steps → timedOut + partial progress preserved
 *   3. complete.data.content fallback when no content chunks
 *   4. Zero-progress stream error → streamError, empty content
 *   5. Source tripwire: agent-turn uses sendMessageStream + additive schema
 *
 * Does NOT spin a full Hono app (recordInboundMessage + IS routing are
 * heavily DB-coupled). The accumulator is the observable surface of Phase 1;
 * the handler wires it 1:1 into the HTTP body.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AIStep, HubStreamEvent } from "@synap-core/types";
import { accumulateAgentTurnStream } from "./discord-agent-turn-stream.js";

function step(
  partial: Partial<AIStep> & Pick<AIStep, "id" | "type" | "content">
): AIStep {
  return {
    timestamp: partial.timestamp ?? new Date().toISOString(),
    ...partial,
  };
}

async function* frames(
  events: Array<
    Pick<HubStreamEvent, "type" | "content" | "step" | "data" | "error">
  >
): AsyncGenerator<
  Pick<HubStreamEvent, "type" | "content" | "step" | "data" | "error">
> {
  for (const e of events) {
    yield e;
  }
}

/** Yield frames, then hang until aborted (simulates a slow IS mid-turn). */
async function* framesThenHang(
  events: Array<
    Pick<HubStreamEvent, "type" | "content" | "step" | "data" | "error">
  >,
  signal: AbortSignal
): AsyncGenerator<
  Pick<HubStreamEvent, "type" | "content" | "step" | "data" | "error">
> {
  for (const e of events) {
    yield e;
  }
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      },
      { once: true }
    );
  });
}

describe("accumulateAgentTurnStream", () => {
  it("accumulates content chunks + steps on full success", async () => {
    const toolStep = step({
      id: "s1",
      type: "tool_call",
      content: "calling search",
      toolName: "synap_ask",
      status: "running",
    });
    const result = await accumulateAgentTurnStream(
      frames([
        { type: "step", step: toolStep },
        { type: "chunk", content: "Hello " },
        { type: "chunk", content: "world" },
        {
          type: "step",
          step: step({
            id: "s2",
            type: "tool_result",
            content: "found 2 items",
            toolName: "synap_ask",
            status: "complete",
          }),
        },
        { type: "complete", data: { content: "Hello world" } },
      ])
    );

    expect(result.fullContent).toBe("Hello world");
    expect(result.aiSteps).toHaveLength(2);
    expect(result.aiSteps[0]?.toolName).toBe("synap_ask");
    expect(result.aiSteps[1]?.type).toBe("tool_result");
    expect(result.timedOut).toBe(false);
    expect(result.streamError).toBeNull();
  });

  it("falls back to complete.data.content when no content chunks arrived", async () => {
    const result = await accumulateAgentTurnStream(
      frames([
        {
          type: "step",
          step: step({ id: "t", type: "thinking", content: "…" }),
        },
        {
          type: "complete",
          data: { content: "Final answer only on complete" },
        },
      ])
    );

    expect(result.fullContent).toBe("Final answer only on complete");
    expect(result.aiSteps).toHaveLength(1);
    expect(result.timedOut).toBe(false);
  });

  it("returns partial steps + content on abort mid-stream", async () => {
    const ac = new AbortController();
    const toolStep = step({
      id: "s1",
      type: "tool_call",
      content: "searching",
      toolName: "synap_search",
      status: "running",
    });

    // Abort shortly after the hung stream starts waiting.
    setTimeout(() => ac.abort(), 20);

    const result = await accumulateAgentTurnStream(
      framesThenHang(
        [
          { type: "step", step: toolStep },
          { type: "chunk", content: "Partial " },
          { type: "chunk", content: "text" },
        ],
        ac.signal
      ),
      ac.signal
    );

    expect(result.timedOut).toBe(true);
    expect(result.fullContent).toBe("Partial text");
    expect(result.aiSteps).toEqual([toolStep]);
    expect(result.streamError).toBeNull();
  });

  it("surfaces stream error frames without dropping prior progress", async () => {
    const result = await accumulateAgentTurnStream(
      frames([
        {
          type: "step",
          step: step({ id: "s1", type: "thinking", content: "planning" }),
        },
        { type: "chunk", content: "Almost…" },
        { type: "error", error: "upstream failed" },
        // Should not be consumed after terminal error.
        { type: "chunk", content: " should not appear" },
      ])
    );

    expect(result.fullContent).toBe("Almost…");
    expect(result.aiSteps).toHaveLength(1);
    expect(result.streamError).toBe("upstream failed");
    expect(result.timedOut).toBe(false);
  });

  it("returns streamError with zero progress on hard failure", async () => {
    const result = await accumulateAgentTurnStream(
      frames([{ type: "error", error: "circuit open" }])
    );

    expect(result.fullContent).toBe("");
    expect(result.aiSteps).toEqual([]);
    expect(result.streamError).toBe("circuit open");
    expect(result.timedOut).toBe(false);
  });

  it("treats pre-aborted signal as timedOut with empty progress", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await accumulateAgentTurnStream(
      frames([{ type: "chunk", content: "never" }]),
      ac.signal
    );

    expect(result.timedOut).toBe(true);
    expect(result.fullContent).toBe("");
    expect(result.aiSteps).toEqual([]);
  });
});

/**
 * Map accumulator result → agent-turn HTTP body fields (mirrors handler
 * branching so partial body shape stays locked without a full Hono harness).
 */
function mapToAgentTurnBody(
  result: Awaited<ReturnType<typeof accumulateAgentTurnStream>>
): {
  reply: string;
  steps: AIStep[];
  partial?: boolean;
  timedOut?: boolean;
  error?: string;
} {
  const hasProgress = Boolean(result.fullContent) || result.aiSteps.length > 0;
  const IS_UNAVAILABLE =
    "The AI service is temporarily unavailable. Please try again in a moment.";
  const PARTIAL_MSG =
    "The agent timed out before finishing. Partial progress is included when available.";

  if (result.streamError && !hasProgress) {
    return {
      reply: IS_UNAVAILABLE,
      steps: result.aiSteps,
      error: result.streamError,
    };
  }
  if (result.timedOut && hasProgress) {
    return {
      reply: result.fullContent || PARTIAL_MSG,
      steps: result.aiSteps,
      partial: true,
      timedOut: true,
      error: result.streamError ?? "Agent turn deadline exceeded",
    };
  }
  if (result.timedOut && !hasProgress) {
    return {
      reply: IS_UNAVAILABLE,
      steps: result.aiSteps,
      timedOut: true,
      error: "Agent turn deadline exceeded",
    };
  }
  if (result.streamError && hasProgress) {
    return {
      reply: result.fullContent || PARTIAL_MSG,
      steps: result.aiSteps,
      partial: true,
      error: result.streamError,
    };
  }
  return {
    reply: result.fullContent,
    steps: result.aiSteps,
  };
}

describe("agent-turn response body from stream frames", () => {
  it("success body includes reply + steps", async () => {
    const result = await accumulateAgentTurnStream(
      frames([
        {
          type: "step",
          step: step({
            id: "s1",
            type: "tool_call",
            content: "x",
            toolName: "tool_a",
          }),
        },
        { type: "chunk", content: "Done." },
        { type: "complete", data: { content: "Done." } },
      ])
    );
    const body = mapToAgentTurnBody(result);
    expect(body).toEqual({
      reply: "Done.",
      steps: [expect.objectContaining({ id: "s1", toolName: "tool_a" })],
    });
    expect(body).not.toHaveProperty("partial");
    expect(body).not.toHaveProperty("timedOut");
  });

  it("abort mid-stream body is partial with steps", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const result = await accumulateAgentTurnStream(
      framesThenHang(
        [
          {
            type: "step",
            step: step({
              id: "s1",
              type: "tool_call",
              content: "running",
              toolName: "synap_ask",
            }),
          },
        ],
        ac.signal
      ),
      ac.signal
    );
    const body = mapToAgentTurnBody(result);
    expect(body.partial).toBe(true);
    expect(body.timedOut).toBe(true);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]?.toolName).toBe("synap_ask");
    // No content yet → short operator message, not empty string.
    expect(body.reply.length).toBeGreaterThan(0);
    expect(body.reply).not.toBe("");
  });
});

describe("discord agent-turn stream wiring (tripwire)", () => {
  const source = readFileSync(new URL("./discord.ts", import.meta.url), "utf8");

  it("uses sendMessageStream (not non-streaming sendMessage) for the turn", () => {
    expect(source).toContain("sendMessageStream({");
    // The old non-stream call must not remain as the primary path.
    expect(source).not.toMatch(/resolvedService\.client\.sendMessage\(\s*\{/);
    expect(source).toContain("accumulateAgentTurnStream");
    expect(source).toContain("aiSteps,");
    expect(source).toMatch(/metadata:\s*\{[\s\S]*aiSteps/);
  });

  it("declares additive observability fields on AgentTurnResponseSchema", () => {
    expect(source).toContain("steps: z.array(AgentTurnStepSchema).optional()");
    expect(source).toContain("partial: z.boolean().optional()");
    expect(source).toContain("timedOut: z.boolean().optional()");
    // Durable chat_turns ledger id (UnifiedRun flowType "chat").
    expect(source).toContain("turnId: z.string().uuid().optional()");
    // priority on request preserved for digests
    expect(source).toContain(
      'priority: z.enum(["interactive", "background"]).optional()'
    );
    expect(source).toContain(
      "...(body.priority ? { priority: body.priority } : {})"
    );
  });

  it("reserves and finishes a chat_turns row for agent-turn observability", () => {
    expect(source).toContain("createOrGetChatTurn");
    expect(source).toContain("finishChatTurn");
    expect(source).toContain("stableUuidFromSeed");
    expect(source).toMatch(/turnId:\s*durableTurn\.id|turnId:\s*priorTurn\.id/);
  });

  it("reopens failed turns under same requestId when no useful assistant (D5)", () => {
    expect(source).toContain("decideChatTurnClaimAction");
    expect(source).toContain("reopenChatTurn");
    expect(source).toContain("reopen_and_run");
  });
});
