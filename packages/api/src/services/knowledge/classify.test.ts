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

  // Procedural is ALWAYS queried — the cue decides ORDER, not access. Gating
  // access on a hand-written cue list meant a procedurally-shaped question
  // asked without one of those exact words never touched `knowledge_keys`:
  // the runbook was present, ranked well, and simply never searched.
  it("a plain entity query leads with semantic, and still reaches procedural", () => {
    const r = classifySubstrates("the onboarding revamp project");
    expect(r.substrates).toEqual(["semantic", "procedural"]);
    expect(r.primary, "an uncued query must not be LED by procedural").toBe(
      "semantic"
    );
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
      it(`"${q}" → semantic-led, not procedural-led`, () => {
        const r = classifySubstrates(q);
        // The guard that matters is PRIMARY: an entity name colliding with a
        // cue word must not make the answer how-to-shaped. Procedural being in
        // `substrates` is now unconditional and carries no such risk.
        expect(r.primary).toBe("semantic");
        expect(r.substrates).not.toContain("episodic");
        expect(r.substrates).not.toContain("structured");
      });
    }
  });

  it("empty / whitespace query is semantic-led", () => {
    expect(classifySubstrates("").substrates).toEqual([
      "semantic",
      "procedural",
    ]);
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

    it("an enumerative lead WITHOUT a named profile does NOT fire structured", () => {
      const r = classifySubstrates("list everything interesting");
      // The guard is about `structured`, which needs a named profile to be
      // meaningful. Procedural is unconditional and unrelated to it.
      expect(r.substrates).not.toContain("structured");
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

  // ── Catalog-driven kinds ───────────────────────────────────────────────────
  // Regression guard for a live defect: a pod holding 20 `client` role-facets
  // answered "list our clients" with "you have no clients". KIND_CUES is a
  // hardcoded 9-key map with NO role profiles, so the enumerative gate could
  // never name one, and the structured lane never ran. The catalog arm fixes it.
  describe("role profiles are reachable via the pod catalog", () => {
    const catalog = [
      { slug: "client", displayName: "Client", plural: "clients" },
      {
        slug: "team-member",
        displayName: "Team Member",
        plural: "team members",
      },
      {
        slug: "company",
        displayName: "Company",
        plural: "companies",
        synonyms: ["account"],
      },
    ];

    it("WITHOUT a catalog, a role noun cannot reach structured (the bug)", () => {
      const r = classifySubstrates("list our clients");
      expect(r.substrates).not.toContain("structured");
    });

    it("WITH the catalog, 'list our clients' routes to structured", () => {
      const r = classifySubstrates("list our clients", catalog);
      expect(r.substrates).toContain("structured");
      expect(r.primary).toBe("structured");
    });

    it("matches a multi-word slug via its spaced form ('team members')", () => {
      const r = classifySubstrates("list all team members", catalog);
      expect(r.substrates).toContain("structured");
    });

    it("matches a profile's synonym, so a renamed kind works ('accounts')", () => {
      const r = classifySubstrates("list all accounts", catalog);
      expect(r.substrates).toContain("structured");
    });

    it("a catalog does NOT make every query enumerative", () => {
      // No collection lead → still not structured, catalog or not.
      const r = classifySubstrates("what is the Acme client", catalog);
      expect(r.substrates).not.toContain("structured");
    });

    it("procedural still suppresses structured even with a catalog match", () => {
      const r = classifySubstrates("how to list our clients", catalog);
      expect(r.substrates).not.toContain("structured");
      expect(r.primary).toBe("procedural");
    });

    // The enumerative gate has TWO arms. Extending only the first left this
    // phrasing broken — and it is the exact shape that answered "you have no
    // clients" over a pod holding 20 of them.
    it("the 'what <kind> do we have' arm also sees the catalog", () => {
      const r = classifySubstrates("what clients do we have", catalog);
      expect(r.substrates).toContain("structured");
    });

    it("'who are our clients' routes to structured", () => {
      const r = classifySubstrates("who are our clients", catalog);
      expect(r.substrates).toContain("structured");
    });
  });

  // A false positive is not merely a wasted query: `structured` becomes primary,
  // and the structured lane resolves its slug from a DIFFERENT resolver — so a
  // bogus match can drag an unrelated kind's 200-row enumeration to the front.
  describe("catalog matching does not over-fire", () => {
    it("a degenerate slug cannot match every query containing 's'", () => {
      // "-" is non-empty as authored but normalizes to "", and an empty cue
      // makes tokenSet.has("s") true for any query mentioning "s".
      const r = classifySubstrates("list all s things", [
        { slug: "-", displayName: "-" },
      ]);
      expect(r.substrates).not.toContain("structured");
    });

    it("an empty catalog behaves exactly like no catalog", () => {
      expect(classifySubstrates("list our clients", []).substrates).toEqual(
        classifySubstrates("list our clients").substrates
      );
    });
  });
});
