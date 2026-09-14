/**
 * TRIPWIRE — every tool a skill teaches resolves to a door, or is classified.
 *
 * Skills are served to agents on three doors (pod MCP, claude.ai connector,
 * Raycast). A token that names no pod tool renders verbatim on all of them — the
 * agent reads "call frob_widget" and dead-ends. So every taught token must either
 * resolve to a pod MCP tool (and from there to each door's name, via
 * `DOOR_TOOL_NAMES`) or be deliberately classified in `door-tool-render.ts` as
 * IS-only (with the note it renders) or not-a-door-tool (with what it really is).
 *
 * THE SET IS DERIVED: every `*.md` under `synap-backend/skills/` (README.md
 * excluded — a packaging file, not served), every backtick span, every
 * snake_case/`synap_*` identifier in it that is TOOL-SHAPED:
 *   - `synap_*`, or
 *   - a call form (`name(`), or
 *   - a tool verb prefix (`create_`, `list_`, `get_`, …), or
 *   - already resolvable / already classified.
 *
 * WHAT IT CANNOT SEE (measured by construction, stated honestly):
 *   - a tool named OUTSIDE backticks in prose;
 *   - a bare, backticked, parenthesis-free token with no verb prefix that resolves
 *     nowhere (`widget_frobber`) — indistinguishable from a relation type like
 *     `depends_on`, which this scan must not flag;
 *   - dotted builtin verb ids (`market.search`) — those run through run_capability,
 *     which every door has.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DOOR_TOOL_NAMES } from "../routers/mcp/door-tool-names.generated.js";
import {
  IS_ONLY_TOOL_TOKENS,
  NOT_A_DOOR_TOOL_TOKENS,
  resolveTaughtToolToken,
} from "../services/capability-briefs/door-tool-render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const MANIFEST = resolve(HERE, "../routers/mcp/tools/mcp-tools.manifest.json");

const VERB_PREFIX =
  /^(create|list|get|update|define|promote|run|set|start|load|attach|detach|search|remember|resolve|link|propose|place|record|consolidate|discover|focus|market|generate|trigger|complete|revert|rerun|store|post|send|declare|match|reject|revise)_/;
const TOKEN_RE =
  /\b(synap_[a-z0-9_]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(\s*\()?/g;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return markdownFiles(p);
    return name.endsWith(".md") && name !== "README.md" ? [p] : [];
  });
}

/** token → every skill file (relative) that teaches it. */
function scanTaughtTokens(): {
  files: string[];
  taught: Map<string, string[]>;
} {
  const files = markdownFiles(SKILLS_DIR);
  const taught = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const span of text.matchAll(/`([^`\n]+)`/g)) {
      for (const m of span[1]!.matchAll(TOKEN_RE)) {
        const token = m[1]!;
        const toolShaped =
          token.startsWith("synap_") ||
          Boolean(m[2]) ||
          VERB_PREFIX.test(token) ||
          resolveTaughtToolToken(token) !== null ||
          token in IS_ONLY_TOOL_TOKENS ||
          token in NOT_A_DOOR_TOOL_TOKENS;
        if (!toolShaped) continue;
        const rel = relative(SKILLS_DIR, file);
        const seen = taught.get(token) ?? [];
        if (!seen.includes(rel)) taught.set(token, [...seen, rel]);
      }
    }
  }
  return { files, taught };
}

describe("tripwire: taught tool tokens resolve to a door", () => {
  const { files, taught } = scanTaughtTokens();

  it("the scan is not vacuous and can still see known tokens", () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(taught.size).toBeGreaterThanOrEqual(30);
    // Literal self-check: one of each spelling the resolver handles.
    expect(taught.get("synap_capture")).toContain("synap/capture.md"); // pod name
    expect(taught.get("define_role")).toContain("synap/escalation-ladder.md"); // bare stem
    expect(taught.get("search_unified")).toContain("synap/reading.md"); // IS alias
    expect(taught.get("create_property_def")).toContain(
      "synap-schema/read-before-write.md"
    ); // IS-only
  });

  it("every taught token resolves to a pod tool or is classified", () => {
    const unclassified = [...taught]
      .filter(
        ([t]) =>
          resolveTaughtToolToken(t) === null &&
          !(t in IS_ONLY_TOOL_TOKENS) &&
          !(t in NOT_A_DOOR_TOOL_TOKENS)
      )
      .map(([t, files]) => `${t} (${files.join(", ")})`);
    expect(
      unclassified,
      "A skill teaches a tool no door has. Fix the skill text, add the alias in tool-verb-aliases.ts, or classify it in door-tool-render.ts."
    ).toEqual([]);
  });

  it("classifications are live and never contradict the resolver", () => {
    for (const [token, reason] of Object.entries({
      ...IS_ONLY_TOOL_TOKENS,
      ...NOT_A_DOOR_TOOL_TOKENS,
    })) {
      expect(reason.length, token).toBeGreaterThan(10);
      expect(
        taught.has(token),
        `${token} is classified but no skill teaches it — drop the entry`
      ).toBe(true);
      expect(
        resolveTaughtToolToken(token),
        `${token} now resolves to a pod tool — drop the classification`
      ).toBeNull();
    }
  });

  it("the door table covers exactly the pod manifest, and each resolved token is on ≥1 door", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      tools: Array<{ name: string }>;
    };
    expect(Object.keys(DOOR_TOOL_NAMES).sort()).toEqual(
      manifest.tools.map((t) => t.name).sort()
    );
    const rows = Object.values(DOOR_TOOL_NAMES);
    expect(rows.filter((r) => r["cp-connector"]).length).toBeGreaterThanOrEqual(
      30
    );
    expect(rows.filter((r) => r.raycast).length).toBeGreaterThanOrEqual(20);
    for (const [token] of taught) {
      const pod = resolveTaughtToolToken(token);
      if (pod) expect(DOOR_TOOL_NAMES[pod]!["pod-mcp"], token).toBe(pod);
    }
  });
});
