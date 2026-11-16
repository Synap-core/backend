/**
 * The ONE need resolver (0426, founder decisions D2 and D3) and the space's
 * coverage fold, pure: a need ref resolves to the verbs of the provider the
 * space bound, for the need's intents (or the one intent), or to a REASON —
 * never to a silent empty list.
 */
import { describe, it, expect } from "vitest";
import {
  chooseNeedVerb,
  declaresFill,
  needRequiresKey,
  needResolutionReason,
  resolveNeedRefVerbs,
  type SpaceNeedBinding,
} from "./space-needs.js";
import { foldNeedCoverage, needRefsOfFlow } from "./space-need-coverage.js";

const binding = (
  need: string,
  providerCapabilityId: string | null,
  providerName: string | null = "GitHub"
): [string, SpaceNeedBinding] => [
  need,
  {
    bindingId: `b-${need}`,
    need,
    providerCapabilityId,
    providerName,
    setBy: "u",
    updatedAt: new Date("2026-11-16T00:00:00Z"),
  },
];

// A container (the provider) and a tool row inside it, as the registry lists them.
const REGISTRY = [
  {
    id: "cap-gh",
    name: "GitHub",
    verbs: [
      { id: "github_list_prs", kind: "read", intent: "list_records" },
      { id: "github_merge", kind: "action", intent: "run_external_job" },
      { id: "github_legacy", kind: "read" }, // no intent: never guessed into a need
    ],
  },
  {
    id: "tool-gh-checks",
    name: "GitHub checks",
    containerId: "cap-gh",
    verbs: [{ id: "github_pr_checks", kind: "read", intent: "fetch_record" }],
  },
  {
    id: "cap-vercel",
    name: "Vercel",
    verbs: [
      { id: "vercel_deploy", kind: "action", intent: "run_external_job" },
    ],
  },
  {
    id: "cap-stripe",
    name: "Stripe",
    verbs: [{ id: "stripe_list", kind: "read", intent: "list_records" }],
  },
];

describe("resolveNeedRefVerbs — a need ref → the bound provider's verbs, or a reason", () => {
  const bindings = new Map([
    binding("code-host", "cap-gh"),
    binding("gate", null),
  ]);

  it("offers the provider's verbs (its own rows and its container's) for the need's intents", () => {
    const r = resolveNeedRefVerbs("need:code-host", bindings, REGISTRY);
    expect(r).toEqual({
      status: "ok",
      need: "code-host",
      providerCapabilityId: "cap-gh",
      providerName: "GitHub",
      verbs: ["github_list_prs", "github_merge", "github_pr_checks"],
    });
    // Another provider's verbs never leak in, nor an intent-less verb.
    if (r.status === "ok") {
      expect(r.verbs).not.toContain("stripe_list");
      expect(r.verbs).not.toContain("github_legacy");
    }
  });

  it("an /<intent> suffix narrows to that intent; an alias reads as its slug", () => {
    const r = resolveNeedRefVerbs(
      "need:git-host/fetch_record",
      bindings,
      REGISTRY
    );
    expect(r.status === "ok" && r.verbs).toEqual(["github_pr_checks"]);
  });

  it("a trial keeps read verbs only", () => {
    const r = resolveNeedRefVerbs("need:code-host", bindings, REGISTRY, true);
    expect(r.status === "ok" && r.verbs).toEqual([
      "github_list_prs",
      "github_pr_checks",
    ]);
  });

  it("says why when it offers nothing: unknown, unfilled, provider gone, no verb", () => {
    expect(resolveNeedRefVerbs("need:nope", bindings, REGISTRY).status).toBe(
      "unknown_need"
    );
    expect(resolveNeedRefVerbs("payments", bindings, REGISTRY).status).toBe(
      "unknown_need"
    );
    expect(resolveNeedRefVerbs("need:payments", bindings, REGISTRY)).toEqual({
      status: "unfilled",
      need: "payments",
    });
    expect(resolveNeedRefVerbs("need:gate", bindings, REGISTRY)).toEqual({
      status: "provider_gone",
      need: "gate",
    });
    // A provider that offers nothing for the need's intents (Vercel runs jobs).
    const noVerb = resolveNeedRefVerbs(
      "need:payments",
      new Map([binding("payments", "cap-vercel", "Vercel")]),
      REGISTRY
    );
    expect(noVerb).toEqual({
      status: "no_verb",
      need: "payments",
      providerName: "Vercel",
      intents: ["list_records", "fetch_record"],
    });
    // ...and fixing the binding fixes it: the reason was about the binding.
    expect(
      resolveNeedRefVerbs(
        "need:payments",
        new Map([binding("payments", "cap-stripe")]),
        REGISTRY
      ).status
    ).toBe("ok");
  });

  it("every reason is a sentence naming the need in the person's words", () => {
    const sentence = needResolutionReason({
      status: "unfilled",
      need: "code-host",
    });
    expect(sentence).toContain("Code host");
    expect(sentence).toMatch(/not filled in this space/);
  });
});

describe("chooseNeedVerb — a single-verb reference runs ONE verb", () => {
  const bindings = new Map([binding("code-host", "cap-gh")]);

  it("one verb: that verb; several: ambiguous, narrowed by /<intent>", () => {
    const one = chooseNeedVerb(
      resolveNeedRefVerbs("need:code-host/fetch_record", bindings, REGISTRY)
    );
    expect(one).toEqual({
      status: "ok",
      verbId: "github_pr_checks",
      need: "code-host",
      providerName: "GitHub",
    });
    const many = chooseNeedVerb(
      resolveNeedRefVerbs("need:code-host", bindings, REGISTRY)
    );
    expect(many.status).toBe("ambiguous");
    if (many.status === "ambiguous") {
      expect(needResolutionReason(many)).toMatch(/need:code-host\/<intent>/);
    }
  });
});

describe("needRequiresKey — a requires need → the bound provider's key", () => {
  it("maps a filled need to its provider's key, and an unfilled one to null", () => {
    const bindings = new Map([binding("media-generation", "cap-ff")]);
    const keys = new Map([["cap-ff", "media-ffmpeg"]]);
    expect(needRequiresKey("need:media-generation", bindings, keys)).toBe(
      "media-ffmpeg"
    );
    expect(needRequiresKey("need:media", bindings, keys)).toBe("media-ffmpeg");
    expect(needRequiresKey("need:deploy-target", bindings, keys)).toBeNull();
    expect(needRequiresKey("media-ffmpeg", bindings, keys)).toBeNull();
  });
});

describe("foldNeedCoverage — a space's declared needs, filled or empty", () => {
  it("joins declared needs, bindings and the installed providers that declare a fill", () => {
    const r = foldNeedCoverage({
      workspaceId: "ws",
      declared: ["code-host", "git-host", "payments", "mystery"],
      bindings: new Map([binding("code-host", "cap-gh")]),
      installed: [
        {
          id: "cap-gh",
          name: "GitHub",
          metadata: { fills: ["code-host", "gate"] },
        },
        { id: "cap-stripe", name: "Stripe", metadata: { fills: ["payments"] } },
        { id: "cap-other", name: "Other", metadata: {} },
      ],
    });
    expect(r.needs.map((n) => [n.need, n.state])).toEqual([
      ["code-host", "filled"],
      ["payments", "empty"],
      ["mystery", "empty"],
    ]);
    expect(r.needs[0]!.provider).toEqual({
      capabilityId: "cap-gh",
      name: "GitHub",
    });
    expect(r.needs[1]!.candidates).toEqual([
      { capabilityId: "cap-stripe", name: "Stripe" },
    ]);
    expect(r.needs[2]!.known).toBe(false);
    expect(r.empty).toEqual(["payments", "mystery"]);
  });

  it("a binding whose provider was deleted reads empty", () => {
    const r = foldNeedCoverage({
      workspaceId: "ws",
      declared: ["gate"],
      bindings: new Map([binding("gate", null)]),
      installed: [],
    });
    expect(r.needs[0]!.state).toBe("empty");
    expect(r.empty).toEqual(["gate"]);
  });

  it("declaresFill reads the stamped metadata only", () => {
    expect(declaresFill({ fills: ["gate"] }, "gate")).toBe(true);
    expect(declaresFill({ fills: "gate" }, "gate")).toBe(false);
    expect(declaresFill(null, "gate")).toBe(false);
  });
});

describe("needRefsOfFlow — an automation's capability nodes name needs", () => {
  it("reads data.need of capability nodes only, each once", () => {
    expect(
      needRefsOfFlow({
        nodes: [
          { type: "capability", data: { need: "need:deploy-target" } },
          { type: "capability", data: { verbId: "x" } },
          { type: "skill", data: { need: "need:gate" } },
          { type: "capability", data: { need: "need:deploy-target" } },
          { type: "capability", data: { need: "deploy-target" } },
        ],
      })
    ).toEqual(["need:deploy-target"]);
    expect(needRefsOfFlow(null)).toEqual([]);
  });
});
