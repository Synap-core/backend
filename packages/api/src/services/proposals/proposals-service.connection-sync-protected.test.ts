import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/**
 * `data.connectionSync` is SYSTEM-authored (the connection-sync door stamps it on
 * a connection's import.graph) and an authority input: it decides whether
 * approval mints a connection's `auto` rule and whether every materialized write
 * is tagged `origin: "sync"` (skipping event automations). No revise door may set
 * or alter it. Driven through the shared revise core that tRPC
 * `revise`, Hub `updateProposal` and MCP `synap_revise_proposal` all use.
 */

const STAMP = {
  connectionId: "conn-1",
  provider: "google",
  kinds: ["contact"],
  keepSyncing: true,
};

/** A connection's first-sync import.graph — a FLAT composite envelope. */
const syncImport = () => ({
  requestId: "req-sync",
  source: "connector_sync",
  operations: [{ op: "create_entity", profileSlug: "person", title: "Ada" }],
  connectionSync: { ...STAMP },
});

/** An ordinary pending import with no stamp — the planting target. */
const plainImport = () => ({
  requestId: "req-plain",
  source: "agent",
  operations: [{ op: "create_entity", profileSlug: "task", title: "t" }],
});

describe("computeRevisedEnvelope — connectionSync is not revisable", () => {
  it("refuses an inner patch that alters the stamp (keepSyncing flip)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: syncImport(),
        patch: {
          kind: "inner",
          fields: { connectionSync: { ...STAMP, keepSyncing: false } },
        },
      })
    ).toThrow(/connectionSync/);
  });

  it("refuses PLANTING a stamp on an ordinary pending import (automation suppression / rule mint)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: plainImport(),
        patch: {
          kind: "inner",
          fields: { connectionSync: { connectionId: "x" } },
        },
      })
    ).toThrow(/connectionSync/);
  });

  it("refuses the nested form (an envelope patch carrying data.connectionSync)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: plainImport(),
        patch: {
          kind: "envelope",
          fields: { data: { connectionSync: { connectionId: "x" } } },
        },
      })
    ).toThrow(/connectionSync/);
  });

  it("a legitimate revise of the operations still works and keeps the stamp byte-identical", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: syncImport(),
      patch: {
        kind: "inner",
        fields: {
          operations: [
            { op: "create_entity", profileSlug: "person", title: "Ada L." },
          ],
        },
      },
    });
    expect((merged.operations as Array<{ title: string }>)[0]!.title).toBe(
      "Ada L."
    );
    expect(merged.connectionSync).toEqual(STAMP);
  });
});
