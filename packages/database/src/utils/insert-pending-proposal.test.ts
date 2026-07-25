import { describe, it, expect } from "vitest";
import { computeProposalDedupHash } from "./insert-pending-proposal.js";

/**
 * Locks the canonical dedup-hash normalization — the subtle contract the
 * pending-proposal dedup guard relies on. If any of these change, agent retries
 * would either stop deduping (duplicates leak) or over-dedup (distinct writes
 * collapse).
 */
describe("computeProposalDedupHash", () => {
  const base = {
    workspaceId: "ws-1",
    targetType: "entity",
    data: { profileSlug: "task", title: "Ship the thing" },
  };

  it("CREATE excludes targetId — two attempts with different fresh targetIds hash equal", () => {
    // permission-check builds a create's targetId as `data.id ?? randomUUID()`,
    // so each attempt gets a different id. It must NOT enter the hash, or dedup
    // could never fire for the dominant duplicate source.
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "random-uuid-A",
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "random-uuid-B",
    });
    expect(a).toBe(b);
  });

  it("non-CREATE includes targetId — same payload on different targets hashes differently", () => {
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "update",
      targetId: "entity-1",
      data: { title: "Rename" },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "update",
      targetId: "entity-2",
      data: { title: "Rename" },
    });
    expect(a).not.toBe(b);
  });

  it("strips per-attempt volatile envelope keys — same change hashes equal despite fresh ids/prose", () => {
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "x",
      data: {
        profileSlug: "task",
        title: "Ship the thing",
        requestId: "req-1",
        correlationId: "corr-1",
        requestedEventId: "evt-1",
        reasoning: "Because A",
        summary: "Create task",
      },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "y",
      data: {
        profileSlug: "task",
        title: "Ship the thing",
        requestId: "req-2",
        correlationId: "corr-2",
        requestedEventId: "evt-2",
        reasoning: "Because B",
        summary: "Make task",
      },
    });
    expect(a).toBe(b);
  });

  it("strips a top-level `id` — two creates with identical content but different pre-generated ids hash equal (G2)", () => {
    // The create door mints `data.id = randomUUID()` per attempt and stores it
    // (the materializer reads it on approval). If `id` entered the hash, every
    // create attempt would hash uniquely and create-dedup could never fire.
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "t-A",
      data: { id: "id-A", profileSlug: "task", title: "Ship the thing" },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "t-B",
      data: { id: "id-B", profileSlug: "task", title: "Ship the thing" },
    });
    expect(a).toBe(b);
  });

  it("still distinguishes creates whose non-id content differs (id strip is not over-broad)", () => {
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "t-A",
      data: { id: "id-A", profileSlug: "task", title: "One" },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "t-B",
      data: { id: "id-B", profileSlug: "task", title: "Two" },
    });
    expect(a).not.toBe(b);
  });

  it("is key-order independent (stable stringify)", () => {
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "x",
      data: { title: "T", profileSlug: "task", properties: { a: 1, b: 2 } },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "y",
      data: { properties: { b: 2, a: 1 }, profileSlug: "task", title: "T" },
    });
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different payloads", () => {
    const a = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "x",
      data: { profileSlug: "task", title: "Thing one" },
    });
    const b = computeProposalDedupHash({
      ...base,
      proposalType: "create",
      targetId: "y",
      data: { profileSlug: "task", title: "Thing TWO" },
    });
    expect(a).not.toBe(b);
  });

  it("scopes by workspace — same change in different workspaces hashes differently", () => {
    const a = computeProposalDedupHash({
      workspaceId: "ws-1",
      proposalType: "create",
      targetType: "entity",
      targetId: "x",
      data: { title: "T" },
    });
    const b = computeProposalDedupHash({
      workspaceId: "ws-2",
      proposalType: "create",
      targetType: "entity",
      targetId: "y",
      data: { title: "T" },
    });
    expect(a).not.toBe(b);
  });
});
