/**
 * A relation proposal is never named by raw ids. `relations.create` stored
 * `title: "<id8> --type--> <id8>"` until 2026-10-14, and the generic summary
 * quoted it — so the card read `Create relation "1a2b3c4d --references-->
 * 5e6f7a8b"`. The producer no longer writes it (relations.create-title.test.ts);
 * this pins the READ for the rows already stored with it: the synthetic string
 * is neither the target name nor the summary.
 */
import { describe, it, expect } from "vitest";
import {
  proposalDisplaySummary,
  proposalPayloadTargetName,
} from "../display.js";

const SYNTHETIC = "1a2b3c4d --references--> 5e6f7a8b";

const legacyRequest = {
  summary: `Create relation "${SYNTHETIC}"`,
  changeType: "create",
  targetType: "relation",
  data: {
    title: SYNTHETIC,
    sourceEntityId: "1a2b3c4d-0000-4000-8000-000000000001",
    targetEntityId: "5e6f7a8b-0000-4000-8000-000000000002",
    type: "references",
  },
} as never;

describe("a stored synthetic relation title names nothing", () => {
  it("is not the relation's target name", () => {
    expect(proposalPayloadTargetName(legacyRequest)).toBeUndefined();
  });

  it("is not the summary — the derivation from the action and kind wins", () => {
    const summary = proposalDisplaySummary({
      proposalType: "relation.create",
      request: legacyRequest,
    });
    expect(summary).toBe("Create Link");
  });

  it("a real name on a relation payload is still kept", () => {
    const named = {
      ...(legacyRequest as Record<string, unknown>),
      summary: 'Create relation "Ada works with Grace"',
      data: { title: "Ada works with Grace" },
    } as never;
    expect(proposalPayloadTargetName(named)).toBe("Ada works with Grace");
    expect(
      proposalDisplaySummary({
        proposalType: "relation.create",
        request: named,
      })
    ).toBe('Create relation "Ada works with Grace"');
  });
});
