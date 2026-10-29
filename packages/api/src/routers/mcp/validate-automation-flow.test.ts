/**
 * Wave 4 — `synap_create_automation` must not accept a flow whose `capability`
 * step names a verb that does not exist.
 *
 * These are DB-free: the two real reads (the access-scoped capability registry
 * and the marketplace catalog cache) are injected, exactly as adapter.ts wires
 * them to `listCapabilities` / `queryCatalogCache`.
 */

import { describe, it, expect } from "vitest";
import {
  collectCapabilitySteps,
  validateFlowCapabilities,
  type ResolvableCapabilityIndex,
} from "./validate-automation-flow.js";

const INDEX: ResolvableCapabilityIndex = {
  verbIds: new Set(["ai.generate", "feed.post", "market.search"]),
  capabilityIds: new Set(["11111111-1111-1111-1111-111111111111"]),
};

const deps = (
  over: Partial<Parameters<typeof validateFlowCapabilities>[1]> = {}
) => ({
  loadIndex: async () => INDEX,
  ...over,
});

const capNode = (id: string, data: Record<string, unknown>) => ({
  id,
  type: "capability",
  position: { x: 0, y: 0 },
  data,
});

describe("collectCapabilitySteps", () => {
  it("picks out only capability nodes, tolerating junk", () => {
    const steps = collectCapabilitySteps([
      { id: "t", type: "trigger", data: {} },
      capNode("a", { verbId: "ai.generate" }),
      null,
      "nonsense",
      { type: "capability" }, // no id, no data
    ]);
    expect(steps.map((s) => s.nodeId)).toEqual(["a", "#4"]);
    expect(steps[0]).toMatchObject({
      verbId: "ai.generate",
      capabilityId: null,
    });
    expect(steps[1].verbId).toBeNull();
  });
});

describe("validateFlowCapabilities", () => {
  it("passes a flow with no capability steps", async () => {
    const r = await validateFlowCapabilities(
      [{ id: "t", type: "trigger", data: {} }],
      deps()
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a valid capability node (verb + visible capabilityId)", async () => {
    const r = await validateFlowCapabilities(
      [
        capNode("analyze", {
          verbId: "ai.generate",
          capabilityId: "11111111-1111-1111-1111-111111111111",
        }),
      ],
      deps()
    );
    expect(r).toEqual({ ok: true });
  });

  it("accepts a VERB-ONLY node (no capabilityId) — the first-party shape", async () => {
    // ensure-report-automation.ts emits exactly this: { verbId: "ai.generate" }
    // with no capabilityId. A missing capabilityId is NORMAL, never invalid.
    const r = await validateFlowCapabilities(
      [capNode("analyze", { verbId: "ai.generate", verbKind: "read" })],
      deps()
    );
    expect(r).toEqual({ ok: true });
  });

  it("REJECTS an unknown verbId and names the verb", async () => {
    const r = await validateFlowCapabilities(
      [capNode("send", { verbId: "slack.postMessage" })],
      deps({ searchMarketplace: async () => [] })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("slack.postMessage");
    expect(r.error).toContain('step "send"');
    expect(r.error).toContain("not installed or not visible");
    // Actionable next step, not "validation failed".
    expect(r.error).toContain("synap_list_capabilities");
    // Absent facts render nothing.
    expect(r.error).toContain("No marketplace entry was found");
  });

  it("rejects a capability node with no verbId at all", async () => {
    const r = await validateFlowCapabilities([capNode("x", {})], deps());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("has no verbId");
  });

  it("rejects a verb-resolving node whose capabilityId is not visible", async () => {
    const r = await validateFlowCapabilities(
      [
        capNode("a", {
          verbId: "ai.generate",
          capabilityId: "not-a-visible-tool",
        }),
      ],
      deps()
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("not-a-visible-tool");
  });

  it("includes marketplace candidates when the lookup finds some", async () => {
    const r = await validateFlowCapabilities(
      [capNode("send", { verbId: "slack.postMessage" })],
      deps({
        searchMarketplace: async () => [
          { slug: "slack-connector", name: "Slack", kind: "capability" },
        ],
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("slack-connector");
    expect(r.error).toContain("market.install");
    // Suggested, never auto-installed.
    expect(r.error).toContain("Install one with");
  });

  it("a marketplace-lookup FAILURE still yields the validation error", async () => {
    const r = await validateFlowCapabilities(
      [capNode("send", { verbId: "slack.postMessage" })],
      deps({
        searchMarketplace: async () => {
          throw new Error("catalog cache unreachable");
        },
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("slack.postMessage");
    expect(r.error).not.toContain("catalog cache unreachable");
  });

  it("a marketplace-lookup TIMEOUT still yields the validation error", async () => {
    const r = await validateFlowCapabilities(
      [capNode("send", { verbId: "slack.postMessage" })],
      deps({
        searchMarketplace: () => new Promise(() => {}), // never settles
        marketplaceTimeoutMs: 20,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("slack.postMessage");
  });

  it("does NOT block when the registry read itself fails (fail-open on the read)", async () => {
    const r = await validateFlowCapabilities(
      [capNode("send", { verbId: "nope" })],
      {
        loadIndex: async () => {
          throw new Error("db down");
        },
      }
    );
    expect(r).toEqual({ ok: true });
  });

  it("reports every bad step, not just the first", async () => {
    const r = await validateFlowCapabilities(
      [
        capNode("a", { verbId: "ai.generate" }),
        capNode("b", { verbId: "nope.one" }),
        capNode("c", { verbId: "nope.two" }),
      ],
      deps({ searchMarketplace: async () => [] })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("nope.one");
    expect(r.error).toContain("nope.two");
    expect(r.error).toContain("2 capability step(s)");
  });

  // ── Ticket c7e2afa2 (option C): a verb that is a skill still in review ────
  const PENDING_CODE = {
    verbId: "instagram.score_handle",
    proposalId: "22222222-2222-2222-2222-222222222222",
    title: 'Create skill "instagram.score_handle"',
    reviewUrl: "https://pod.test/open/22222222-2222-2222-2222-222222222222",
    skillKind: "code",
  };

  it("names the PENDING proposal that would provide the verb, and still refuses", async () => {
    let marketplaceAsked = false;
    const r = await validateFlowCapabilities(
      [capNode("start", { verbId: "instagram.score_handle" })],
      deps({
        findPendingProposals: async (verbs) => {
          expect(verbs).toEqual(["instagram.score_handle"]);
          return [PENDING_CODE];
        },
        searchMarketplace: async () => {
          marketplaceAsked = true;
          return [];
        },
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain(`proposal ${PENDING_CODE.proposalId}`);
    expect(r.error).toContain(PENDING_CODE.title);
    expect(r.error).toContain(PENDING_CODE.reviewUrl);
    expect(r.error).toContain("re-send create_automation unchanged");
    // A code skill cannot ride the capture bundle, and the error says so.
    expect(r.error).toContain("cannot carry it");
    expect(r.error).toContain("a code skill");
    // The verb is coming: no marketplace hunt, no "nothing provides it".
    expect(marketplaceAsked).toBe(false);
    expect(r.error).not.toContain("No marketplace entry");
  });

  it("points a pending INSTRUCTION skill at one synap_capture bundle", async () => {
    const r = await validateFlowCapabilities(
      [capNode("start", { verbId: "team.weekly_brief" })],
      deps({
        findPendingProposals: async () => [
          {
            verbId: "team.weekly_brief",
            proposalId: "33333333-3333-3333-3333-333333333333",
            reviewUrl: "/open/33333333-3333-3333-3333-333333333333",
            skillKind: "instruction",
          },
        ],
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("proposal 33333333-3333-3333-3333-333333333333");
    expect(r.error).toContain(
      "synap_capture call (skills[] + automations[]; skills are applied before automations"
    );
    expect(r.error).not.toContain("cannot carry it");
  });

  it("a pending-proposal lookup FAILURE leaves the plain validation error", async () => {
    const r = await validateFlowCapabilities(
      [capNode("start", { verbId: "instagram.score_handle" })],
      deps({
        findPendingProposals: async () => {
          throw new Error("proposals unreachable");
        },
        searchMarketplace: async () => [],
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("instagram.score_handle");
    expect(r.error).not.toContain("waiting for review");
    expect(r.error).not.toContain("proposals unreachable");
    expect(r.error).toContain("No marketplace entry");
  });
});
