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

  it("routes a runbook/guide query to procedural", () => {
    expect(classifySubstrates("the deploy runbook").primary).toBe("procedural");
    expect(classifySubstrates("setup guide for kratos").substrates).toContain(
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
    // contains both a 'how to' and 'remember'
    const r = classifySubstrates("remember how to deploy");
    expect(r.primary).toBe("procedural");
    expect(r.substrates).toContain("procedural");
    expect(r.substrates).toContain("episodic");
  });
});
