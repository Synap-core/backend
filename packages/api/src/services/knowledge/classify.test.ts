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

  // ── STRUCTURED: enumerative + a named profile → a typed listing (primary) ──
  describe("structured (enumerative) routing", () => {
    it("'list my tasks' routes to structured (primary), semantic still runs", () => {
      const r = classifySubstrates("list my tasks");
      expect(r.substrates).toContain("structured");
      expect(r.substrates).toContain("semantic");
      expect(r.primary).toBe("structured");
    });

    it("plural-tolerant: 'which deals are open' → structured", () => {
      const r = classifySubstrates("which deals are open");
      expect(r.primary).toBe("structured");
    });

    it("leading 'what' + profile noun: 'what tasks are open right now' → structured with status", () => {
      const r = classifySubstrates("what tasks are open right now");
      expect(r.primary).toBe("structured");
      expect(r.structuredStatus).toBe("open");
    });

    it("mid-sentence 'what' does not trigger the lead cue: 'remember what the task said' stays episodic", () => {
      const r = classifySubstrates("remember what the task said");
      expect(r.substrates).not.toContain("structured");
    });

    it("'who are my contacts' → structured (person cue)", () => {
      expect(classifySubstrates("who are my contacts").primary).toBe(
        "structured"
      );
    });

    it("'what are my open tasks' carries the task status filter", () => {
      const r = classifySubstrates("what are my open tasks");
      expect(r.primary).toBe("structured");
      expect(r.structuredStatus).toBe("open");
    });

    it("maps 'completed' / 'done' status words", () => {
      expect(
        classifySubstrates("list my completed tasks").structuredStatus
      ).toBe("completed");
      expect(classifySubstrates("show my done tasks").structuredStatus).toBe(
        "done"
      );
    });

    it("no status word → no structuredStatus", () => {
      expect(
        classifySubstrates("list my tasks").structuredStatus
      ).toBeUndefined();
    });

    it("status is task-scoped: 'list my open companies' carries none", () => {
      expect(
        classifySubstrates("list my open companies").structuredStatus
      ).toBeUndefined();
    });

    it("an enumerative lead WITHOUT a named profile stays semantic-only", () => {
      const r = classifySubstrates("list everything interesting");
      expect(r.substrates).toEqual(["semantic"]);
      expect(r.primary).toBe("semantic");
    });

    it("a singular lookup ('what is the Acme deal') does NOT fire structured", () => {
      // "what is" is not a collection lead — no enumerative intent.
      const r = classifySubstrates("what is the Acme deal");
      expect(r.substrates).not.toContain("structured");
      expect(r.primary).toBe("semantic");
    });

    it("episodic suppresses structured: 'what did I note about the project'", () => {
      const r = classifySubstrates("what did I note about the project");
      expect(r.substrates).not.toContain("structured");
      expect(r.primary).toBe("episodic");
    });

    it("procedural suppresses structured: 'how to list my tasks'", () => {
      const r = classifySubstrates("how to list my tasks");
      expect(r.substrates).not.toContain("structured");
      expect(r.primary).toBe("procedural");
    });
  });
});
