/**
 * TRIPWIRE — an agent learns about a person's "Never" before it meets one.
 *
 * A `deny` rule (0381) refuses an agent's act with `DENIED_BY_RULE`. Until
 * this guard, the capability tools' texts and the governance skill never named
 * it, so an agent met it only as a refusal and could read it as one more
 * obstacle to route around. Both capability tools and the always-on governance
 * skill now carry the refusal's own sentence (`DENIED_BY_RULE_REASON`), so
 * what the agent reads before and after is one wording.
 *
 * The tool texts are read from `tools.list()` (what the manifest serializes);
 * the skill from its topic file and from the generated `synap/SKILL.md`, so a
 * rebuild that was never run is caught.
 *
 * WHAT IT CANNOT SEE: the IS and CLI mirrors of the skill (sibling repos).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DENIED_BY_RULE,
  DENIED_BY_RULE_REASON,
} from "@synap/governance-policy";
import { tools } from "../routers/mcp/tools/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");

/** The sentence after the code: what the person's "Never" means for the agent. */
const MEANING = DENIED_BY_RULE_REASON.slice(`${DENIED_BY_RULE}: `.length);

describe("tripwire: agents are told about a person's Never", () => {
  it("SELF-GUARD: the meaning is the reason's own sentence, not empty", () => {
    expect(DENIED_BY_RULE_REASON.startsWith(`${DENIED_BY_RULE}: `)).toBe(true);
    expect(MEANING).toMatch(/said never/);
  });

  it.each(["synap_run_capability", "synap_list_capabilities"])(
    "%s names DENIED_BY_RULE with the refusal's own sentence",
    async (name) => {
      const tool = (await tools.list()).find((t) => t.name === name);
      expect(tool, `${name} is not in tools.list()`).toBeDefined();
      expect(tool!.description).toContain(DENIED_BY_RULE_REASON);
    }
  );

  it.each(["synap/governance-rules.md", "synap/SKILL.md"])(
    "%s teaches DENIED_BY_RULE in the refusal's own words",
    (file) => {
      const text = readFileSync(resolve(SKILLS_DIR, file), "utf8");
      expect(text).toContain(DENIED_BY_RULE);
      expect(text).toContain(MEANING);
    }
  );
});
