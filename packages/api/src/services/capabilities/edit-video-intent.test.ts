/**
 * The edit_video intent's one input (migration 0370, founder decision
 * ac1ba2b6, 2026-10-28), read by the pod's own input check (`validateInput`).
 * The shape is read out of the migration SQL, not copied, so the test checks
 * what a pod is seeded with. Each case rules out one wrong shape:
 *  - an app sending no video, or a video that is not a string;
 *  - a non-https URL (http, a data: URI, a pod-local path) accepted;
 *  - an extra field (a verb option such as RVM's output type) accepted from
 *    the app instead of set by the verb's own `inputMap` constant.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapIntentInput, validateInput } from "./intent-input.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/services/capabilities → src → api → packages
const SQL = readFileSync(
  resolve(HERE, "../../../../database/migrations/0370_edit_video_intent.sql"),
  "utf8"
);
const literal = SQL.match(/SET "input_schema" = '([\s\S]*?)'::jsonb/)?.[1];
const EDIT_VIDEO = JSON.parse(literal ?? "null") as Record<string, unknown>;

const VIDEO = "https://files.example.com/take-3.mp4";

describe("edit_video — the one input an app sends", () => {
  it("the migration declares a shape (non-vacuity)", () => {
    expect(literal).toBeDefined();
    expect(EDIT_VIDEO).toMatchObject({ type: "object", required: ["video"] });
  });

  it("accepts an https URL of the video", () => {
    expect(validateInput(EDIT_VIDEO, { video: VIDEO })).toEqual({
      ok: true,
      value: { video: VIDEO },
    });
  });

  it.each([
    [{}, "no video"],
    [{ video: 42 }, "not a string"],
    [{ video: "http://files.example.com/take-3.mp4" }, "http"],
    [{ video: "data:video/mp4;base64,AAAA" }, "a data: URI"],
    [{ video: "/files/take-3.mp4" }, "a path"],
    [{ video: VIDEO, output_type: "green-screen" }, "a verb option"],
  ])("refuses %j (%s)", (input) => {
    expect(validateInput(EDIT_VIDEO, input).ok).toBe(false);
  });

  it("a verb's own options come from its map, never from the app", () => {
    // Robust Video Matting on Replicate: input_video + output_type.
    const map = {
      params: {
        input_video: "$.video",
        output_type: { const: "green-screen" },
      },
    };
    expect(mapIntentInput(map, { video: VIDEO })).toEqual({
      input_video: VIDEO,
      output_type: "green-screen",
    });
  });
});
