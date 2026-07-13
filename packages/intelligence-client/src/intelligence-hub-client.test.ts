import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelligenceHubClient } from "./intelligence-hub-client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("IntelligenceHubClient.sendMessageStream", () => {
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
      turnContext: { surface: { name: "Inbox" } },
    });
  });
});
