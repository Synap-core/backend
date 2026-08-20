import { describe, it, expect } from "vitest";
import { classifyRuleIntent, type RuleShape } from "./classify-intent.js";

/** The shapes a rule implies, as a plain set — order is asserted separately. */
const shapesOf = (
  rule: string,
  context?: Parameters<typeof classifyRuleIntent>[1]
) => classifyRuleIntent(rule, context).shapes.map((s) => s.shape);

const confidenceOf = (rule: string, shape: RuleShape) =>
  classifyRuleIntent(rule).shapes.find((s) => s.shape === shape)?.confidence ??
  0;

// ─────────────────────────────────────────────────────────────────────────────
// The calibration corpus — six rules a real user actually stated. Every one of
// these must classify sensibly; they are the reason the cue tables look the way
// they do, so a change that breaks one is a change that needs a new argument.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRuleIntent — the six-rule calibration corpus", () => {
  it("1. a statement about where files live is a FACT, with ingest only implied", () => {
    const rule = "This Google Drive folder holds all our company files.";
    const r = classifyRuleIntent(rule);

    expect(r.primary).toBe("fact");
    expect(r.oneShot).toBe(false);
    // The implied "…so index it" is real but weak: an external source plus a
    // holding verb. It must never outrank the fact it was inferred from.
    expect(shapesOf(rule)).toContain("behaviour");
    expect(confidenceOf(rule, "behaviour")).toBeLessThan(
      confidenceOf(rule, "fact")
    );
    expect(r.needsClarification).toBeUndefined();
  });

  it("2. one-container-per-entity is FACT + STRUCTURE (identity resolution)", () => {
    const rule =
      "Inside it, one folder per client — if a folder names a client that doesn't exist, create the client first.";
    const shapes = shapesOf(rule);

    expect(shapes).toContain("structure");
    expect(shapes).toContain("fact");
    // "if …, create it first" qualifies an action already being described. It is
    // NOT a trigger, and turning it into one builds a permanent automation.
    expect(shapes).not.toContain("behaviour");
    expect(classifyRuleIntent(rule).oneShot).toBe(false);
  });

  it("3. a triggered enrichment with a pre-meeting brief is BEHAVIOUR + SCHEDULE + NOTIFICATION", () => {
    const rule =
      "When a Calendly event lands, research the prospect via Apollo, create the person and company, and brief me an hour before the call.";
    const r = classifyRuleIntent(rule);

    expect(r.shapes.map((s) => s.shape)).toEqual(
      expect.arrayContaining(["behaviour", "schedule", "notification"])
    );
    expect(r.primary).toBe("behaviour");
    // "research" is a one-shot-ish verb, but a standing marker is present — the
    // weak tier must lose SILENTLY, without raising a clarification.
    expect(r.oneShot).toBe(false);
    expect(r.needsClarification).toBeUndefined();
  });

  it("4. a project-scoped research request is a ONE-SHOT ask, not a rule", () => {
    const rule =
      "We're working on Stellar Grants — research the process and map the deadlines.";
    const r = classifyRuleIntent(rule);

    expect(r.oneShot).toBe(true);
    expect(r.primary).toBe("unknown");
    expect(r.shapes.map((s) => s.shape)).toEqual(["unknown"]);
    // The cues are still reported: a reviewer must see why we called it one-shot.
    expect(r.shapes[0]!.cues).toContain("we're working on");
  });

  it("5. a distributive assertion with mutations is BEHAVIOUR + EXTRACTION + STRUCTURE", () => {
    const rule =
      "Each client has an email address; extract those emails, attach them to the client, and update the grant status.";
    const shapes = shapesOf(rule);

    expect(shapes).toEqual(
      expect.arrayContaining(["behaviour", "extraction", "structure"])
    );
    // No trigger word at all — "each client" is what makes it standing.
    expect(classifyRuleIntent(rule).oneShot).toBe(false);
  });

  it("6. a state-change trigger that posts is BEHAVIOUR + NOTIFICATION", () => {
    const rule = "When a grant status changes, post to this channel.";
    const r = classifyRuleIntent(rule);

    expect(r.primary).toBe("behaviour");
    expect(r.shapes.map((s) => s.shape)).toEqual(
      expect.arrayContaining(["behaviour", "notification"])
    );
    expect(r.needsClarification).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standing rule vs one-shot ask — the distinction that decides whether anything
// permanent gets built.
// ─────────────────────────────────────────────────────────────────────────────
describe("standing rule vs one-shot ask", () => {
  it("an imperative with no standing marker is one-shot", () => {
    for (const q of [
      "can you summarize the Stellar Grants process",
      "look into why the last sync failed",
      "let's draft the投 proposal", // stray non-ascii must not throw
    ]) {
      expect(classifyRuleIntent(q).oneShot, q).toBe(true);
    }
  });

  it("the same imperative becomes standing once a trigger is added", () => {
    const r = classifyRuleIntent(
      "whenever a new grant lands, summarize it and tell me"
    );
    expect(r.oneShot).toBe(false);
    expect(r.shapes.map((s) => s.shape)).toContain("behaviour");
  });

  it("a distributive quantifier alone makes a sentence standing", () => {
    expect(classifyRuleIntent("each new file should be indexed").oneShot).toBe(
      false
    );
  });

  it("'every <weekday>' is a SCHEDULE, 'every <thing>' is a population", () => {
    expect(shapesOf("every monday, post the digest to the channel")).toContain(
      "schedule"
    );
    expect(shapesOf("every client should be tagged with its grant")).toContain(
      "behaviour"
    );
    expect(
      shapesOf("every client should be tagged with its grant")
    ).not.toContain("schedule");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// needsClarification — we stop and ask rather than pick one and hope.
// ─────────────────────────────────────────────────────────────────────────────
describe("needsClarification", () => {
  it("a trigger with nothing to run names that exact gap", () => {
    const r = classifyRuleIntent("when a new file appears in the drive folder");
    expect(r.needsClarification?.reason).toMatch(/no action follows/i);
    expect(r.needsClarification?.question).toBeTruthy();
  });

  it("a recurrence with no consequent names that exact gap", () => {
    const r = classifyRuleIntent("weekly, on a schedule");
    expect(r.needsClarification?.reason).toMatch(/nothing to fire/i);
  });

  it("one-off framing colliding with a standing marker is a real conflict", () => {
    const r = classifyRuleIntent(
      "for now, when a file lands, index it in the folder"
    );
    expect(r.needsClarification?.reason).toMatch(/one-off request/i);
    expect(r.needsClarification?.question).toMatch(/once|permanently/i);
  });

  it("nonsense returns unknown with a clarification — it never throws", () => {
    for (const q of ["", "   ", "asdf qwer zxcv"]) {
      const r = classifyRuleIntent(q);
      expect(r.primary, JSON.stringify(q)).toBe("unknown");
      expect(r.shapes.map((s) => s.shape)).toEqual(["unknown"]);
      expect(r.needsClarification).toBeDefined();
    }
    expect(classifyRuleIntent("").needsClarification?.reason).toMatch(/empty/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// False-positive guards. Same hazard as the read side: this product's entity
// vocabulary collides with naive substring cues.
// ─────────────────────────────────────────────────────────────────────────────
describe("word boundaries and entity-name collisions", () => {
  it("a cue never fires inside a longer word", () => {
    // "extract" ⊄ "Extractor"; "index" ⊄ "reindex"; "post to" ⊄ "compost total".
    expect(shapesOf("the Extractor plugin belongs to Acme")).not.toContain(
      "extraction"
    );
    expect(shapesOf("reindex the archive")).not.toContain("behaviour");
    expect(shapesOf("Whenevers Ltd is our vendor")).not.toContain("behaviour");
  });

  it("a company literally named Setup / Deploy is not a rule", () => {
    const r = classifyRuleIntent("Setup Inc and Deploy Corp are prospects");
    expect(r.shapes.map((s) => s.shape)).not.toContain("behaviour");
    expect(r.shapes.map((s) => s.shape)).not.toContain("schedule");
  });

  it("an entity named after a source noun does not become an automation", () => {
    // "folder" alone must never imply ingest — the fact + holding-verb gate is
    // what keeps this from building an automation out of a passing mention.
    expect(shapesOf("the Folder Company is a prospect")).not.toContain(
      "behaviour"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Context is SUPPORTING evidence only — it sharpens, it never classifies.
// ─────────────────────────────────────────────────────────────────────────────
describe("optional pod context", () => {
  it("naming a connected capability sharpens behaviour confidence", () => {
    const rule = "When a Calendly event lands, create the person.";
    const without = classifyRuleIntent(rule);
    const with_ = classifyRuleIntent(rule, { capabilities: ["calendly"] });
    expect(with_.shapes[0]!.confidence).toBeGreaterThan(
      without.shapes[0]!.confidence
    );
    expect(with_.shapes[0]!.cues).toContain("capability: calendly");
  });

  it("context alone can never classify an unclassifiable sentence", () => {
    const r = classifyRuleIntent("calendly client", {
      capabilities: ["calendly"],
      profiles: ["client"],
    });
    expect(r.primary).toBe("unknown");
  });

  it("a degenerate profile name cannot match everything", () => {
    // A name of "-" normalizes to "" and would compile to /\b\b/ — the same
    // empty-cue bug documented in classify.ts's catalogWords.
    const r = classifyRuleIntent("one folder per client", {
      profiles: ["-", "_"],
    });
    expect(r.shapes[0]!.cues.some((c) => c.startsWith("profile:"))).toBe(false);
  });
});
