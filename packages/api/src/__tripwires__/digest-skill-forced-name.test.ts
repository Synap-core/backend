import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

/**
 * FORCED-SKILL CONTRACT tripwire.
 *
 * The Discord bridge sends `skillName: "digesting-a-channel"` on channel-digest
 * turns. The backend forwards it verbatim as `forcedSkillName`, and the IS
 * `loadForcedSkillContent` resolves it by matching an APPROVED skill's NAME
 * (case-sensitive first, then case-insensitive) against that string. A seeded
 * `system/*` skill's `name` is derived by `ensureSystemSkills`' `extractTitle`
 * from the file's FIRST `#`/`##` markdown heading (regex `/^#{1,2}\s+(.+)$/m`).
 *
 * Therefore the first heading of `skills/synap/digesting-a-channel.md` MUST be
 * exactly `digesting-a-channel`. If it drifts (a rename, a prepended heading),
 * force-load silently resolves to EMPTY and the digest turn runs with no skill —
 * the exact bug this file exists to catch. This string is a cross-repo contract:
 * do not "clean it up" into a prose title.
 */

// The bridge's forced-skill `skillName` for channel digests — the contract value.
const FORCED_SKILL_NAME = "digesting-a-channel";

// packages/api/src/__tripwires__ -> src -> api -> packages -> synap-backend root
const skillPath = fileURLToPath(
  new URL("../../../../skills/synap/digesting-a-channel.md", import.meta.url)
);

/** Mirrors `extractTitle` in services/capabilities/ensure-system-skills.ts. */
function firstHeading(body: string): string | null {
  const match = body.match(/^#{1,2}\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

describe("tripwire: digest forced-skill name contract", () => {
  it("skills/synap/digesting-a-channel.md exists", () => {
    expect(
      existsSync(skillPath),
      "The channel-digest skill file is missing — the Discord bridge's " +
        `forced skill "${FORCED_SKILL_NAME}" would resolve to EMPTY.`
    ).toBe(true);
  });

  it(`its first markdown heading is exactly "${FORCED_SKILL_NAME}"`, () => {
    const body = readFileSync(skillPath, "utf-8");
    expect(
      firstHeading(body),
      "The first heading is the seeded skill row's NAME (via extractTitle) and " +
        `must equal the bridge's forced skillName "${FORCED_SKILL_NAME}".`
    ).toBe(FORCED_SKILL_NAME);
  });
});
