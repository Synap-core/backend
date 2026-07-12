/**
 * System skill teaching definitions (AI Teaching Substrate Wave 1b, extended Wave 3).
 *
 * One entry per baseline skill topic file (`synap-backend/skills/<package>/<file>.md`),
 * keyed `"<package>/<file-stem>"` (e.g. `"synap/document-embeds"`). This is the data
 * `ensureSystemSkills()` (`ensure-system-skills.ts`) projects onto the seeded `skills`
 * row's `teachesTools` / `skillGroup` / `alwaysOn` columns, and the `summary` field
 * doubles as the row's `description` (its one-line catalog summary).
 *
 * SSOT MOVE (Wave 3): the entries themselves now live in `synap-backend/skills/_teaching.json`
 * — a plain data file with no code, so the IS can sync + read it directly (its
 * `sync-baseline-skills.mjs` copies it alongside the baseline .md files into
 * `apps/intelligence-hub/src/skills/baseline/_teaching.json`, and `skill-loader.ts`'s
 * bundled catalog reads it there). This module now only loads + validates that JSON —
 * edit `_teaching.json`, not this file, to change teaching metadata.
 *
 * Fails LOUD at module init if the JSON is missing or malformed (never silently seed
 * skills with wrong/empty teaching metadata).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export type SystemSkillGroup =
  | "core"
  | "research"
  | "build"
  | "connect"
  | "govern"
  | "feed"
  | "inbox"
  | "show";

export interface SystemSkillTeaching {
  teachesTools: string[];
  skillGroup: SystemSkillGroup;
  alwaysOn: boolean;
  /** One-line catalog summary — becomes the seeded skill row's `description`. */
  summary: string;
}

const SKILL_GROUPS = new Set<string>([
  "core",
  "research",
  "build",
  "connect",
  "govern",
  "feed",
  "inbox",
  "show",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// capabilities -> services -> src -> api -> packages -> synap-backend -> skills/_teaching.json
const TEACHING_JSON_PATH = path.resolve(
  __dirname,
  "../../../../../skills/_teaching.json"
);

function validateEntry(key: string, value: unknown): SystemSkillTeaching {
  if (typeof value !== "object" || value === null) {
    throw new Error(`_teaching.json: entry "${key}" is not an object`);
  }
  const v = value as Record<string, unknown>;
  if (
    !Array.isArray(v.teachesTools) ||
    !v.teachesTools.every((t) => typeof t === "string")
  ) {
    throw new Error(
      `_teaching.json: entry "${key}".teachesTools must be a string[]`
    );
  }
  if (typeof v.skillGroup !== "string" || !SKILL_GROUPS.has(v.skillGroup)) {
    throw new Error(
      `_teaching.json: entry "${key}".skillGroup must be one of ${[...SKILL_GROUPS].join("|")}`
    );
  }
  if (typeof v.alwaysOn !== "boolean") {
    throw new Error(`_teaching.json: entry "${key}".alwaysOn must be boolean`);
  }
  if (typeof v.summary !== "string" || v.summary.length === 0) {
    throw new Error(
      `_teaching.json: entry "${key}".summary must be a non-empty string`
    );
  }
  return {
    teachesTools: v.teachesTools as string[],
    skillGroup: v.skillGroup as SystemSkillGroup,
    alwaysOn: v.alwaysOn,
    summary: v.summary,
  };
}

function loadTeachingDefinitions(): Record<string, SystemSkillTeaching> {
  let raw: string;
  try {
    raw = readFileSync(TEACHING_JSON_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `system-skill-teaching: could not read ${TEACHING_JSON_PATH} — ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `system-skill-teaching: ${TEACHING_JSON_PATH} is not valid JSON — ${(err as Error).message}`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `system-skill-teaching: ${TEACHING_JSON_PATH} must be a JSON object`
    );
  }

  const out: Record<string, SystemSkillTeaching> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (key === "$comment") continue; // SSOT header, not a teaching entry
    out[key] = validateEntry(key, value);
  }
  return out;
}

/** Fail-loud at module init — a malformed teaching file must never seed silently-wrong data. */
export const SYSTEM_SKILL_TEACHING: Record<string, SystemSkillTeaching> =
  loadTeachingDefinitions();
