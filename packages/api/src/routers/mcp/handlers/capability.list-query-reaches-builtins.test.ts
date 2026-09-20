/**
 * TRIPWIRE — a `query` to `synap_list_capabilities` REACHES Synap Core's
 * first-party verbs.
 *
 * ── The claim under test ────────────────────────────────────────────────────
 * An agent blocked by the pending-proposal cap searched for its remedy
 * ("proposal limit upgrade agent budget governance"), found nothing, and
 * concluded the cap was "not a configurable knob exposed through any door I
 * have access to". `governance.recommend_raise_proposal_cap` is in fact a
 * registered, runnable Synap Core verb.
 *
 * The suspicion was that the DEFAULT view's Synap-Core fold (which collapses
 * the pack's ~33 verbs into one `builtInPack` summary line) also swallowed
 * queries. It does not — the fold is guarded `if (!containerId && !query &&
 * !kind)`, so naming a query is already the caller taking responsibility for
 * the rows. These tests PIN that, because it is load-bearing and invisible:
 * adding `query` to that guard's condition, or reclassifying the pack's verbs
 * as `builtin-tool`, would silently re-create the discovery failure.
 *
 * ── Two hops, tested separately, with their limits stated ───────────────────
 * The full chain is  query → listCapabilities' ranker → the handler's fold.
 * A single test cannot drive both without a live DB, so:
 *
 *   A. THE HANDLER'S FOLD — the real handler, real `sectionCapabilities`, with
 *      only the DB read (`listCapabilities`) stubbed. Does NOT exercise
 *      ranking.
 *   B. THE RANKER — the real `rankByTerms` with the real projection the
 *      registry passes it, over rows DERIVED from `SYNAP_CORE_DEFINITION`
 *      (never hand-copied text). Does NOT exercise the handler.
 *
 * Both fixtures read the verb's name and description off the live definition,
 * so a reworded description is scanned as it actually ships.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { rankByTerms } from "../../../utils/term-match.js";
import { SYNAP_CORE_DEFINITION } from "../../../services/capabilities/ensure-synap-core.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORE_CONTAINER = "container-synap-core";

/** The verb the blocked agent needed and could not find. */
const TARGET_VERB = "governance.recommend_raise_proposal_cap";

/** The agent's own words, verbatim from the complaint. */
const AGENT_QUERY = "proposal limit upgrade agent budget governance";

/**
 * The pack's verbs, read off the LIVE definition. Non-vacuity: if this ever
 * comes back empty (a rename, a restructure), every assertion below would pass
 * over nothing — so the count is asserted before anything else uses it.
 */
const CORE_SKILLS = SYNAP_CORE_DEFINITION.skills;

/** A registry row as `listCapabilities` builds it for a Synap Core verb. */
function coreRow(skill: { name: string; description?: string }) {
  return {
    // `kind: "skill"` is NOT incidental: the handler filters
    // `c.kind !== "builtin-tool"` regardless of query, so a verb classified as
    // a builtin TOOL could never be returned by a search. A Synap Core verb is
    // a skills row whose `kind` is "builtin" (not "instruction"), which
    // capability-registry maps to "skill". If that mapping changes, test A's
    // `skills` assertion goes red — which is the point.
    kind: "skill" as const,
    id: `skill-${skill.name}`,
    name: skill.name,
    description: skill.description ?? null,
    inputSchema: { type: "object", properties: {} },
    executor: "is-agent",
    governance: "none",
    enabled: true,
    containerId: CORE_CONTAINER,
    containerName: SYNAP_CORE_DEFINITION.name,
  };
}

const { mockListCapabilities } = vi.hoisted(() => ({
  mockListCapabilities: vi.fn(),
}));

vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (orig) => {
    // PARTIAL mock: `sectionCapabilities` and `DEFAULT_QUERY_LIMIT` stay REAL, so
    // the fold/dedupe/cap the handler depends on is the shipping one. Only the
    // DB-backed read is replaced.
    const actual =
      await orig<
        typeof import("../../../services/capabilities/capability-registry.js")
      >();
    return { ...actual, listCapabilities: mockListCapabilities };
  }
);

const { capabilityHandlers } = await import("./capability.js");

async function listCaps(
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const res = (await capabilityHandlers.synap_list_capabilities!({
    toolName: "synap_list_capabilities",
    args: { workspaceId: WS, ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    agentUserId: "agent-1",
  } as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

describe("the pack's verb set is real (non-vacuity floor)", () => {
  it("SYNAP_CORE_DEFINITION still carries the verb the agent needed", () => {
    expect(CORE_SKILLS.length).toBeGreaterThan(20);
    const target = CORE_SKILLS.find((s) => s.name === TARGET_VERB);
    expect(
      target,
      `${TARGET_VERB} must exist in SYNAP_CORE_DEFINITION — if it was renamed, ` +
        `this whole file is scanning a verb that no longer ships.`
    ).toBeDefined();
    expect(target!.description ?? "").not.toBe("");
  });
});

describe("A. the handler's fold — a query is not swallowed by the built-in pack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the cap-raise verb as a skills row when a query is given", async () => {
    // What the registry hands back for this query: the ranked core rows.
    mockListCapabilities.mockResolvedValue(
      CORE_SKILLS.filter((s) => s.name.startsWith("governance.")).map(coreRow)
    );

    const payload = await listCaps({ query: AGENT_QUERY });

    const names = (payload.skills ?? []).map((s: { name: string }) => s.name);
    expect(names).toContain(TARGET_VERB);
    // The fold must NOT have collapsed them into a summary line: a count is
    // not an answer to a search.
    expect(payload.builtInPack).toBeUndefined();
    // And they were not silently dropped as built-in TOOLS either.
    expect(payload.excluded?.builtinTools ?? 0).toBe(0);
  });

  it("WITHOUT a query the same rows DO fold into the builtInPack summary", async () => {
    // The discriminating control for the test above. If this did not fold,
    // the assertion above would pass for a trivial reason (nothing ever folds)
    // and would not be testing the guard at all.
    mockListCapabilities.mockResolvedValue(
      CORE_SKILLS.filter((s) => s.name.startsWith("governance.")).map(coreRow)
    );

    const payload = await listCaps({});

    expect(payload.builtInPack).toBeDefined();
    expect(payload.builtInPack.containerId).toBe(CORE_CONTAINER);
    expect(payload.builtInPack.verbCount).toBeGreaterThan(0);
    const names = (payload.skills ?? []).map((s: { name: string }) => s.name);
    expect(names).not.toContain(TARGET_VERB);
  });

  it("an explicit containerId also lists them (the pack's own hatch still works)", async () => {
    mockListCapabilities.mockResolvedValue(
      CORE_SKILLS.filter((s) => s.name.startsWith("governance.")).map(coreRow)
    );

    const payload = await listCaps({ containerId: CORE_CONTAINER });

    const names = (payload.skills ?? []).map((s: { name: string }) => s.name);
    expect(names).toContain(TARGET_VERB);
    expect(payload.builtInPack).toBeUndefined();
  });
});

describe("B. the ranker — the agent's own words match the verb", () => {
  /**
   * The REAL `rankByTerms` with the EXACT projection + labels
   * `capability-registry.ts` passes it (name / verb labels / description).
   * Rows are every Synap Core verb, so the target must win on merit against
   * its ~33 siblings rather than being the only candidate.
   */
  function rank(query: string) {
    const rows = CORE_SKILLS.map(coreRow);
    return rankByTerms(
      query,
      rows,
      (cap) => ({
        primary: cap.name,
        secondary: [],
        tertiary: cap.description,
      }),
      { primary: "name", secondary: "verbs", tertiary: "description" }
    );
  }

  it("the blocked agent's verbatim query returns the cap-raise verb", async () => {
    const hits = rank(AGENT_QUERY).map((h) => h.item.name);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain(TARGET_VERB);
  });

  it("a narrower query ranks it FIRST", async () => {
    const hits = rank("raise my pending proposal cap").map((h) => h.item.name);
    expect(hits[0]).toBe(TARGET_VERB);
  });

  it("WHAT THIS DOES NOT COVER — the ranker still misses a semantic query", async () => {
    // Stated honestly rather than implied, and measured, not guessed:
    // `rankByTerms` is word matching with stemming, NOT semantic. Two real
    // failures a blocked agent would plausibly type:
    //
    //   "unblock me"              → 0 hits (silence; the zero-hit rescue then
    //                               hands back the full catalog, by design)
    //   "stop refusing my writes" → 7 hits, NONE of them this verb — a
    //                               confident, wrong answer, which is worse
    //
    // So "a query reaches the pack" is NOT "a query finds the verb". This is
    // why the fix for the discovery failure is the REFUSAL carrying the remedy
    // (which needs no search at all), not better ranking.
    expect(rank("unblock me")).toHaveLength(0);

    const misled = rank("stop refusing my writes").map((h) => h.item.name);
    expect(misled.length).toBeGreaterThan(0);
    expect(misled).not.toContain(TARGET_VERB);
  });
});
