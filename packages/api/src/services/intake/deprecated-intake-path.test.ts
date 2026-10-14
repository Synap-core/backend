/**
 * `deprecated_intake_path` — the Capture → Library deprecation is MEASURED:
 * a person's door sending a link / file / page to Capture records one event
 * per registry row; the agent door records nothing. And the two capture doors
 * that still accept such input both call the recorder (wiring scan: it pins
 * that each procedure body calls it with its own door name — it cannot see
 * whether the call sits on every branch).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPRECATED_INTAKE_PATHS } from "@synap-core/types/intake-route";
import {
  DEPRECATED_INTAKE_PATH_EVENT,
  deprecatedCapturePaths,
  recordDeprecatedIntakePaths,
} from "./deprecated-intake-path.js";

const podRows = new Set(
  DEPRECATED_INTAKE_PATHS.filter((p) => p.host === "pod").map((p) => p.id)
);

describe("deprecated_intake_path", () => {
  it("names only real pod registry rows", () => {
    const all = [
      ...deprecatedCapturePaths("structure", {
        url: "u",
        file: {},
        html: "<p>",
      }),
      ...deprecatedCapturePaths("thought", { url: "u" }),
    ];
    expect(all).toEqual([
      "capture.url",
      "capture.file",
      "capture.html",
      "capture.thought.url",
    ]);
    for (const id of all) expect(podRows.has(id), id).toBe(true);
    expect(deprecatedCapturePaths("structure", {})).toEqual([]);
  });

  it("a person's door records one event per path, naming the caller", async () => {
    const events: Array<{
      type: string;
      data: Record<string, unknown>;
      userId: string;
    }> = [];
    const recorded = await recordDeprecatedIntakePaths(
      { userId: "u1", keyType: "user_pat", client: "raycast" },
      ["capture.url", "capture.file"],
      async (e) => void events.push(e)
    );
    expect(recorded).toEqual(["capture.url", "capture.file"]);
    expect(
      events.map((e) => [
        e.type,
        e.data.pathId,
        e.data.keyType,
        e.data.client,
        e.userId,
      ])
    ).toEqual([
      [
        DEPRECATED_INTAKE_PATH_EVENT,
        "capture.url",
        "user_pat",
        "raycast",
        "u1",
      ],
      [
        DEPRECATED_INTAKE_PATH_EVENT,
        "capture.file",
        "user_pat",
        "raycast",
        "u1",
      ],
    ]);
  });

  it("the agent door (agent key or IS internal key) records nothing", async () => {
    const events: unknown[] = [];
    const append = async (e: unknown) => void events.push(e);
    expect(
      await recordDeprecatedIntakePaths(
        { userId: "u1", agentUserId: "a1" },
        ["capture.url"],
        append
      )
    ).toEqual([]);
    expect(
      await recordDeprecatedIntakePaths(
        { userId: "u1", keyType: "is_internal" },
        ["capture.url"],
        append
      )
    ).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a failed record never fails the capture", async () => {
    await expect(
      recordDeprecatedIntakePaths(
        { userId: "u1" },
        ["capture.url"],
        async () => {
          throw new Error("db down");
        }
      )
    ).resolves.toEqual([]);
  });

  it("both capture doors call the recorder with their own door", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../routers/capture.ts", import.meta.url)),
      "utf8"
    );
    for (const door of ["structure", "thought"]) {
      const at = src.indexOf(`\n  ${door}: podProcedure`);
      expect(at, door).toBeGreaterThan(0);
      const next = src.indexOf("\n  }),", at);
      const body = src.slice(at, next > at ? next : undefined);
      expect(body, door).toContain(`deprecatedCapturePaths("${door}", input)`);
      expect(body, door).toContain("recordDeprecatedIntakePaths(");
    }
  });
});
