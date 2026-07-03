import { describe, it, expect } from "vitest";
import { iterateISChatStream, drainISChatStream } from "./is-chat-stream.js";

/** Build a Response whose body streams `frames` as SSE, split at `chunkAt`
 *  byte boundaries to exercise cross-chunk line buffering. */
function sseResponse(raw: string, chunkSize = raw.length): Response {
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

function sse(frames: object[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n`).join("");
}

describe("iterateISChatStream", () => {
  it("yields each data frame in order", async () => {
    const res = sseResponse(
      sse([
        { type: "content", content: "Hel" },
        { type: "content", content: "lo" },
        { type: "complete", data: { content: "Hello" } },
      ])
    );
    const types: string[] = [];
    for await (const f of iterateISChatStream(res)) types.push(f.type!);
    expect(types).toEqual(["content", "content", "complete"]);
  });

  it("tolerates [DONE], blank lines, and malformed frames", async () => {
    const raw =
      `data: {"type":"content","content":"a"}\n` +
      `\n` +
      `data: not-json\n` +
      `data: [DONE]\n` +
      `: comment line\n` +
      `data: {"type":"complete"}\n`;
    const seen: string[] = [];
    for await (const f of iterateISChatStream(sseResponse(raw))) {
      seen.push(f.type ?? "?");
    }
    expect(seen).toEqual(["content", "complete"]);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    // 5-byte chunks slice mid-frame — the buffer must stitch them.
    const res = sseResponse(
      sse([
        { type: "content", content: "streaming" },
        { type: "complete", data: { content: "streaming" } },
      ]),
      5
    );
    let text = "";
    for await (const f of iterateISChatStream(res)) {
      if (f.type === "content") text += f.content;
    }
    expect(text).toBe("streaming");
  });
});

describe("drainISChatStream", () => {
  it("accumulates content frames", async () => {
    const res = sseResponse(
      sse([
        { type: "content", content: "foo " },
        { type: "content", content: "bar" },
        { type: "complete", data: { content: "IGNORED — deltas win" } },
      ])
    );
    const { text, error } = await drainISChatStream(res);
    expect(text).toBe("foo bar");
    expect(error).toBeNull();
  });

  it("falls back to complete.data.content when no content frames arrived", async () => {
    const res = sseResponse(
      sse([{ type: "complete", data: { content: "final-only" } }])
    );
    const { text } = await drainISChatStream(res);
    expect(text).toBe("final-only");
  });

  it("surfaces the first error frame", async () => {
    const res = sseResponse(
      sse([{ type: "error", error: "boom" }, { type: "complete" }])
    );
    const { text, error } = await drainISChatStream(res);
    expect(text).toBe("");
    expect(error).toBe("boom");
  });

  it("invokes onContent for each delta", async () => {
    const res = sseResponse(
      sse([
        { type: "content", content: "x" },
        { type: "content", content: "y" },
      ])
    );
    const chunks: string[] = [];
    await drainISChatStream(res, (c) => chunks.push(c));
    expect(chunks).toEqual(["x", "y"]);
  });
});
