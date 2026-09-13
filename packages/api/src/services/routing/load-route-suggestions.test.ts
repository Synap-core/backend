/**
 * The capture follow-up's router call: candidates from BOTH matcher doors are
 * ranked into one list per entity, each with a reason — and nothing runs.
 *
 * The matchers are injected at the door boundary (`playbooks.matchForEntity`,
 * `automations.matchForEntity`), shaped like those procedures' outputs. NOT
 * covered: the wiring into `capture.execute` / Hub `/capture/structure`
 * (typecheck + NEEDS-DOGFOOD).
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
  automations: ReturnType<typeof vi.fn>;
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
    automations: vi.fn(async () => [
      {
        id: "au-any",
        name: "Tag new items",
        description: "",
        signals: [{ type: "anyKind" }],
      },
    ]),
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
    expect(entity!.suggestions.map((s) => s.candidate.id)).toEqual([
      "pb-deal",
      "au-any",
    ]);
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

    m.automations.mockRejectedValueOnce(new Error("db down"));
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
    expect(src).not.toMatch(
      /\.(run|trigger|triggerAutomation|runPlaybook|instantiate|instantiateSession|execute)\(/
    );
  });
});
