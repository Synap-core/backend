import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntelligenceAuthError,
  IntelligenceHubClient,
} from "./intelligence-hub-client.js";
import { narrowPartialFailure } from "./is-chat-stream.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("IntelligenceHubClient.sendMessageStream", () => {
  it("does not synthesize a duplicate completion after the IS completes", async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"type":"complete","data":{"content":"done"}}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const eventTypes: string[] = [];
    for await (const event of client.sendMessageStream({
      query: "hello",
      threadId: "thread-1",
      userId: "user-1",
    })) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual(["complete"]);
  });

  it("keeps a terminal error terminal instead of completing it", async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"type":"error","error":"upstream failed"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const events = [];
    for await (const event of client.sendMessageStream({
      query: "hello",
      threadId: "thread-1",
      userId: "user-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", error: "upstream failed" }]);
  });

  it("forwards generic turn context and existing context-object fields", async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"type":"complete","data":{"content":"done"}}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const events = [];
    for await (const event of client.sendMessageStream({
      query: "What is open?",
      threadId: "thread-1",
      userId: "user-1",
      projectId: "79f58d96-dca2-4f96-ad20-9a3ae619fdf3",
      contextObjectType: "view",
      contextObjectId: "view-1",
      turnContext: { surface: { name: "Inbox" } },
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "complete",
      data: { content: "done" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      contextObjectType: "view",
      contextObjectId: "view-1",
      projectId: "79f58d96-dca2-4f96-ad20-9a3ae619fdf3",
      turnContext: { surface: { name: "Inbox" } },
    });
  });
});

describe("IntelligenceHubClient.sendMessageStream — committed partial turn", () => {
  // THE INTERACTIVE PATH. A mid-stream provider death commits its partial text
  // and ends the stream NORMALLY, so there is no `error` frame — `complete` is
  // the only carrier. This client had ZERO occurrences of `partialFailure`, and
  // a truncated answer reached the browser looking finished. The frame's `data`
  // must stay an OPEN pass-through: picking named fields off it here is exactly
  // how the signal would be lost again.
  it("forwards partialFailure on the complete event's data", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        'data: {"type":"content","content":"Half an ans"}\n\n' +
          'data: {"type":"complete","data":{"content":"Half an ans","partialFailure":{"code":"insufficient_credit","message":"Insufficient Balance","retryable":false}}}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const events = [];
    for await (const event of client.sendMessageStream({
      query: "hello",
      threadId: "thread-1",
      userId: "user-1",
    })) {
      events.push(event);
    }

    const complete = events.find((event) => event.type === "complete");
    expect(
      narrowPartialFailure(
        (complete?.data as { partialFailure?: unknown } | undefined)
          ?.partialFailure
      )
    ).toMatchObject({ code: "insufficient_credit", retryable: false });
  });

  it("a clean complete carries no partialFailure", async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"type":"complete","data":{"content":"done"}}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const events = [];
    for await (const event of client.sendMessageStream({
      query: "hello",
      threadId: "thread-1",
      userId: "user-1",
    })) {
      events.push(event);
    }

    const complete = events.find((event) => event.type === "complete");
    expect(
      narrowPartialFailure(
        (complete?.data as { partialFailure?: unknown } | undefined)
          ?.partialFailure
      )
    ).toBeNull();
  });
});

describe("IntelligenceHubClient.structure — progress stream", () => {
  // One body, two transports. The SSE result frame must carry EXACTLY what
  // the JSON path returns, so the pod cannot tell which transport answered.
  const BODY = {
    entities: [
      {
        tempId: "t1",
        profileSlug: "task",
        title: "Call Alice",
        confidence: 0.9,
        facets: [{ profileSlug: "client", contextTempId: "t2" }],
      },
    ],
    relations: [
      { sourceTempId: "t1", targetTempId: "t2", relationType: "about" },
    ],
    followUp: null,
    meta: {
      engine: "structure",
      model: "m",
      provider: "p",
      promptVersion: "structure:abc",
    },
  };
  const STAGE = {
    v: 1,
    seq: 1,
    kind: "stage",
    stage: "understanding",
    attempt: 1,
    at: "2026-09-14T00:00:00.000Z",
  };
  const DRAFT = {
    v: 1,
    seq: 2,
    kind: "draft",
    attempt: 1,
    rev: 0,
    entities: [{ title: "Call Alice", profileSlug: "task" }],
  };

  const sse = (...frames: unknown[]) =>
    new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const acceptOf = (callIndex = 0) =>
    new Headers(
      fetchMock.mock.calls[callIndex]?.[1]?.headers as Record<string, string>
    ).get("accept");

  it("JSON and SSE transports return deep-equal results for the same body", async () => {
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    fetchMock.mockResolvedValueOnce(json(BODY));
    const viaJson = await client.structure({ text: "call alice" });

    fetchMock.mockResolvedValueOnce(
      sse(STAGE, DRAFT, { type: "result", status: 200, body: BODY })
    );
    const viaSse = await client.structure(
      { text: "call alice" },
      { onProgress: () => {} }
    );

    expect(viaJson).toEqual(BODY);
    expect(viaSse).toEqual(viaJson);
  });

  it("without onProgress: no Accept header and onProgress-free JSON answer", async () => {
    fetchMock.mockResolvedValueOnce(json(BODY));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    expect(await client.structure({ text: "call alice" })).toEqual(BODY);
    expect(acceptOf()).toBeNull();
  });

  it("with onProgress: asks for SSE, and an IS that answers JSON never calls onProgress", async () => {
    fetchMock.mockResolvedValueOnce(json(BODY));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(
      await client.structure({ text: "call alice" }, { onProgress })
    ).toEqual(BODY);
    expect(acceptOf()).toBe("text/event-stream");
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("forwards decoded stage and draft frames in order", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(STAGE, DRAFT, { type: "result", status: 200, body: BODY })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    await client.structure({ text: "call alice" }, { onProgress });

    expect(onProgress.mock.calls.map(([e]) => e)).toEqual([STAGE, DRAFT]);
  });

  it("ignores malformed, unknown and done frames instead of forwarding them", async () => {
    const unknownKind = { ...STAGE, seq: 3, kind: "summary" };
    const unknownVersion = { ...STAGE, seq: 4, v: 2 };
    const badStage = { ...STAGE, seq: 5, stage: "thinking" };
    const done = { v: 1, seq: 6, kind: "done", outcome: "plan" };
    fetchMock.mockResolvedValueOnce(
      new Response(
        "data: {not json\n\n" +
          [unknownKind, unknownVersion, badStage, done, STAGE]
            .map((f) => `data: ${JSON.stringify(f)}\n\n`)
            .join("") +
          `data: ${JSON.stringify({ type: "result", status: 200, body: BODY })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(await client.structure({ text: "x" }, { onProgress })).toEqual(BODY);
    expect(onProgress.mock.calls.map(([e]) => e)).toEqual([STAGE]);
  });

  it("drops an IS-local stage name (`extracting`) — the IS must map it to `reading`", async () => {
    // Pins the CLIENT half only: an IS that drifts to its own stage names gets
    // no progress on the pod. It cannot see the IS drift itself — that needs an
    // IS-side frame fixture checked against the same decoder.
    const extracting = { ...STAGE, stage: "extracting" };
    const reading = { ...STAGE, seq: 2, stage: "reading" };
    fetchMock.mockResolvedValueOnce(
      sse(extracting, reading, { type: "result", status: 200, body: BODY })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(await client.structure({ text: "x" }, { onProgress })).toEqual(BODY);
    expect(onProgress.mock.calls.map(([e]) => e)).toEqual([reading]);
  });

  const chunked = (...chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

  it("returns the result when the final frame has no trailing newline", async () => {
    fetchMock.mockResolvedValueOnce(
      chunked(
        `data: ${JSON.stringify(STAGE)}\n\n`,
        `data: ${JSON.stringify({ type: "result", status: 200, body: BODY })}`
      )
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(await client.structure({ text: "x" }, { onProgress })).toEqual(BODY);
    expect(onProgress.mock.calls.map(([e]) => e)).toEqual([STAGE]);
  });

  it("parses a frame split across two reads", async () => {
    const resultLine = `data: ${JSON.stringify({ type: "result", status: 200, body: BODY })}\n\n`;
    const stageLine = `data: ${JSON.stringify(STAGE)}\n\n`;
    const cut = Math.floor(resultLine.length / 2);
    fetchMock.mockResolvedValueOnce(
      chunked(
        stageLine.slice(0, 9),
        stageLine.slice(9) + resultLine.slice(0, cut),
        resultLine.slice(cut)
      )
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(await client.structure({ text: "x" }, { onProgress })).toEqual(BODY);
    expect(onProgress.mock.calls.map(([e]) => e)).toEqual([STAGE]);
  });

  it("a stream that ends without a result frame is a failed call (null), not an empty structure", async () => {
    fetchMock.mockResolvedValueOnce(sse(STAGE, DRAFT));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    expect(
      await client.structure({ text: "x" }, { onProgress: () => {} })
    ).toBeNull();
  });

  it("an error frame is a failed call (null) even when a result follows", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(
        STAGE,
        { type: "error", error: "provider down" },
        { type: "result", status: 200, body: BODY }
      )
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    expect(
      await client.structure({ text: "x" }, { onProgress: () => {} })
    ).toBeNull();
  });

  it("a result frame with a non-200 status (408 aborted) is a failed call (null), not its body", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(STAGE, { type: "result", status: 408, body: BODY })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    expect(
      await client.structure({ text: "x" }, { onProgress: () => {} })
    ).toBeNull();
  });

  it("a result frame carrying an auth status throws IntelligenceAuthError, like the JSON path", async () => {
    fetchMock.mockResolvedValueOnce(
      sse({ type: "result", status: 401, body: BODY })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    await expect(
      client.structure({ text: "x" }, { onProgress: () => {} })
    ).rejects.toBeInstanceOf(IntelligenceAuthError);
  });

  it("an IS error frame (`structure_error: X`) is a failed call (null)", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(STAGE, { type: "error", error: "structure_error: provider down" })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    expect(
      await client.structure({ text: "x" }, { onProgress: () => {} })
    ).toBeNull();
  });

  it("a 400 application/json answer to an SSE request is a failed call (null) with no progress", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid input" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(await client.structure({ text: "" }, { onProgress })).toBeNull();
    expect(acceptOf()).toBe("text/event-stream");
    expect(onProgress).not.toHaveBeenCalled();
  });

  // GOLDEN — raw /api/structure SSE bodies captured by lane progress-is1 on
  // 2026-09-14 from a real route run of the harness in
  // synap-intelligence-service/apps/intelligence-hub/src/routes/structure.progress.test.ts:
  //   FILE_FALLTHROUGH — file input, model-a fails → model-b answers (ad hoc
  //     run of that harness; no single named scenario there is exactly this);
  //   EXTRACTION_THROWS — "extraction that throws ends the stream with an
  //     error frame (JSON: 500)" (:393).
  // Byte-for-byte strings, NOT rebuilt from frames: this is the seam test.
  // Recapture both if the IS wire format ever changes.
  const GOLDEN_FILE_FALLTHROUGH =
    'data: {"v":1,"seq":0,"kind":"stage","stage":"reading","attempt":1,"at":"2026-09-14T03:23:38.161Z"}\n\ndata: {"v":1,"seq":1,"kind":"stage","stage":"understanding","attempt":1,"at":"2026-09-14T03:23:38.163Z"}\n\ndata: {"v":1,"seq":2,"kind":"stage","stage":"understanding","attempt":2,"at":"2026-09-14T03:23:38.163Z"}\n\ndata: {"type":"result","status":200,"body":{"entities":[{"tempId":"t1","profileSlug":"note","title":"Lunch","confidence":0.9}],"relations":[],"followUp":null,"targetWorkspaceId":null,"targetWorkspaceName":null,"targetWorkspaceReason":null,"targetWorkspaceConfidence":null,"targetProjectId":null,"targetProjectReason":null,"targetProjectConfidence":null,"meta":{"engine":"structure","model":"model-b","provider":"prov-b","promptVersion":"structure:631586058254","timings":{"waitMs":1,"extractMs":1,"modelMs":0,"salvaged":false}},"extraction":{"kind":"image","extractor":"stub","metadata":{},"degraded":false,"warnings":[],"text":"A beach at sunset.","textTruncated":false}}}\n\n';
  const GOLDEN_EXTRACTION_THROWS =
    'data: {"v":1,"seq":0,"kind":"stage","stage":"reading","attempt":1,"at":"2026-09-14T03:23:38.167Z"}\n\ndata: {"type":"error","error":"structure_error: TypeError"}\n\n';
  const goldenResponse = (raw: string) =>
    new Response(raw, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  it("GOLDEN file + fallthrough: forwards the three real stages and returns the real body", async () => {
    fetchMock.mockResolvedValueOnce(goldenResponse(GOLDEN_FILE_FALLTHROUGH));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    const result = await client.structure(
      { file: { content: "x", mimeType: "image/png" } },
      { onProgress }
    );

    // Stated by hand, not derived from the fixture with the code under test.
    expect(
      onProgress.mock.calls.map(([e]) => [e.seq, e.kind, e.stage, e.attempt])
    ).toEqual([
      [0, "stage", "reading", 1],
      [1, "stage", "understanding", 1],
      [2, "stage", "understanding", 2],
    ]);
    expect(result).toMatchObject({
      entities: [
        { tempId: "t1", profileSlug: "note", title: "Lunch", confidence: 0.9 },
      ],
      relations: [],
      followUp: null,
      meta: { engine: "structure", model: "model-b", provider: "prov-b" },
      extraction: { kind: "image", text: "A beach at sunset." },
    });
    expect(result).not.toHaveProperty("type");
    expect(result).not.toHaveProperty("status");
  });

  it("GOLDEN extraction throws: forwards reading, then the error frame is a failed call (null)", async () => {
    fetchMock.mockResolvedValueOnce(goldenResponse(GOLDEN_EXTRACTION_THROWS));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");
    const onProgress = vi.fn();

    expect(
      await client.structure(
        { file: { content: "x", mimeType: "image/png" } },
        { onProgress }
      )
    ).toBeNull();
    expect(
      onProgress.mock.calls.map(([e]) => [e.seq, e.stage, e.attempt])
    ).toEqual([[0, "reading", 1]]);
  });

  it("still throws IntelligenceAuthError on 401 when streaming was requested", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const client = new IntelligenceHubClient("http://intelligence.test", "key");

    await expect(
      client.structure({ text: "x" }, { onProgress: () => {} })
    ).rejects.toBeInstanceOf(IntelligenceAuthError);
  });
});
