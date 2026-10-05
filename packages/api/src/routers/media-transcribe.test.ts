/**
 * `/api/media/transcribe` — the pod's dictation door.
 *
 * Driven through the REAL Hono app and the REAL `IntelligenceHubClient`
 * (`transcribe` / `transcriptionStatus`); only session auth, the IS resolver's
 * DB ladder and the network (`fetch` to the IS) are stood in. So these assert
 * what the IS is SENT over Hub Protocol and what the client GETS back.
 *
 * Does NOT see: the IS side of `/api/transcribe` (tested in
 * synap-intelligence-service `transcription.test.ts`) or a live provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (
    c: {
      req: { header: (k: string) => string | undefined };
      set: (k: string, v: unknown) => void;
      json: (b: unknown, s: number) => Response;
    },
    next: () => Promise<void>
  ) => {
    const userId = c.req.header("x-test-user");
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    c.set("userId", userId);
    c.set("authenticated", true);
    return next();
  },
}));

vi.mock("../access/guest-containment.js", () => ({
  refuseGuestSession: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/intelligence-client")>();
  return {
    ...actual,
    resolveIntelligenceService: vi.fn(async () => ({
      serviceId: "default",
      endpoint: "http://is.test",
      serviceApiKey: "is-key",
      client: new actual.IntelligenceHubClient("http://is.test", "is-key"),
    })),
  };
});

import {
  mediaTranscribeApp,
  MAX_TRANSCRIBE_BYTES,
} from "./media-transcribe.js";

const fetchMock = vi.fn();

function isAnswer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function postAudio(
  bytes: Uint8Array<ArrayBuffer>,
  type = "audio/webm",
  extra: Record<string, string> = {}
) {
  const form = new FormData();
  form.append("file", new File([bytes], "clip.webm", { type }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return mediaTranscribeApp.request("/transcribe", {
    method: "POST",
    headers: { "x-test-user": "user-1" },
    body: form,
  });
}

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("POST /api/media/transcribe", () => {
  it("forwards the audio to the IS as base64 and returns the transcript", async () => {
    fetchMock.mockResolvedValue(
      isAnswer(200, {
        text: "remind me to call Ana",
        language: "english",
        durationMs: 1800,
        model: "whisper-large-v3-turbo",
        provider: "groq",
      })
    );
    const res = await postAudio(
      new TextEncoder().encode("opus"),
      "audio/webm",
      {
        language: "en",
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "remind me to call Ana",
      language: "english",
      durationMs: 1800,
      model: "whisper-large-v3-turbo",
      provider: "groq",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://is.test/api/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("is-key");
    expect(JSON.parse(init.body)).toEqual({
      content: Buffer.from("opus").toString("base64"),
      mimeType: "audio/webm",
      language: "en",
    });
  });

  it.each([
    [503, "transcription_not_configured"],
    [502, "transcription_provider_failed"],
    [429, "llm_budget_exceeded"],
    [415, "unsupported_audio_type"],
  ])(
    "passes the IS's %i %s through with its own status",
    async (status, code) => {
      fetchMock.mockResolvedValue(isAnswer(status, { code, error: "x" }));
      const res = await postAudio(new Uint8Array([1]));
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
  );

  it("an IS without the route (404) reads as not configured, cause named", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const res = await postAudio(new Uint8Array([1]));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "transcription_not_configured",
      reason: "is_route_missing",
    });
  });

  it("an IS that cannot be reached is a 502, never an empty transcript", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await postAudio(new Uint8Array([1]));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("intelligence_unreachable");
  });

  it("an IS 200 without text is is_invalid_response, never an empty transcript", async () => {
    fetchMock.mockResolvedValue(isAnswer(200, { nope: true }));
    const res = await postAudio(new Uint8Array([1]));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("is_invalid_response");
  });

  it("refuses before calling the IS: no file 400, non-audio 415, too large 413", async () => {
    const noFile = await mediaTranscribeApp.request("/transcribe", {
      method: "POST",
      headers: { "x-test-user": "user-1" },
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);

    const image = await postAudio(new Uint8Array([1]), "image/png");
    expect(image.status).toBe(415);

    const big = await postAudio(new Uint8Array(MAX_TRANSCRIBE_BYTES + 1));
    expect(big.status).toBe(413);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The bodyLimit ceiling, observable only through a declared Content-Length:
  // a streamed oversize body is ALSO refused by the per-file check after
  // buffering, so from outside the two are indistinguishable (verified —
  // removing the bodyLimit leaves a streamed-oversize test green).
  it("a declared Content-Length above the ceiling is refused without reading", async () => {
    const res = await mediaTranscribeApp.request("/transcribe", {
      method: "POST",
      headers: {
        "x-test-user": "user-1",
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_TRANSCRIBE_BYTES + 2 * 1024 * 1024),
      },
      body: "--x--",
    });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("audio_too_large");
  });

  it("requires a session", async () => {
    const res = await mediaTranscribeApp.request("/transcribe", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/media/transcribe", () => {
  const get = () =>
    mediaTranscribeApp.request("/transcribe", {
      headers: { "x-test-user": "user-1" },
    });

  it("reports the IS's availability", async () => {
    fetchMock.mockResolvedValue(
      isAnswer(200, {
        available: true,
        model: "whisper-large-v3-turbo",
        provider: "groq",
      })
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      model: "whisper-large-v3-turbo",
      provider: "groq",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://is.test/api/transcribe");
  });

  it("an older IS (404) is unavailable with the reason", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect(await (await get()).json()).toEqual({
      available: false,
      model: null,
      provider: null,
      reason: "is_route_missing",
    });
  });

  it("an unreachable IS is a 502 — not a calm `available: false`", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await get();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("intelligence_unreachable");
  });

  it("an IS 500 is a 502 too", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    expect((await get()).status).toBe(502);
  });
});
