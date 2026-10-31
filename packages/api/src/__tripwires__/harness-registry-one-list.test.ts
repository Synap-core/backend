/**
 * TRIPWIRE: the AI clients a person connects (harnesses) are listed ONCE, in
 * `@synap-core/types/agents` (`AGENT_HARNESSES`).
 *
 * The API's surface allowlist, the reopenable-conversation list and the device
 * door's enum were three copies of one fact, and Claude Code had four slugs
 * across the repos. Backend code now reads the registry; this holds it there:
 *
 *  1. `setup.ts` exports `SURFACE_AGENT_TYPES` as the registry's list;
 *  2. no backend source (derived: every .ts under `packages/*` and `apps/*`
 *     but tests, build output and the name registry) spells the registry's
 *     distinctive slugs as string literals, builds its own reopen command, or
 *     brings back the retired `AGENT_CONVERSATION_HARNESSES`.
 *
 * Each forbidden pattern is checked against a literal sample so a loosened
 * regex cannot go blind. WHAT IT DOES NOT SEE: another repo's copy (synap-cli
 * `SURFACE_NAMES`, Raycast, Eve) and a list built from unrelated words.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const SKIP = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "__tripwires__",
  "generated",
]);
/** The registry itself, and the service-name registry that names the same ids. */
const OWNERS = [
  join("packages", "types", "src", "agents", "harnesses.ts"),
  join("packages", "types", "src", "service-marks", "index.ts"),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    if (SKIP.has(e)) return [];
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(e) && !/\.(test|d)\.tsx?$/.test(e) ? [full] : [];
  });
}

const FILES = ["packages", "apps"]
  .flatMap((d) => sources(join(REPO, d)))
  .map((f) => ({ path: relative(REPO, f), raw: readFileSync(f, "utf8") }))
  .filter((f) => !OWNERS.includes(f.path))
  .map((f) => ({ path: f.path, src: stripComments(f.raw, "ts") }));

const FORKS: Array<{ name: string; re: RegExp; sample: string }> = [
  {
    name: "a harness slug listed again",
    re: /["']claude-desktop["']/,
    sample: 'const T = ["claude-code", "claude-desktop"]',
  },
  {
    name: "a harness list in the registry's order",
    re: /["']cursor["']\s*,\s*["']raycast["']/,
    sample: 'const T = ["cursor", "raycast"]',
  },
  {
    name: "a hand-built reopen command",
    re: /claude --resume/,
    sample: "`claude --resume ${id}`",
  },
  {
    name: "the retired conversation-harness list",
    re: /AGENT_CONVERSATION_HARNESSES/,
    sample: "export const AGENT_CONVERSATION_HARNESSES = [",
  },
];

describe("harness registry: one list", () => {
  it("scans a plausible, derived set of files", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.map((f) => f.path)).toContain(
      join("packages", "types", "src", "agents", "conversation.ts")
    );
  });

  it("setup.ts exports the registry's surface list, not its own", () => {
    const setup = FILES.find((f) => f.path.endsWith(join("rest", "setup.ts")));
    expect(setup?.src).toMatch(
      /SURFACE_AGENT_TYPES\s*=\s*SURFACE_HARNESS_SLUGS/
    );
  });

  it.each(FORKS)("no source re-lists: $name", ({ re, sample }) => {
    expect(re.test(sample)).toBe(true);
    expect(FILES.filter((f) => re.test(f.src)).map((f) => f.path)).toEqual([]);
  });
});
