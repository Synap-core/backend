/**
 * Discord agent-turn stream accumulation (Phase 1 observability).
 *
 * Pure helper: consume an IntelligenceHubClient.sendMessageStream (or any
 * compatible AsyncIterable of HubStreamEvent-shaped frames) into final text +
 * tool steps. Used by POST /discord/agent-turn so a bridge/pod deadline can
 * still return partial steps instead of an empty body.
 *
 * Mirrors the content/step collection in channels.sendMessage — no realtime
 * emit, no DB, no firewall. Kept separate from discord.ts so unit tests can
 * exercise mock frames without mounting the full route graph.
 */

import type { AIStep, HubStreamEvent } from "@synap-core/types";

export type AgentTurnStreamFrame = Pick<
  HubStreamEvent,
  "type" | "content" | "step" | "data" | "error"
>;

export type AgentTurnStreamResult = {
  fullContent: string;
  aiSteps: AIStep[];
  timedOut: boolean;
  streamError: string | null;
};

/**
 * Accumulate an IS sendMessageStream into final text + tool steps.
 *
 * On abort (deadline / request signal), returns whatever was collected with
 * timedOut=true so the caller can still return steps to the bridge.
 */
export async function accumulateAgentTurnStream(
  stream: AsyncIterable<AgentTurnStreamFrame>,
  signal?: AbortSignal
): Promise<AgentTurnStreamResult> {
  let fullContent = "";
  let completeContent = "";
  const aiSteps: AIStep[] = [];
  let streamError: string | null = null;
  let timedOut = false;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      timedOut = true;
      const err = new Error("Agent turn deadline exceeded");
      err.name = "AbortError";
      throw err;
    }
  };

  try {
    throwIfAborted();
    for await (const chunk of stream) {
      throwIfAborted();
      if (chunk.type === "chunk" && chunk.content) {
        fullContent += chunk.content;
      } else if (chunk.type === "step" && chunk.step) {
        aiSteps.push(chunk.step);
      } else if (chunk.type === "error") {
        streamError =
          streamError ?? chunk.error ?? "Intelligence service stream failed";
        // Terminal for this turn — stop consuming further frames.
        break;
      } else if (chunk.type === "complete") {
        if (chunk.data && typeof chunk.data === "object") {
          const data = chunk.data as { content?: string };
          if (typeof data.content === "string" && data.content) {
            completeContent = data.content;
          }
        }
      }
    }
  } catch (err) {
    const isAbort =
      (err instanceof Error &&
        (err.name === "AbortError" ||
          /abort|timed out|deadline exceeded/i.test(err.message))) ||
      signal?.aborted === true;
    if (isAbort) {
      timedOut = true;
    } else {
      streamError =
        streamError ?? (err instanceof Error ? err.message : String(err));
    }
  }

  return {
    fullContent: fullContent || completeContent,
    aiSteps,
    timedOut,
    streamError,
  };
}
