import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_TOOLS } from "../tool-profiles.js";

/**
 * TOKEN BUDGET RATCHET — a tool definition may shrink, never grow.
 *
 * Every connection that does not defer schemas (Codex, Cursor, the IS) is
 * sent the definitions of its profile on every session: a tool's name +
 * description + inputSchema is what it costs. On 7 Nov 2026 the entry profile
 * measured ~49K tokens, 84% of it five tools (finding 3a849acf). This test
 * pins each tool and the entry profile to `token-budget.baseline.json`, read
 * from the committed manifest (the wire form), and fails when any of them
 * grows past its baseline plus a small slack.
 *
 * TARGET, not a ceiling: 2,000 tokens per tool definition (8,000 chars). The
 * target is lowered over time (founder, 7 Nov 2026); a tool above it passes as
 * long as it does not grow. A NEW tool must come in under the target.
 *
 * Tokens = chars / 4 (an estimate; compact JSON usually tokenizes denser).
 *
 * A tool got smaller and you want the ratchet to follow:
 *   UPDATE_TOKEN_BUDGET=1 pnpm --filter @synap/api exec vitest run src/routers/mcp/tools/token-budget.test.ts
 * and commit the baseline. A tool that GREW: teach the extra on demand in a
 * skill (see `system/synap/asks`) instead of raising the baseline.
 */
const DIR = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(DIR, "token-budget.baseline.json");
export const TARGET_TOOL_CHARS = 8_000;
const SLACK_CHARS = 160; // 40 tokens: a reworded sentence, not a new field
const ENTRY_SLACK_CHARS = 400;

interface WireTool {
  name: string;
  description: string;
  inputSchema: unknown;
}
interface Baseline {
  entryChars: number;
  tools: Record<string, number>;
}

function measure(): { tools: Record<string, number>; entryChars: number } {
  const manifest = JSON.parse(
    readFileSync(resolve(DIR, "mcp-tools.manifest.json"), "utf8")
  ) as { tools: WireTool[] };
  const tools: Record<string, number> = {};
  for (const t of manifest.tools) {
    tools[t.name] = JSON.stringify({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }).length;
  }
  const entryChars = ENTRY_TOOLS.reduce((n, name) => n + (tools[name] ?? 0), 0);
  return { tools, entryChars };
}

const top = (tools: Record<string, number>, n = 8) =>
  Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, c]) => `${name} ${Math.round(c / 4)} tok`)
    .join(", ");

describe("tool definition token budget (ratchet)", () => {
  const now = measure();

  if (process.env.UPDATE_TOKEN_BUDGET === "1") {
    it("rewrites the baseline", () => {
      const sorted = Object.fromEntries(
        Object.entries(now.tools).sort(([a], [b]) => a.localeCompare(b))
      );
      writeFileSync(
        BASELINE_PATH,
        JSON.stringify({ entryChars: now.entryChars, tools: sorted }, null, 2) +
          "\n"
      );
    });
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;

  it("measures every ENTRY tool (a missing one would hide a growth)", () => {
    for (const name of ENTRY_TOOLS) expect(now.tools[name]).toBeGreaterThan(0);
  });

  it("no tool grew past its baseline", () => {
    const grown = Object.entries(now.tools)
      .filter(
        ([name, c]) =>
          name in baseline.tools && c > baseline.tools[name]! + SLACK_CHARS
      )
      .map(
        ([name, c]) =>
          `${name}: ${Math.round(baseline.tools[name]! / 4)} -> ${Math.round(c / 4)} tok`
      );
    expect(
      grown,
      `Tool definitions grew (target ${TARGET_TOOL_CHARS / 4} tok each, never up). Teach the extra on demand in a skill. Top now: ${top(now.tools)}`
    ).toEqual([]);
  });

  it("a new tool is in the baseline and under the 2K-token target", () => {
    const fresh = Object.entries(now.tools).filter(
      ([n]) => !(n in baseline.tools)
    );
    expect(
      fresh.map(([n]) => n),
      "new tool: run the UPDATE_TOKEN_BUDGET=1 command in this file's header and commit the baseline"
    ).toEqual([]);
    const gone = Object.keys(baseline.tools).filter((n) => !(n in now.tools));
    expect(gone, "tool removed: update the baseline").toEqual([]);
  });

  it("the entry profile did not grow past its baseline", () => {
    expect(
      now.entryChars,
      `entry profile ${Math.round(now.entryChars / 4)} tok vs baseline ${Math.round(baseline.entryChars / 4)}. Top: ${top(now.tools)}`
    ).toBeLessThanOrEqual(baseline.entryChars + ENTRY_SLACK_CHARS);
  });
});
