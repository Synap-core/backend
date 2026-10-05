/**
 * Media transcription REST door (Hono) — synchronous speech-to-text for client
 * dictation (desktop composer, relay).
 *
 * REST because tRPC doesn't carry multipart/form-data (same reason as
 * `file-upload.ts`). The client talks to the POD; the pod talks to the IS over
 * Hub Protocol (`IntelligenceHubClient.transcribe` → IS `POST /api/transcribe`).
 * Clients never reach the IS directly.
 *
 *   GET  /api/media/transcribe
 *     200 { available: boolean, model: string|null, provider: string|null,
 *           reason?: "is_route_missing" }
 *     502 { code: "intelligence_unreachable" | "is_auth_error", error }
 *
 *   POST /api/media/transcribe   multipart: file (audio/*), language? (ISO-639-1)
 *     200 { text, language?, durationMs?, model, provider }
 *     400 { code: "invalid_request" }          — no `file` part
 *     413 { code: "audio_too_large", maxBytes } — above MAX_TRANSCRIBE_BYTES
 *     415 { code: "unsupported_audio_type" }  — not audio/*, or undecodable
 *     429 { code: "llm_budget_exceeded" }
 *     502 { code: "transcription_provider_failed" | "intelligence_unreachable"
 *                 | "is_auth_error" | "is_invalid_response" }
 *     503 { code: "transcription_not_configured" }
 *
 * Auth: Kratos session (cookie or X-Session-Token) — the same middleware as
 * `/api/chat/*` and `/api/files/*`; guests are refused.
 *
 * Stores nothing: dictation is ephemeral input. A voice memo meant to be KEPT
 * goes through capture (`file` → IS `/api/structure`), which transcribes with
 * the same IS provider resolution.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createLogger } from "@synap-core/core";
import { authMiddleware } from "@synap/auth";
import {
  IntelligenceAuthError,
  resolveIntelligenceService,
} from "@synap/intelligence-client";
import { refuseGuestSession } from "../access/guest-containment.js";

const logger = createLogger({ module: "media-transcribe" });

/** Matches the IS / Groq / OpenAI upload ceiling. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/** Whole-request ceiling, enforced BEFORE `parseBody` buffers anything: the
 *  audio cap plus room for the multipart envelope. The exact per-file check
 *  below still names the audio size. */
const MAX_REQUEST_BYTES = MAX_TRANSCRIBE_BYTES + 1024 * 1024;

function audioTooLarge(c: Context) {
  return c.json(
    {
      code: "audio_too_large",
      error: `Audio exceeds ${MAX_TRANSCRIBE_BYTES} bytes`,
      maxBytes: MAX_TRANSCRIBE_BYTES,
    },
    413
  );
}

/** IS refusals passed through with their own status — each is a named state
 *  the client can act on. Anything else the IS says is a 502. */
const PASSTHROUGH_STATUS: Readonly<
  Record<string, 413 | 415 | 429 | 502 | 503>
> = {
  transcription_not_configured: 503,
  transcription_provider_failed: 502,
  llm_budget_exceeded: 429,
  audio_too_large: 413,
  unsupported_audio_type: 415,
};

export const mediaTranscribeApp = new Hono<{
  Variables: {
    userId: string;
    user: { id: string; email: string; name?: string };
    authenticated: boolean;
  };
}>();

mediaTranscribeApp.use("/*", authMiddleware);
mediaTranscribeApp.use("/*", refuseGuestSession);

function unreachable(c: Context, err: unknown) {
  if (err instanceof IntelligenceAuthError) {
    return c.json(
      {
        code: "is_auth_error",
        error: "The Intelligence Service rejected this pod's credentials",
      },
      502
    );
  }
  logger.warn({ err }, "transcription: Intelligence Service unreachable");
  return c.json(
    {
      code: "intelligence_unreachable",
      error: "The Intelligence Service could not be reached",
    },
    502
  );
}

mediaTranscribeApp.get("/transcribe", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  try {
    const { client } = await resolveIntelligenceService({ userId });
    return c.json(await client.transcriptionStatus());
  } catch (err) {
    return unreachable(c, err);
  }
});

mediaTranscribeApp.post(
  "/transcribe",
  bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: audioTooLarge }),
  async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.["file"];
    if (!(file instanceof File)) {
      return c.json(
        {
          code: "invalid_request",
          error: "file is required (multipart file field)",
        },
        400
      );
    }
    if (file.size > MAX_TRANSCRIBE_BYTES) return audioTooLarge(c);
    const mimeType = file.type || "";
    if (!mimeType.toLowerCase().startsWith("audio/")) {
      return c.json(
        {
          code: "unsupported_audio_type",
          error: `Expected audio/*, got ${mimeType || "no type"}`,
        },
        415
      );
    }
    const languageRaw = body?.["language"];
    const language =
      typeof languageRaw === "string" && languageRaw.trim()
        ? languageRaw.trim()
        : undefined;

    const content = Buffer.from(await file.arrayBuffer()).toString("base64");

    let outcome;
    try {
      const { client } = await resolveIntelligenceService({ userId });
      outcome = await client.transcribe(
        { content, mimeType, ...(language ? { language } : {}) },
        { signal: c.req.raw.signal }
      );
    } catch (err) {
      return unreachable(c, err);
    }

    if (outcome.ok) {
      const { ok: _ok, ...result } = outcome;
      return c.json(result);
    }

    // An IS build without the route cannot transcribe: that is "not
    // configured" for the client, with the real cause named.
    const code =
      outcome.code === "is_route_missing"
        ? "transcription_not_configured"
        : outcome.code;
    const status = PASSTHROUGH_STATUS[code] ?? 502;
    logger.warn(
      { isStatus: outcome.status, isCode: outcome.code, status },
      "transcription refused by the Intelligence Service"
    );
    return c.json(
      {
        code: PASSTHROUGH_STATUS[code] ? code : "is_invalid_response",
        error: outcome.error,
        ...(outcome.code === "is_route_missing"
          ? { reason: "is_route_missing" }
          : {}),
      },
      status
    );
  }
);
