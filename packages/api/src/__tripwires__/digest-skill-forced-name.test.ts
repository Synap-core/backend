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
 *
 * BODY CONTRACT (added after a real incident).
 *
 * Guarding only the heading proved insufficient: the classify→propose feature
 * (F1) was authored into the IS MIRROR (`apps/intelligence-hub/src/skills/
 * baseline/synap/digesting-a-channel.md`) instead of this SoT. The mirror is
 * regenerated FROM this file by `sync-baseline-skills.mjs` (predev + Docker),
 * so the feature was one `pnpm dev` away from being silently deleted, and the
 * heading tripwire stayed green the whole time.
 *
 * So we also assert the SoT BODY still carries the contract the runtime needs:
 * the `propose_channel_bind` tool name and an unbound-channel classification
 * instruction. These are semantic assertions (tool name + concept keywords),
 * NOT exact prose — reword the skill freely, just keep the contract.
 */

// The bridge's forced-skill `skillName` for channel digests — the contract value.
const FORCED_SKILL_NAME = "digesting-a-channel";

// The governed tool the skill must instruct the agent to call for a channel bind.
// Registered IS-side in `apps/intelligence-hub/src/tools/tool-registry.ts`.
const BIND_TOOL = "propose_channel_bind";

// packages/api/src/__tripwires__ -> src -> api -> packages -> synap-backend root
const skillPath = fileURLToPath(
  new URL("../../../../skills/synap/digesting-a-channel.md", import.meta.url)
);

// Teaching-metadata SSOT — `ensureSystemSkills` projects `teachesTools` onto the
// seeded skill row, and the IS bundled catalog reads the synced copy.
const teachingPath = fileURLToPath(
  new URL("../../../../skills/_teaching.json", import.meta.url)
);
const TEACHING_KEY = "synap/digesting-a-channel";

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

describe("tripwire: digest skill classify→propose body contract (SoT, not the mirror)", () => {
  const body = readFileSync(skillPath, "utf-8");

  it(`names the governed bind tool "${BIND_TOOL}"`, () => {
    expect(
      body.includes(BIND_TOOL),
      `The SoT skill must instruct the agent to call \`${BIND_TOOL}\`. If this ` +
        `fails, the classify→propose feature likely lives only in the IS mirror ` +
        `(src/skills/baseline/synap/digesting-a-channel.md) — which is REGENERATED ` +
        `from this file by sync-baseline-skills.mjs and will be wiped. Port it here.`
    ).toBe(true);
  });

  it("instructs classification of an UNBOUND channel", () => {
    // Semantic, not prose-exact: the concept must be present in some form.
    expect(
      /unbound/i.test(body),
      "The SoT skill must cover the UNBOUND-channel case (a channel not yet " +
        "bound to any entity) — that is the trigger for classify→propose."
    ).toBe(true);
    expect(
      /classif/i.test(body),
      "The SoT skill must instruct the agent to CLASSIFY the unbound channel " +
        "(client / partner / internal team / project) before proposing a bind."
    ).toBe(true);
  });

  it("carries the bind payload contract (contextObjectId + branchPurpose)", () => {
    for (const field of ["contextObjectId", "branchPurpose"]) {
      expect(
        body.includes(field),
        `The SoT skill must name \`${field}\` — it is part of the ${BIND_TOOL} ` +
          `payload the agent has to fill in.`
      ).toBe(true);
    }
  });

  it("keeps the client-comms firewall warning", () => {
    expect(
      body.includes("client-comms"),
      "The SoT skill must keep the `client-comms` firewall rule: that purpose is " +
        "IRREVERSIBLE, so it may only be suggested when the channel is confidently " +
        "client-facing. Dropping this warning invites misfiled internal channels."
    ).toBe(true);
  });

  it(`declares "${BIND_TOOL}" in _teaching.json teachesTools`, () => {
    const teaching = JSON.parse(readFileSync(teachingPath, "utf-8")) as Record<
      string,
      { teachesTools?: string[] } | undefined
    >;
    const entry = teaching[TEACHING_KEY];
    expect(
      entry,
      `_teaching.json is missing the "${TEACHING_KEY}" entry.`
    ).toBeDefined();
    expect(
      entry?.teachesTools ?? [],
      `"${TEACHING_KEY}".teachesTools must list \`${BIND_TOOL}\` — ensureSystemSkills ` +
        `projects it onto the seeded skill row, which is how the tool is discoverable ` +
        `from the skill.`
    ).toContain(BIND_TOOL);
  });
});
