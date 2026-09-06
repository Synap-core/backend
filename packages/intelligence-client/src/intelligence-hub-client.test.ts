import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelligenceHubClient } from "./intelligence-hub-client.js";
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
