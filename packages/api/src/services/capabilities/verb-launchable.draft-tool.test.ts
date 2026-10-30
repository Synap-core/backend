/**
 * A verb's second switch — its TOOL (`tools.approved`). The dispatch refuses a
 * draft tool for every verb but a declarative read (`alreadyApproved` skips the
 * tool gate), so on a draft tool the reads run and the writes fail. Live pod
 * 2026-10-30, hetzner_cloud: reads ran, an approved hcloud_create_server failed
 * at apply with "installed but not enabled", and the listing said the whole
 * integration was off. These predicates are the ONE spelling the dispatch, the
 * listing and the pack card share.
 */
import { describe, expect, it } from "vitest";
import { draftToolRefusesVerb, providerCallIsRead } from "./verb-launchable.js";
import { resolveCapabilityBlock } from "./capability-enable-link.js";

describe("providerCallIsRead — the dispatch's read test", () => {
  it("GET and HEAD are reads; every other method, or none, is a write", () => {
    expect(providerCallIsRead({ method: "GET" })).toBe(true);
    expect(providerCallIsRead({ method: "head" })).toBe(true);
    expect(providerCallIsRead({ method: "POST" })).toBe(false);
    expect(providerCallIsRead({ method: "DELETE" })).toBe(false);
    expect(providerCallIsRead({})).toBe(false);
    expect(providerCallIsRead(null)).toBe(false);
  });

  it("GraphQL reads by operation: a query is a read, a mutation (the default) is not", () => {
    expect(
      providerCallIsRead({
        transport: "graphql",
        method: "POST",
        graphql: { operation: "query" },
      })
    ).toBe(true);
    expect(providerCallIsRead({ transport: "graphql", method: "POST" })).toBe(
      false
    );
  });
});

describe("draftToolRefusesVerb", () => {
  it("a draft tool refuses its writes and lets its declarative reads run", () => {
    expect(
      draftToolRefusesVerb({
        toolApproved: false,
        providerSpec: { method: "POST" },
      })
    ).toBe(true);
    expect(
      draftToolRefusesVerb({
        toolApproved: false,
        providerSpec: { method: "GET" },
      })
    ).toBe(false);
  });

  it("a non-declarative verb (no spec) is refused on a draft tool", () => {
    expect(draftToolRefusesVerb({ toolApproved: false })).toBe(true);
  });

  it("an approved tool, or one with no approval column, refuses nothing", () => {
    expect(
      draftToolRefusesVerb({
        toolApproved: true,
        providerSpec: { method: "POST" },
      })
    ).toBe(false);
    expect(draftToolRefusesVerb({ toolApproved: null })).toBe(false);
  });
});

describe("resolveCapabilityBlock — a draft tool whose reads still run", () => {
  it("says SOME of its actions are off, never that all are", () => {
    expect(
      resolveCapabilityBlock({
        name: "hetzner_cloud",
        containerId: "3e4ac1b4",
        enabled: false,
        partial: true,
      })?.hint
    ).toBe("Some of its actions are off. Turn them on to use them.");
    expect(
      resolveCapabilityBlock({
        name: "hetzner_cloud",
        containerId: "3e4ac1b4",
        enabled: false,
      })?.hint
    ).toBe("Its actions are off. Turn them on to use it.");
  });
});
