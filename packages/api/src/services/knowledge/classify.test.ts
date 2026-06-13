import { describe, it, expect } from "vitest";
import { classifySubstrates } from "./classify.js";

describe("classifySubstrates", () => {
  it("always includes semantic (the backbone)", () => {
    expect(classifySubstrates("who is the VP of Product").substrates).toContain(
      "semantic"
    );
    expect(classifySubstrates("anything at all").substrates).toContain(
      "semantic"
    );
  });

  it("routes 'how do we deploy' to procedural (primary)", () => {
    const r = classifySubstrates("how do we deploy the backend");
    expect(r.substrates).toContain("procedural");
    expect(r.primary).toBe("procedural");
  });

  it("routes a runbook / step-by-step query to procedural", () => {
    expect(classifySubstrates("the deploy runbook").primary).toBe("procedural");
    expect(
      classifySubstrates("set up kratos step by step").substrates
    ).toContain("procedural");
    expect(classifySubstrates("documentation for the api").primary).toBe(
      "procedural"
    );
  });

  it("routes 'what did I note about X' to episodic (primary)", () => {
    const r = classifySubstrates("what did I note about the CRM redesign");
    expect(r.substrates).toContain("episodic");
    expect(r.primary).toBe("episodic");
  });

  it("routes 'remember when' to episodic", () => {
    expect(
      classifySubstrates("remember when we discussed pricing").primary
    ).toBe("episodic");
  });

  it("a plain entity query stays semantic-only", () => {
    const r = classifySubstrates("the onboarding revamp project");
    expect(r.substrates).toEqual(["semantic"]);
    expect(r.primary).toBe("semantic");
  });

  it("procedural wins over episodic on ties", () => {
    const r = classifySubstrates("remember how to deploy");
    expect(r.primary).toBe("procedural");
    expect(r.substrates).toContain("procedural");
    expect(r.substrates).toContain("episodic");
  });

  // ── False-positive guards: this product's entity vocabulary collides with
  //    naive substring cues ("deploy", "setup", "guide" are common entity names).
  //    Word boundaries + dropping bare-noun cues must keep these semantic-only.
  describe("does NOT mis-route entity-name queries", () => {
    const entityQueries = [
      "the Deploy Helper project", // "deploy" the entity name, not the verb
      "Configure Inc, our client", // "configure" in a company name
      "the Install wizard entity",
      "Footsteps to Freedom album", // must not match "steps to" mid-word
      "Remembrance Inc", // must not match "remember" mid-word
      "the Setup app", // bare "setup" is no longer a cue
      "the Guide Michelin contact", // bare "guide" is no longer a cue
    ];
    for (const q of entityQueries) {
      it(`"${q}" → semantic-only`, () => {
        const r = classifySubstrates(q);
        expect(r.substrates).toEqual(["semantic"]);
        expect(r.primary).toBe("semantic");
      });
    }
  });

  it("empty / whitespace query is semantic-only", () => {
    expect(classifySubstrates("").substrates).toEqual(["semantic"]);
    expect(classifySubstrates("   ").primary).toBe("semantic");
  });
});
