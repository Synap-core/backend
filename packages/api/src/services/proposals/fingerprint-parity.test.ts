import { describe, it, expect } from "vitest";
import { computeProposalFingerprint } from "./fingerprint.js";
import { computeFingerprint } from "@synap/jobs/workers/governance-lane-scanner.js";

/**
 * Drift-guard tripwire: `packages/jobs/src/workers/governance-lane-scanner.ts`
 * hand-mirrors `computeProposalFingerprint` (this package's canonical
 * algorithm) because `@synap/jobs` cannot import `@synap/api` (dependency
 * direction is api -> jobs, per root CLAUDE.md). `packages/api` DOES depend
 * on `@synap/jobs`, so this test lives here and imports BOTH implementations.
 *
 * EQUALITY FORM: raw string identity (`toBe`), not just cluster-equivalence
 * — both functions build the SAME string shape
 * `${proposalType}${SEP}${targetType}${SEP}${signature}`, so a stronger
 * assertion is warranted and gives an earlier signal on ANY drift (separator,
 * signature prefix, classify/normalize logic).
 *
 * FIXED DRIFT (found by this tripwire on authoring, corrected same session):
 * `fingerprint.ts`'s `SEP` is a literal NUL byte (`"\0"`, deliberately — see
 * that file's "NUL separator" comment, so a proposalType/targetType/name can
 * never itself contain the separator and collide two distinct triples). The
 * jobs mirror's `computeFingerprint` originally joined with a plain `" "`
 * instead — a 1-character correction in governance-lane-scanner.ts (space ->
 * `"\0"`) brought it back in sync; see that file's git history for the fix.
 *
 * If this test ever fails again: the jobs mirror has drifted from the
 * canonical `computeProposalFingerprint` in fingerprint.ts and must be
 * re-synced by hand (jobs cannot import api, so no shared-module fix is
 * available).
 */
describe("fingerprint parity: api canonical vs jobs mirror", () => {
  const fixtures: Array<{
    label: string;
    proposalType: string;
    targetType: string;
    targetId: string;
    data: unknown;
  }> = [
    {
      label: "create with targetName in envelope",
      proposalType: "create",
      targetType: "entity",
      targetId: "tmp-1",
      data: { targetName: "Acme Corp", data: { industry: "SaaS" } },
    },
    {
      label: "create with title in nested payload",
      proposalType: "create_composite",
      targetType: "entity",
      targetId: "tmp-2",
      data: { data: { title: "  Acme  Corp  " } },
    },
    {
      label: "create with name (case/whitespace variant) on flat payload",
      proposalType: "create",
      targetType: "entity",
      targetId: "tmp-3",
      data: { name: "ACME corp" },
    },
    {
      label: "create with displayName, no envelope nesting",
      proposalType: "workspace.create",
      targetType: "workspace",
      targetId: "tmp-4",
      data: { displayName: "Growth HQ" },
    },
    {
      label: "create with label only",
      proposalType: "import.graph",
      targetType: "entity",
      targetId: "tmp-5",
      data: { label: "Imported Node" },
    },
    {
      label: "create with no usable name falls back to targetId",
      proposalType: "create",
      targetType: "entity",
      targetId: "tmp-6",
      data: { unrelatedField: 42 },
    },
    {
      label: "mutate keyed by targetId, payload irrelevant to signature",
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      data: { properties: { industry: "SaaS" } },
    },
    {
      label: "mutate with nested data.data payload",
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-2",
      data: { data: { properties: { industry: "Fintech" } } },
    },
    {
      label: "mutate with empty targetId falls back to name",
      proposalType: "update",
      targetType: "entity",
      targetId: "",
      data: { name: "Fallback Target" },
    },
    {
      label: "mutate with empty targetId and no name falls back to 'id:'",
      proposalType: "update",
      targetType: "entity",
      targetId: "",
      data: {},
    },
    {
      label: "delete keyed by targetId",
      proposalType: "delete",
      targetType: "entity",
      targetId: "ent-3",
      data: {},
    },
    {
      label: "delete via suffix form (foo.delete)",
      proposalType: "workspace.delete",
      targetType: "workspace",
      targetId: "ws-1",
      data: {},
    },
    {
      label: "mutate via unrecognized verb (merge)",
      proposalType: "merge",
      targetType: "entity",
      targetId: "ent-4",
      data: {},
    },
  ];

  for (const f of fixtures) {
    it(`agrees on: ${f.label}`, () => {
      const input = {
        proposalType: f.proposalType,
        targetType: f.targetType,
        targetId: f.targetId,
        data: f.data,
      };
      const apiFingerprint = computeProposalFingerprint(input);
      const jobsFingerprint = computeFingerprint(input);
      expect(jobsFingerprint).toBe(apiFingerprint);
    });
  }
});
