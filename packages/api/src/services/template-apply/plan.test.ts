/**
 * `planTemplateApply` as a table. Every row is an input where at least two of
 * the retired per-door rules DISAGREED (guards-and-tests: a fixture row that
 * rules nothing out is decoration):
 *   - the core's `resumeIfFailed` resumed EVERY failed space through the create
 *     core (a ledger-less one minted a second space / 409);
 *   - the core's version compare skipped an unfinished space whose stamp still
 *     matched (layer 2 never re-ran);
 *   - `failedInLayerTwo` re-synced only layer-2 failures.
 */
import { describe, it, expect } from "vitest";
import type { TemplateState } from "@synap/database";
import { planTemplateApply } from "./plan.js";

const st = (over: Partial<TemplateState>): TemplateState => ({
  slug: "crm",
  version: "h-1",
  state: "active",
  at: "",
  ...over,
});

describe("planTemplateApply", () => {
  const rows: Array<
    [string, Parameters<typeof planTemplateApply>[0], unknown]
  > = [
    ["no space → create", { target: null, version: "h-1" }, { kind: "create" }],
    [
      "failed in layer 1 WITH the row step → resume from the ledger",
      {
        target: {
          state: st({
            state: "failed",
            failedLayer: 1,
            completedSteps: ["workspace", "profiles"],
          }),
        },
        version: "h-1",
      },
      { kind: "resume-layer1", completedSteps: ["workspace", "profiles"] },
    ],
    [
      "failed in layer 1 with NO ledger → re-sync the existing row, never re-create",
      {
        target: { state: st({ state: "failed", failedLayer: 1 }) },
        version: "h-1",
      },
      { kind: "resync", reason: "failed-no-ledger", reopen: true },
    ],
    [
      "failed in layer 2 with a matching (untrusted) stamp → re-sync + reopen",
      {
        target: {
          state: st({ state: "failed", failedLayer: 2, version: "h-1" }),
        },
        version: "h-1",
      },
      { kind: "resync", reason: "failed-layer-2", reopen: true },
    ],
    [
      "awaiting approval at the SAME version → re-sync (the stamp was not earned)",
      {
        target: { state: st({ state: "awaiting-approval" }) },
        version: "h-1",
      },
      { kind: "resync", reason: "unfinished", reopen: false },
    ],
    [
      "unfinished with no version signal → still re-sync",
      { target: { state: st({ state: "partial" }) }, version: undefined },
      { kind: "resync", reason: "unfinished", reopen: false },
    ],
    [
      "active at another version → stale re-sync",
      { target: { state: st({}) }, version: "h-2" },
      { kind: "resync", reason: "stale", reopen: false },
    ],
    [
      "active at the same version → unchanged (checked)",
      { target: { state: st({}) }, version: "h-1" },
      { kind: "unchanged", checked: true },
    ],
    [
      "no version to compare → unchanged, unchecked",
      { target: { state: st({}) }, version: undefined },
      { kind: "unchanged", checked: false },
    ],
    [
      "adopting a space whose stamp equals the version → re-sync (it was never this template's)",
      {
        target: { state: st({ slug: "orphan" }) },
        version: "h-1",
        adopting: true,
      },
      { kind: "resync", reason: "adopt", reopen: false },
    ],
    [
      "adopting with no version signal → still re-sync (unchanged would skip layer 1)",
      { target: { state: null }, version: undefined, adopting: true },
      { kind: "resync", reason: "adopt", reopen: false },
    ],
    [
      "adopting a space that failed (with a ledger) → re-sync + reopen, never a resume",
      {
        target: {
          state: st({
            state: "failed",
            failedLayer: 1,
            completedSteps: ["workspace"],
          }),
        },
        version: "h-1",
        adopting: true,
      },
      { kind: "resync", reason: "adopt", reopen: true },
    ],
    [
      "a plain space (no state) at a known version → stale re-sync",
      { target: { state: null }, version: "h-1" },
      { kind: "resync", reason: "stale", reopen: false },
    ],
  ];

  it.each(rows)("%s", (_name, input, expected) => {
    expect(planTemplateApply(input)).toEqual(expected);
  });
});
