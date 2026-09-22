/**
 * A retrieved item must carry its AGE and AUTHOR into the synthesis context.
 *
 * The incident (2026-09-22): an agent asked the pod why an entity write was
 * failing. `ask` returned a `knowledge` gotcha authored by an AI agent on
 * 2026-06-08 and the synthesized answer opened *"yes — this is a confirmed
 * gotcha"*. The note described a DIFFERENT failure (a 500 from sending the
 * WRONG userId; the live one was a 400 from sending NONE), so the agent
 * reported a stale cause to the founder as today's diagnosis — and recommended
 * the OPPOSITE of the correct fix.
 *
 * The row carried `createdAt` and `createdByKind` the whole time. The context
 * string never showed them, so the model could not tell a fact measured this
 * morning from a guess recorded in June.
 *
 * WHAT THIS COVERS: the pod half — provenance is computed and reaches the
 * context entry's PREFIX, where the snippet budget cannot drop it.
 * WHAT IT DOES NOT: whether the MODEL then attributes rather than asserts.
 * That is the IS system prompt (`routes/knowledge-answer.ts`), a different
 * repo and a behavioural property of a generation call.
 */
import { describe, it, expect } from "vitest";
import { describeItemProvenance, buildSynthesisContext } from "./synthesize.js";

const NOW = new Date("2026-09-22T12:00:00Z");

describe("describeItemProvenance", () => {
  it("names age, AI authorship and the absence of re-verification", () => {
    const out = describeItemProvenance(
      { createdAt: "2026-06-08T01:43:37.383Z", createdByKind: "ai_agent" },
      NOW
    );
    expect(out).toContain("3mo ago");
    expect(out).toContain("by an AI agent");
    expect(out).toContain("never re-verified");
  });

  it("distinguishes a human author", () => {
    const out = describeItemProvenance(
      { createdAt: "2026-09-22T09:00:00Z", createdByKind: "human" },
      NOW
    );
    expect(out).toContain("today");
    expect(out).toContain("by the user");
  });

  it("reads lastVerifiedAt from properties when present", () => {
    const out = describeItemProvenance(
      {
        createdAt: "2026-06-08T01:43:37.383Z",
        createdByKind: "ai_agent",
        properties: { lastVerifiedAt: "2026-09-20T00:00:00Z" },
      },
      NOW
    );
    expect(out).toContain("last verified 2d ago");
    expect(out).not.toContain("never re-verified");
  });

  it("treats an agentUserId as AI authorship even without createdByKind", () => {
    const out = describeItemProvenance(
      { createdAt: "2026-09-01T00:00:00Z", agentUserId: "agent-1" },
      NOW
    );
    expect(out).toContain("by an AI agent");
  });

  it("reads lastVerifiedAt under any key spelling the pod may store", () => {
    // `synap_define_kind` stored the def as `lastverifiedat` (camelCase is
    // lowercased with no separator), while a writer may use the camelCase or
    // hyphenated form. All three must read.
    for (const key of [
      "lastVerifiedAt",
      "lastverifiedat",
      "last-verified-at",
    ]) {
      const out = describeItemProvenance(
        {
          createdAt: "2026-06-08T01:43:37.383Z",
          createdByKind: "ai_agent",
          properties: { [key]: "2026-09-20T00:00:00Z" },
        },
        NOW
      );
      expect(out, `key ${key}`).toContain("last verified 2d ago");
      expect(out, `key ${key}`).not.toContain("never re-verified");
    }
  });

  it("returns null when the row carries no provenance at all", () => {
    expect(describeItemProvenance({ title: "x" }, NOW)).toBeNull();
  });

  it("does not claim freshness it cannot support (bad date ⇒ no age)", () => {
    const out = describeItemProvenance(
      { createdAt: "not-a-date", createdByKind: "ai_agent" },
      NOW
    );
    expect(out).toBe("by an AI agent");
    expect(out).not.toContain("never re-verified");
  });
});

describe("buildSynthesisContext puts provenance in the entry prefix", () => {
  it("renders age and author before the snippet", () => {
    const { context } = buildSynthesisContext([
      {
        substrate: "semantic",
        status: "ok",
        items: [
          {
            id: "9d43e988-620f-41f7-8362-00b87126885d",
            title: "Hub Protocol entity writes require human userId",
            createdAt: "2026-06-08T01:43:37.383Z",
            createdByKind: "ai_agent",
          },
        ],
      },
    ]);
    // The prefix, not buried in the snippet — this is what the model reads first.
    expect(context).toMatch(/\[semantic · recorded .*by an AI agent/);
    expect(context).toContain("never re-verified");
  });
});
