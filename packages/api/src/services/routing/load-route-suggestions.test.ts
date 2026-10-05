/**
 * The capture follow-up's router call: playbook candidates and propose-mode
 * rule matches are ranked into one list per entity, each with a reason — and
 * nothing runs.
 *
 * The matchers are injected at the boundary (`playbooks.matchForEntity`, and
 * `match-rules-for-entity.ts` — whose predicate is tested on its own), shaped
 * like their outputs. NOT covered: the wiring into `capture.execute` / Hub
 * `/capture/structure` (typecheck + NEEDS-DOGFOOD).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadRouteSuggestions,
  type RouteMatchers,
} from "./load-route-suggestions.js";

const WS = "11111111-1111-4111-8111-111111111111";

function matchers(): RouteMatchers & {
  playbooks: ReturnType<typeof vi.fn>;
  rules: ReturnType<typeof vi.fn>;
} {
  return {
    playbooks: vi.fn(async () => [
      {
        id: "pb-other",
        name: "Onboard client",
        goalTemplate: "Welcome",
        subjectProfileSlug: "company",
      },
      {
        id: "pb-deal",
        name: "Deal review",
        goalTemplate: "Review the deal",
        subjectProfileSlug: "deal",
      },
    ]),
    rules: vi.fn(async () => ({
      matches: [
        {
          id: "au-any",
          name: "Tag new items",
          description: "",
          filterProfileSlug: null,
        },
      ],
      proposedPlaybookIds: new Set<string>(),
    })),
  };
}

describe("loadRouteSuggestions", () => {
  it("ranks playbook + automation candidates per entity, each with a reason", async () => {
    const m = matchers();
    const res = await loadRouteSuggestions({
      ctx: {},
      workspaceId: WS,
      entities: [{ entityId: "e1", profileSlug: "deal" }],
      intentText: "please review this deal",
      matchers: m,
    });

    expect(m.playbooks).toHaveBeenCalledWith({
      profileSlug: "deal",
      entityId: "e1",
      workspaceId: WS,
      intentText: "please review this deal",
    });
    expect(res.status).toBe("ok");
    const [entity] = (res as Extract<typeof res, { status: "ok" }>).entities;
    expect(entity!.entityId).toBe("e1");
    // "Tag new items" fires for any kind and matched none of the user's
    // words: "runs for anything new" is not evidence about THIS capture, so
    // it is not suggested (suggest-routes.ts, WHAT IS RETURNED). "Onboard
    // client" is for another kind entirely.
    expect(entity!.suggestions.map((s) => s.candidate.id)).toEqual(["pb-deal"]);
    for (const s of entity!.suggestions)
      expect(s.reason.length).toBeGreaterThan(0);
    expect(entity!.suggestions[0]!.reason).toContain("“review”");
  });

  it("says why it could not suggest, instead of an empty list", async () => {
    const m = matchers();
    expect(
      await loadRouteSuggestions({
        ctx: {},
        workspaceId: null,
        entities: [{ profileSlug: "deal" }],
        matchers: m,
      })
    ).toEqual({ status: "skipped", reason: "no_workspace" });
    expect(
      await loadRouteSuggestions({
        ctx: {},
        workspaceId: WS,
        entities: [],
        matchers: m,
      })
    ).toEqual({ status: "skipped", reason: "no_entities" });
    expect(m.playbooks).not.toHaveBeenCalled();

    m.rules.mockRejectedValueOnce(new Error("db down"));
    expect(
      await loadRouteSuggestions({
        ctx: {},
        workspaceId: WS,
        entities: [{ profileSlug: "deal" }],
        matchers: m,
      })
    ).toEqual({ status: "failed", error: "db down" });
  });

  it("only MATCHES — the module reaches no run / trigger / instantiate door", () => {
    const src = readFileSync(
      join(__dirname, "load-route-suggestions.ts"),
      "utf8"
    );
    // Self-check: the scan can see the calls it does make.
    expect(src).toMatch(/\.matchForEntity\(/);
    expect(src).toMatch(/matchProposeRulesForEntity\(/);
    expect(src).not.toMatch(
      /\.(run|trigger|triggerAutomation|runPlaybook|instantiate|instantiateSession|execute)\(/
    );
  });
});

describe("loadRouteSuggestions — propose rules and the standing-rule offer", () => {
  it("a matched propose rule is suggested as a PROPOSING candidate", async () => {
    const m = matchers();
    m.rules.mockResolvedValueOnce({
      matches: [
        {
          id: "rule-deal",
          name: "Qualify new deals",
          description: null,
          filterProfileSlug: "deal",
        },
      ],
      proposedPlaybookIds: new Set<string>(),
    });
    const res = await loadRouteSuggestions({
      ctx: {},
      workspaceId: WS,
      entities: [{ entityId: "e1", profileSlug: "deal" }],
      matchers: m,
    });
    const [entity] = (res as Extract<typeof res, { status: "ok" }>).entities;
    const rule = entity!.suggestions.find(
      (s) => s.candidate.id === "rule-deal"
    );
    expect(rule?.candidate).toMatchObject({
      kind: "automation",
      proposes: true,
    });
  });

  it("offers 'Always propose this' only for a kind-built playbook with no standing rule", async () => {
    const m = matchers();
    m.rules.mockResolvedValueOnce({
      matches: [],
      proposedPlaybookIds: new Set<string>(),
    });
    const offered = await loadRouteSuggestions({
      ctx: {},
      workspaceId: WS,
      entities: [{ entityId: "e1", profileSlug: "deal" }],
      matchers: m,
    });
    const pb = (
      offered as Extract<typeof offered, { status: "ok" }>
    ).entities[0]!.suggestions.find((s) => s.candidate.id === "pb-deal");
    expect(pb?.candidate).toMatchObject({ alwaysProposeOffer: true });

    m.rules.mockResolvedValueOnce({
      matches: [],
      proposedPlaybookIds: new Set(["pb-deal"]),
    });
    const withheld = await loadRouteSuggestions({
      ctx: {},
      workspaceId: WS,
      entities: [{ entityId: "e1", profileSlug: "deal" }],
      matchers: m,
    });
    const pb2 = (
      withheld as Extract<typeof withheld, { status: "ok" }>
    ).entities[0]!.suggestions.find((s) => s.candidate.id === "pb-deal");
    expect(pb2).toBeDefined();
    expect("alwaysProposeOffer" in pb2!.candidate).toBe(false);
  });
});
