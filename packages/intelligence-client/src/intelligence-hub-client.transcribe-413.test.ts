/**
 * A body limit that answers before /api/transcribe runs (the IS's global size
 * middleware, an edge proxy) returns a 413 with no `code`. Mapped to
 * is_invalid_response, the user was told the AI service was unreachable when
 * the clip was simply too big.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelligenceHubClient } from "./intelligence-hub-client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const client = new IntelligenceHubClient("http://intelligence.test", "key");
const clip = { content: "AAAA", mimeType: "audio/webm" };

describe("IntelligenceHubClient.transcribe — uncoded refusals", () => {
  it("reads an uncoded 413 as audio_too_large", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Request too large", maxSize: "10MB" }), { status: 413 }),
    );
    expect(await client.transcribe(clip)).toMatchObject({ ok: false, status: 413, code: "audio_too_large" });
  });

  it("keeps a coded refusal's own code", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "transcription_not_configured" }), { status: 503 }),
    );
    expect(await client.transcribe(clip)).toMatchObject({ code: "transcription_not_configured" });
  });
});
