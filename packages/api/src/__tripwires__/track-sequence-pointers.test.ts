/**
 * TRIPWIRE — every agent-facing door teaches the SAME track sequence.
 *
 * GRP agent-XP diagnosis 2026-09-28: an agent asked to run the business-model
 * method on a project had every track tool on its connector, yet started a
 * free session (and ranked the superseded session-scoped twin first), because
 * the always-on reflexes never said "track" and the only pointer was a skill
 * it had to choose to load.
 *
 * The sequence, in order: find the project's tracks (`list_tracks`) → start
 * one (`start_track`) → work each step (`start_stage_session`); a track is
 * never advanced (`advance_track`) without the user.
 *
 * Scanned: reflexes.md (the MCP `instructions` SSOT — its WORK reflex, line
 * "4. "), concepts.md (the one glossary, always-on in the IS), from-intent.md
 * (the "work a method" pointer). Tool names are compared as STEMS, so the
 * `synap_` prefix from-intent uses and the bare stems the others use both count.
 *
 * Does NOT cover: the deployed pod (skills are seeded at boot), the IS baseline
 * mirror (IS drift test), or the Control Plane's generated copy
 * (`mcp-pod-tools-drift.test.ts` in synap-control-plane-api). Nor does it
 * judge the prose around the tokens — only that the tokens appear, in order.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILLS = join(__dirname, "../../../../skills/synap");
const read = (f: string): string =>
  readFileSync(join(SKILLS, f), "utf8").replace(/synap_/g, "");

const SOURCES: Array<[string, () => string]> = [
  [
    "reflexes.md — the WORK reflex",
    () =>
      read("reflexes.md")
        .split("\n")
        .find((l) => l.startsWith("4. ")) ?? "",
  ],
  ["concepts.md", () => read("concepts.md")],
  ["from-intent.md", () => read("from-intent.md")],
];

describe("track sequence reaches every agent door", () => {
  it.each(SOURCES)(
    "%s: list_tracks → start_track → start_stage_session",
    (_name, get) => {
      const text = get();
      expect(text.length, "scan found its text (non-vacuity)").toBeGreaterThan(
        100
      );
      // Each token is looked for AFTER the previous one, so an earlier bare
      // mention (e.g. concepts' "Doors:" list) cannot satisfy the order.
      const find = (t: string, from: number) =>
        text.indexOf("`" + t + "`", from);
      const list = find("list_tracks", 0);
      expect(list, "`list_tracks` is named").toBeGreaterThanOrEqual(0);
      const start = find("start_track", list);
      expect(start, "`start_track` follows `list_tracks`").toBeGreaterThan(
        list
      );
      expect(
        find("start_stage_session", start),
        "`start_stage_session` follows `start_track`"
      ).toBeGreaterThan(start);
    }
  );

  it.each(SOURCES)(
    "%s: a track is advanced only with the user",
    (_name, get) => {
      expect(get()).toMatch(
        /`advance_track` only with the user|never `advance_track` without the user/
      );
    }
  );
});
