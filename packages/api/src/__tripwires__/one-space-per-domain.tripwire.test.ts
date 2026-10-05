/**
 * TRIPWIRE — every AI door teaches ONE SPACE PER DOMAIN, in the one wording
 * (`services/one-space-per-domain.ts`).
 *
 * The doors are DERIVED, never listed:
 *   - every skill TOPIC that teaches creating a space (names `create_workspace`
 *     or `packages/apply`) — a new topic that starts teaching creation joins
 *     the scan by existing;
 *   - the skill `orient` sends agents to for the lens model
 *     (`ORIENT_LEARN_MORE_SKILL`);
 *   - the live MCP `instructions` (read off a real `createMCPServer`) of every
 *     key profile whose tool list can create a space.
 * Plus: every tool the rule names is an advertised MCP tool (the rule never
 * points at a dead door).
 *
 * What it cannot see: a door that teaches creation in other words ("spin up a
 * domain") without naming either tool; the IS prompt section (own repo,
 * mirrored by its own tripwire); the CP connector's static copy of the
 * reflexes (synap-control-plane-api, not this repo).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import {
  ONE_SPACE_PER_DOMAIN_REFLEX,
  ONE_SPACE_PER_DOMAIN_RULE,
} from "../services/one-space-per-domain.js";
import { ORIENT_LEARN_MORE_SKILL } from "../services/discover/discover.js";
import { createMCPServer } from "../routers/mcp/index.js";
import { tools } from "../routers/mcp/tools/index.js";
import { ENTRY_TOOLS } from "../routers/mcp/tool-profiles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");

/** Source topic files: a package assembled by build.mjs (`_order.txt`) ⇒ its
 * topics (its SKILL.md is generated); otherwise its SKILL.md IS the source. */
function topicFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const dir = join(SKILLS_DIR, pkg.name);
    const assembled = existsSync(join(dir, "_order.txt"));
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      if (assembled && f === "SKILL.md") continue;
      if (!assembled && f !== "SKILL.md") continue;
      out.push(join(pkg.name, f));
    }
  }
  return out.sort();
}

const TEACHES_CREATION = /create_workspace|packages\/apply/;
const read = (rel: string) => readFileSync(join(SKILLS_DIR, rel), "utf8");

const liveInstructions = (profile: "entry" | "full"): string => {
  const server = createMCPServer(
    undefined,
    "u1",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    profile
  ) as unknown as { _instructions?: string };
  if (typeof server._instructions !== "string") {
    throw new Error(
      "SDK Server no longer exposes _instructions — update this seam"
    );
  }
  return server._instructions;
};

describe("one space per domain — every AI door carries the rule", () => {
  const topics = topicFiles();
  const creationTopics = topics.filter((t) => TEACHES_CREATION.test(read(t)));

  it("the scan sees the skills tree (non-vacuity)", () => {
    expect(topics.length).toBeGreaterThan(40);
    expect(TEACHES_CREATION.test("freehand `create_workspace` is last")).toBe(
      true
    );
    // The known teachers are found by the DERIVATION (not asserted as the set).
    expect(creationTopics).toEqual(
      expect.arrayContaining(["agent-os/SKILL.md", "synap/workspace-design.md"])
    );
  });

  it("every skill topic that teaches creating a space states the rule verbatim", () => {
    const missing = creationTopics.filter(
      (t) => !read(t).includes(ONE_SPACE_PER_DOMAIN_RULE)
    );
    expect(missing).toEqual([]);
  });

  it("the lens skill orient points agents to states the rule verbatim", () => {
    const rel = `${ORIENT_LEARN_MORE_SKILL.replace(/^system\//, "")}.md`;
    expect(read(rel)).toContain(ONE_SPACE_PER_DOMAIN_RULE);
  });

  it("the live MCP instructions of every key profile that can create a space carry the reflex", async () => {
    const advertised = (await tools.list()).map((t) => t.name);
    const profiles: Array<{ name: "entry" | "full"; tools: string[] }> = [
      { name: "entry", tools: [...ENTRY_TOOLS] },
      { name: "full", tools: advertised },
    ];
    const creating = profiles.filter((p) =>
      p.tools.includes("synap_create_workspace")
    );
    expect(creating.map((p) => p.name)).toContain("full"); // non-vacuity
    for (const p of creating) {
      expect(liveInstructions(p.name)).toContain(ONE_SPACE_PER_DOMAIN_REFLEX);
    }
  });

  it("every tool the rule names is an advertised MCP tool", async () => {
    const advertised = new Set((await tools.list()).map((t) => t.name));
    const named = [
      ...`${ONE_SPACE_PER_DOMAIN_RULE} ${ONE_SPACE_PER_DOMAIN_REFLEX}`.matchAll(
        /`([a-z_]+)`/g
      ),
    ].map((m) => `synap_${m[1]}`);
    expect(named.length).toBeGreaterThanOrEqual(2);
    expect(named.filter((n) => !advertised.has(n))).toEqual([]);
  });
});
