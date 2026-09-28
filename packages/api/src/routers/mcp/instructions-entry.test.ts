/**
 * TRIPWIRE — an ENTRY key's MCP `instructions` (V1 D4) name only tools that
 * key lists. The tool set is DERIVED from the live `tools.list()` and
 * `ENTRY_TOOLS`; the text is read back off a real `createMCPServer`, the object
 * the `initialize` response is built from.
 *
 * What it cannot see: a tool named WITHOUT backticks, or by a synonym ("define
 * a kind"). The scan reads backticked stems only — the way the reflexes name
 * every tool today.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import {
  composeInstructions,
  createMCPServer,
  groundingBudgetBytes,
  INSTRUCTIONS_BUDGET_BYTES,
  SYNAP_INSTRUCTIONS,
} from "./index.js";
import { ENTRY_REFLEX_PROSE } from "./entry-instructions.js";
import { formatGrounding } from "./http-handler.js";
import { tools } from "./tools/index.js";
import {
  BUILDER_REF,
  ENTRY_TOOLS,
  TOOL_GROUP_NAMES,
  toolGroupRef,
} from "./tool-profiles.js";

const bytes = (s: string) => Buffer.byteLength(s);

const liveInstructions = (
  profile: "entry" | "full",
  grounding?: string
): string => {
  const server = createMCPServer(
    undefined,
    "u1",
    grounding,
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

/** Every backticked token in `text` that names an advertised tool, as a full `synap_*` name. */
async function toolsNamedIn(text: string): Promise<string[]> {
  const advertised = new Set((await tools.list()).map((t) => t.name));
  const named = new Set<string>();
  for (const m of text.matchAll(/`([a-z_:]+)`/g)) {
    const token = m[1]!;
    const full = token.startsWith("synap_") ? token : `synap_${token}`;
    if (advertised.has(full)) named.add(full);
  }
  return [...named];
}

describe("entry-key MCP instructions", () => {
  it("name only entry tools (derived from tools.list())", async () => {
    const named = await toolsNamedIn(liveInstructions("entry"));
    // Non-vacuity: the scan sees the loop's tools.
    expect(named.length).toBeGreaterThanOrEqual(8);
    expect(named).toContain("synap_wait_for_answer");
    const entry = new Set<string>(ENTRY_TOOLS);
    expect(named.filter((n) => !entry.has(n))).toEqual([]);
  });

  it("the same scan DOES catch the full reflexes naming non-entry tools (the guard can fire)", async () => {
    const entry = new Set<string>(ENTRY_TOOLS);
    const outside = (await toolsNamedIn(SYNAP_INSTRUCTIONS)).filter(
      (n) => !entry.has(n)
    );
    expect(outside).toContain("synap_remember_fact");
    expect(outside).toContain("synap_evaluate_session");
  });

  it("teach the way to the rest: every live group as a tools: ref", () => {
    const text = liveInstructions("entry");
    for (const g of TOOL_GROUP_NAMES) expect(text).toContain(toolGroupRef(g));
    expect(text).toContain(BUILDER_REF);
    expect(text).toContain("reconnect");
  });

  it("keep the work loop: ask in the room, then wait", () => {
    const text = liveInstructions("entry");
    for (const token of [
      "`start_session`",
      "`owner:'human'`",
      "`wait_for_answer`",
      "`post_message`",
      "`session.channelId`",
      "`complete_session`",
    ]) {
      expect(text).toContain(token);
    }
  });

  it("legacy / builder keys keep today's reflexes; entry keys get the entry text", () => {
    expect(liveInstructions("full")).toBe(SYNAP_INSTRUCTIONS);
    expect(liveInstructions("entry")).toBe(ENTRY_REFLEX_PROSE);
    expect(ENTRY_REFLEX_PROSE).not.toBe(SYNAP_INSTRUCTIONS);
  });

  it(`fit ${INSTRUCTIONS_BUDGET_BYTES} bytes with worst-case grounding (fitted to the full budget)`, () => {
    expect(groundingBudgetBytes("entry")).toBeGreaterThanOrEqual(500);
    const pod = Array.from({ length: 40 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`,
      name: `Operations and Revenue Workspace Number ${i} — Émeraude`,
      n: 10_000 - i,
    }));
    // The HTTP door fits grounding to the FULL budget; it must fit entry too.
    const fitted = formatGrounding("", pod, groundingBudgetBytes());
    expect(fitted.length).toBeGreaterThan(0);
    const live = liveInstructions("entry", fitted);
    expect(bytes(live)).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_BYTES);
    expect(live).toContain(pod[0]!.id);
    expect(composeInstructions(fitted, "entry")).toBe(live);
  });
});
