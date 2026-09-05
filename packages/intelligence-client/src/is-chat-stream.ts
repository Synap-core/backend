/**
 * iterateISChatStream — the ONE parser for an Intelligence Service
 * `/api/chat/stream` SSE response.
 *
 * The IS emits `data: {...}\n` frames whose `type` is one of `content`, `step`,
 * `entities`, `branch_decision`, `route_to_channel`, `error`, `complete`. This
 * generator owns the line-buffering, `data: ` framing, `[DONE]` handling, and
 * malformed-line tolerance — nothing else. It does NOT own the fetch, HTTP
 * status handling, or the circuit breaker; the caller owns those and passes the
 * live `Response`.
 *
 * Callers:
 *   - IntelligenceHubClient.sendMessageStream — maps raw frames → typed
 *     HubStreamEvent for the interactive chat path.
 *   - the a2ai-response-trigger worker (via drainISChatStream) — headless turns.
 *   - the OpenAI-compat proxy — re-emits frames in OpenAI delta format.
 *
 * Previously each of those hand-rolled the identical `data: ` split loop; a
 * drift between them (matching `type:"chunk"` that the IS never sends) is what
 * silently dropped every headless reply. One reader, one behavior.
 */

/** A raw SSE frame from the IS `/api/chat/stream` endpoint. */
export interface ISChatStreamFrame {
  type?: string;
  content?: string;
  step?: unknown;
  entities?: unknown;
  decision?: unknown;
  routing?: unknown;
  proposal?: unknown;
  data?: {
    content?: string;
    /**
     * Present ONLY on a `complete` frame whose turn died mid-stream and whose
     * partial text was committed anyway. Typed as unknown here so this leaf
     * parser stays dependency-free; `drainISChatStream` narrows it.
     */
    partialFailure?: unknown;
    [k: string]: unknown;
  };
  error?: string;
  /**
   * Structured failure evidence on an `error` frame (code / retryable /
   * status / provider ids). Typed as unknown here so this leaf parser stays
   * dependency-free; the client narrows it to `IsFailureEnvelope` when it
   * forwards the frame.
   */
  failure?: unknown;
}

/**
 * Parse an IS chat-stream response into its raw frames. Yields each `data:`
 * frame as it arrives; ignores malformed lines and `[DONE]`. Releases the
 * reader lock when the consumer stops (normal completion or early break).
 */
export async function* iterateISChatStream(
  response: Response
): AsyncGenerator<ISChatStreamFrame> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let frame: ISChatStreamFrame;
        try {
          frame = JSON.parse(raw) as ISChatStreamFrame;
        } catch (parseError) {
          // Tolerate malformed frames, but surface them — a silently-dropped
          // frame is exactly how the stream:true / type-drift bugs stayed hidden.
          console.error("Failed to parse IS SSE frame:", raw, parseError);
          continue;
        }
        yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Structural mirror of the IS's `ProviderFailure`
 * (`lib/provider-failure.ts`). Duplicated as a shape, not imported: this
 * package must not depend on the IS. Only the fields a backend consumer can
 * act on are declared.
 *
 * ⚠️ `message` is the RAW underlying provider error. It is diagnostic — the IS
 * documents it as NOT user-facing copy. Log it; never render it.
 */
export interface ISPartialFailure {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  providerId?: string;
  providerCode?: string;
  retryAfterSeconds?: number;
}

function narrowPartialFailure(raw: unknown): ISPartialFailure | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.code !== "string") return null;
  return {
    code: obj.code,
    message: typeof obj.message === "string" ? obj.message : "",
    retryable: obj.retryable === true,
    ...(typeof obj.status === "number" ? { status: obj.status } : {}),
    ...(typeof obj.providerId === "string"
      ? { providerId: obj.providerId }
      : {}),
    ...(typeof obj.providerCode === "string"
      ? { providerCode: obj.providerCode }
      : {}),
    ...(typeof obj.retryAfterSeconds === "number"
      ? { retryAfterSeconds: obj.retryAfterSeconds }
      : {}),
  };
}

/** Options for draining an IS chat stream (headless / non-interactive). */
export type DrainISChatStreamOptions = {
  /** Invoked for each content delta as it arrives. */
  onContent?: (chunk: string) => void;
  /**
   * When true, accumulate `step` frames into `result.steps` (tool/thinking
   * steps for metadata.aiSteps). Default false — other callers keep the
   * text-only return shape.
   */
  collectSteps?: boolean;
};

export type DrainISChatStreamResult = {
  text: string;
  error: string | null;
  /**
   * Set when the IS's `complete` frame reported a COMMITTED PARTIAL turn: the
   * provider died mid-stream, the text produced so far was committed, and the
   * stream ended normally. `text` is real but TRUNCATED and `error` stays null
   * (there was no `error` frame) — so a caller that only reads `error` records
   * a truncated answer as a complete success. That is the exact defect this
   * field exists to close: check it before writing a terminal status.
   */
  partialFailure?: ISPartialFailure;
  /** Present only when `collectSteps: true` was requested. */
  steps?: unknown[];
};

function normalizeDrainOptions(
  onContentOrOptions?: ((chunk: string) => void) | DrainISChatStreamOptions
): DrainISChatStreamOptions {
  if (typeof onContentOrOptions === "function") {
    return { onContent: onContentOrOptions };
  }
  return onContentOrOptions ?? {};
}

/**
 * Drain an IS chat stream to its final text — for non-interactive callers that
 * do not forward deltas onward (e.g. the a2ai worker). Accumulates `content`
 * frames and prefers them; falls back to the authoritative `complete.data.content`
 * when the agent produced text only in its final message. Surfaces the first
 * `error` frame, AND the `complete` frame's `partialFailure` — a mid-stream
 * provider death commits its partial text and ends the stream NORMALLY, so
 * `error` is null and only `partialFailure` distinguishes a truncated answer
 * from a finished one. Never throws on frame content; transport errors propagate.
 *
 * Second arg accepts either a legacy `onContent` callback or an options object
 * `{ onContent?, collectSteps? }`. When `collectSteps` is true, `step` frames
 * are collected into `result.steps` (for assistant metadata.aiSteps).
 */
export async function drainISChatStream(
  response: Response,
  onContentOrOptions?: ((chunk: string) => void) | DrainISChatStreamOptions
): Promise<DrainISChatStreamResult> {
  const options = normalizeDrainOptions(onContentOrOptions);
  let acc = "";
  let completeContent = "";
  let streamError: string | null = null;
  let partialFailure: ISPartialFailure | null = null;
  const steps: unknown[] | undefined = options.collectSteps ? [] : undefined;

  for await (const frame of iterateISChatStream(response)) {
    if (frame.type === "content" && frame.content) {
      acc += frame.content;
      options.onContent?.(frame.content);
    } else if (
      options.collectSteps &&
      frame.type === "step" &&
      frame.step != null &&
      steps
    ) {
      steps.push(frame.step);
    } else if (frame.type === "complete") {
      completeContent = frame.data?.content ?? "";
      partialFailure =
        partialFailure ?? narrowPartialFailure(frame.data?.partialFailure);
    } else if (frame.type === "error") {
      streamError = streamError ?? frame.error ?? "unknown IS stream error";
    }
  }

  const result: DrainISChatStreamResult = {
    text: acc || completeContent,
    error: streamError,
  };
  if (partialFailure) {
    result.partialFailure = partialFailure;
  }
  if (steps !== undefined) {
    result.steps = steps;
  }
  return result;
}
