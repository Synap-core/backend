/**
 * TRIPWIRE — every agent-facing door teaches the SAME track sequence.
 *
 * GRP agent-XP diagnosis 2026-09-28: an agent asked to run the business-model
 * method on a project had every track tool on its connector, yet started a
 * free session, because the always-on reflexes never said "track" and the
 * only pointer was a skill it had to choose to load.
 *
 * Work model W1 (2026-10-11): a track is a LASTING intent with a goal; stages
 * are optional and legacy. The sequence, in order: find the project's tracks
 * (`list_tracks`) → start one (`start_track`) → work in it with a session
 * (`start_session` + `trackId`). Stage tools are LEGACY: the always-on WORK
 * reflex never names them, and wherever a skill does, the same paragraph says
 * "legacy" — and a track is never advanced (`advance_track`) without the user.
 *
 * Scanned: reflexes.md (the MCP `instructions` SSOT — its WORK reflex, line
 * "4. "), concepts.md (the one glossary, always-on in the IS), from-intent.md
 * (the "pursue a goal" pointer). Tool names are compared as STEMS, so the
 * `synap_` prefix from-intent uses and the bare stems the others use both count.
 *
 * Does NOT cover: the deployed pod (skills are seeded at boot), the IS baseline
 * mirror (IS drift test), the CLI copy (`skills-baseline-parity.test.ts` in
 * synap-cli), or the Control Plane's generated copy
 * (`mcp-pod-tools-drift.test.ts` in synap-control-plane-api). Nor does it
 * judge the prose around the tokens — only that the tokens appear, in order,
 * and that a stage tool is never taught outside a "legacy" paragraph.
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
    "%s: list_tracks → start_track → start_session + trackId",
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
      // Work in the track: `start_session` WITH `trackId` in the same
      // clause (≤ 40 chars apart, one line), after `start_track`.
      const work = text
        .slice(start)
        .search(/`start_session`[^\n]{0,40}`trackId`/);
      expect(
        work,
        "`start_session` + `trackId` (work in the track) follows `start_track`"
      ).toBeGreaterThanOrEqual(0);
    }
  );

  it.each(SOURCES)(
    "%s: stage tools are taught only as LEGACY, and never advanced without the user",
    (_name, get) => {
      const paragraphs = get().split(/\n\s*\n/);
      for (const tool of ["start_stage_session", "advance_track"]) {
        for (const p of paragraphs.filter((x) =>
          x.includes("`" + tool + "`")
        )) {
          expect(p, `\`${tool}\` outside a legacy paragraph`).toMatch(
            /legacy/i
          );
        }
      }
      for (const p of paragraphs.filter((x) => x.includes("`advance_track`"))) {
        expect(p).toMatch(
          /`advance_track` only with the user|never `advance_track` without the user/
        );
      }
    }
  );

  it("the always-on WORK reflex names no stage tool at all", () => {
    const work = SOURCES[0]![1]();
    expect(work).toContain("TRACK");
    expect(work).not.toContain("`start_stage_session`");
    expect(work).not.toContain("`advance_track`");
  });

  it("self-check: the legacy scan can still see a stage tool (non-vacuity)", () => {
    // from-intent keeps the legacy paragraph — if it vanished, the scan above
    // would pass over nothing.
    const fromIntent = SOURCES[2]![1]();
    expect(fromIntent).toContain("`start_stage_session`");
    expect(fromIntent).toContain("`advance_track`");
  });
});
