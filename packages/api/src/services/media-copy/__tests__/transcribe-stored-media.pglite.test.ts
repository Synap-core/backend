/**
 * `transcribeStoredMedia` over a real `documents` table (PGlite): the
 * owner-floored read, the type and size gates, and how every IS answer maps —
 * a refusal is never folded into an empty transcript.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { db as DatabaseHandle } from "@synap/database";
import * as schema from "@synap/database/schema";
import {
  transcribeStoredMedia,
  TRANSCRIBE_STORED_MEDIA_MAX_BYTES,
} from "../transcribe-stored-media.js";
import { LIGHT_READ_FILE_BYTES_MAX } from "../../library/light-read.js";

let client: PGlite;
let database: typeof DatabaseHandle;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`create table documents (
    id uuid primary key, user_id text, workspace_id uuid, storage_key text,
    mime_type text, size integer, deleted_at timestamptz)`);
  database = drizzle(client, { schema }) as unknown as typeof DatabaseHandle;
}, 60_000);

async function doc(over: {
  user?: string;
  mime?: string;
  size?: number;
  deleted?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents values ($1, $2, null, $3, $4, $5, $6)`,
    [
      id,
      over.user ?? "u1",
      `files/pod/${id}/v`,
      over.mime ?? "video/mp4",
      over.size ?? 1000,
      over.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

const download = vi.fn(async () => Buffer.from("fake-mp4-bytes"));

describe("transcribeStoredMedia", () => {
  it("sends the stored video as it is and returns the transcript", async () => {
    const id = await doc({});
    const transcribe = vi.fn(async () => ({
      ok: true as const,
      text: "  hello from the reel ",
      language: "en",
    }));
    expect(
      await transcribeStoredMedia(id, "u1", { database, download, transcribe })
    ).toEqual({ text: "hello from the reel", lang: "en" });
    expect(transcribe).toHaveBeenCalledWith("u1", null, {
      content: Buffer.from("fake-mp4-bytes").toString("base64"),
      mimeType: "video/mp4",
    });
  });

  it("owner floor, liveness and type gates — nothing is downloaded", async () => {
    const transcribe = vi.fn();
    download.mockClear();
    const theirs = await doc({ user: "u2" });
    const deleted = await doc({ deleted: true });
    const image = await doc({ mime: "image/png" });
    const mkv = await doc({ mime: "video/x-matroska" });
    const big = await doc({ size: TRANSCRIBE_STORED_MEDIA_MAX_BYTES + 1 });
    const deps = { database, download, transcribe: transcribe as never };
    expect(await transcribeStoredMedia(theirs, "u1", deps)).toEqual({
      failed: "not_found",
    });
    expect(await transcribeStoredMedia(deleted, "u1", deps)).toEqual({
      failed: "not_found",
    });
    expect(await transcribeStoredMedia(randomUUID(), "u1", deps)).toEqual({
      failed: "not_found",
    });
    expect(await transcribeStoredMedia(image, "u1", deps)).toEqual({
      failed: "not_media",
    });
    expect(await transcribeStoredMedia(mkv, "u1", deps)).toEqual({
      failed: "not_media",
    });
    expect(await transcribeStoredMedia(big, "u1", deps)).toEqual({
      failed: "too_large",
    });
    expect(download).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("maps every IS answer to a named failure — never an empty transcript", async () => {
    const id = await doc({ mime: "audio/mpeg" });
    const run = (answer: unknown) =>
      transcribeStoredMedia(id, "u1", {
        database,
        download,
        transcribe: (async () => answer) as never,
      });
    expect(await run({ ok: true, text: "   " })).toEqual({ failed: "empty" });
    expect(
      await run({
        ok: false,
        status: 503,
        code: "transcription_not_configured",
        error: "no provider",
      })
    ).toMatchObject({ failed: "not_configured" });
    expect(
      await run({
        ok: false,
        status: 404,
        code: "is_route_missing",
        error: "old IS",
      })
    ).toMatchObject({ failed: "not_configured" });
    expect(
      await run({
        ok: false,
        status: 502,
        code: "transcription_provider_failed",
        error: "x",
      })
    ).toMatchObject({ failed: "unavailable" });
    expect(
      await run({
        ok: false,
        status: 429,
        code: "llm_budget_exceeded",
        error: "x",
      })
    ).toMatchObject({ failed: "unavailable" });
    expect(
      await run({
        ok: false,
        status: 415,
        code: "unsupported_audio_type",
        error: "x",
      })
    ).toEqual({ failed: "refused", detail: "unsupported_audio_type" });
    expect(
      await transcribeStoredMedia(id, "u1", {
        database,
        download,
        transcribe: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    ).toEqual({ failed: "unavailable", detail: "ECONNREFUSED" });
  });

  it("its ceiling is the light read's own", () => {
    expect(TRANSCRIBE_STORED_MEDIA_MAX_BYTES).toBe(LIGHT_READ_FILE_BYTES_MAX);
  });
});
