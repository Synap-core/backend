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
 * Per-entry validation is strict, but module init is NON-fatal: a missing/malformed
 * JSON degrades teaching metadata to empty (with a loud console.error) rather than
 * crashing pod boot at import time — see loadTeachingDefinitionsNonFatal below.
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
// Same resolution order as loadSkillPackagesFromDisk (which provably works in
// the deployed image): cwd()/skills first (/app/api/skills in the Docker
// runner), then the repo-relative path for monorepo dev, where __dirname is
// src/… (in the bundled build __dirname is dist/ and the relative hop is
// wrong — that was the prod bug that silently seeded empty teaching fields).
const TEACHING_JSON_CANDIDATES = [
  path.join(process.cwd(), "skills/_teaching.json"),
  path.resolve(__dirname, "../../../../../skills/_teaching.json"),
];
const TEACHING_JSON_PATH =
  TEACHING_JSON_CANDIDATES.find((p) => {
    try {
      readFileSync(p, "utf-8");
      return true;
    } catch {
      return false;
    }
  }) ?? TEACHING_JSON_CANDIDATES[0];

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

/**
 * Validation stays strict per entry, but a malformed/missing file must NOT
 * crash the whole pod at import time (this module loads with the @synap/api
 * barrel, long before startup-hooks' try/catch can contain it). Degraded
 * teaching (= no metadata, skills still seed with bodies) beats a pod that
 * won't boot. The IS-side copy is separately validated by its own tests.
 */
function loadTeachingDefinitionsNonFatal(): Record<
  string,
  SystemSkillTeaching
> {
  try {
    return loadTeachingDefinitions();
  } catch (err) {
    console.error(
      `[system-skill-teaching] ${TEACHING_JSON_PATH} unusable — teaching metadata degraded to empty (skills still seed with bodies): ${
        (err as Error).message
      }`
    );
    return {};
  }
}

export const SYSTEM_SKILL_TEACHING: Record<string, SystemSkillTeaching> =
  loadTeachingDefinitionsNonFatal();
