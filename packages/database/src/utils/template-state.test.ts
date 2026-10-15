/**
 * `readTemplateState` — the ONE reader — over every legacy combination the
 * writers produced before `settings.template` existed, and the predicates
 * built on it.
 *
 * `templateApplyUnfinished` was reimplemented over the reader; the OLD body is
 * kept below as the reference and compared on every row, so the derivation
 * provably answers what the readers answered before (a sameness check — the
 * expected `state` column is what pins correctness).
 */
import { describe, it, expect } from "vitest";
import {
  readTemplateState,
  mergeTemplateState,
  legacyMirror,
  withPack,
  isFailedInLayerTwo,
  isTemplateApplyUnfinished,
  type TemplateState,
} from "./template-state.js";
import { templateApplyUnfinished } from "./template-apply-state.js";

/** The predicate as it was before the state object (git: template-apply-state.ts). */
function oldUnfinished(settings: unknown): boolean {
  const s = (settings ?? {}) as {
    provisioningStatus?: unknown;
    templateApply?: unknown;
  };
  return (
    s.provisioningStatus === "failed" ||
    (!!s.templateApply && typeof s.templateApply === "object")
  );
}
/** `failedInLayerTwo` as it was (api workspace-creation-service.ts). */
function oldFailedInLayerTwo(settings: any): boolean {
  return (
    settings?.provisioningStatus === "failed" &&
    settings.failedStep === "post-workspace"
  );
}

type Row = {
  name: string;
  settings: Record<string, unknown> | null;
  columns?: { packageSlug?: string | null; provisioningStatus?: string | null };
  expect: Partial<TemplateState> | null;
};

const ROWS: Row[] = [
  { name: "plain space, nothing recorded", settings: {}, expect: null },
  { name: "null settings", settings: null, expect: null },
  {
    name: "fresh create in flight (create util initial write)",
    settings: {
      provisioningStatus: "pending",
      provisioningStartedAt: "2026-10-01T00:00:00.000Z",
      completedSteps: [],
      packageSlug: "crm",
    },
    expect: {
      slug: "crm",
      version: null,
      state: "building",
      completedSteps: [],
      at: "2026-10-01T00:00:00.000Z",
    },
  },
  {
    name: "layer 1 finished, finisher not run yet",
    settings: {
      provisioningStatus: "pending",
      completedSteps: ["workspace", "member", "profiles"],
      failedStep: null,
      failedStepError: null,
      packageSlug: "crm",
    },
    expect: {
      state: "building",
      completedSteps: ["workspace", "member", "profiles"],
    },
  },
  {
    name: "converged (finisher stamped, record cleared)",
    settings: {
      provisioningStatus: "active",
      packageSlug: "crm",
      packageVersion: "h-1",
      templateApply: null,
    },
    expect: { slug: "crm", version: "h-1", state: "active" },
  },
  {
    name: "awaiting approval — the stamp stays the OLD version",
    settings: {
      provisioningStatus: "active",
      packageSlug: "crm",
      packageVersion: "h-1",
      templateApply: {
        state: "awaiting-approval",
        version: "h-2",
        at: "2026-10-12T00:00:00.000Z",
        proposals: ["p1"],
      },
    },
    expect: {
      state: "awaiting-approval",
      version: "h-1",
      pendingVersion: "h-2",
      proposals: ["p1"],
      at: "2026-10-12T00:00:00.000Z",
    },
  },
  {
    name: "partial",
    settings: {
      provisioningStatus: "active",
      packageSlug: "crm",
      templateApply: {
        state: "partial",
        version: null,
        at: "x",
        failures: ["playbooks:Qualify"],
      },
    },
    expect: {
      state: "partial",
      pendingVersion: null,
      failures: ["playbooks:Qualify"],
    },
  },
  {
    name: "layer 2 re-opened (reopenFailedLayerTwo)",
    settings: {
      provisioningStatus: "active",
      failedStep: null,
      failedStepError: null,
      packageSlug: "crm",
      templateApply: { state: "layer-2-not-run", version: "h-2", at: "x" },
    },
    expect: { state: "layer-2-not-run", pendingVersion: "h-2" },
  },
  {
    name: "layer-1 failure with a resume ledger",
    settings: {
      provisioningStatus: "failed",
      failedStep: "profiles[company].create",
      failedStepError: "boom",
      completedSteps: ["workspace", "member"],
      packageSlug: "crm",
    },
    expect: {
      state: "failed",
      failedLayer: 1,
      failedStep: "profiles[company].create",
      error: "boom",
      completedSteps: ["workspace", "member"],
    },
  },
  {
    name: "founder CRM: layer-2 failure, stale stamp, no completedSteps",
    settings: {
      provisioningStatus: "failed",
      failedStep: "post-workspace",
      failedStepError: "Failed to apply action placements",
      packageSlug: "crm",
      packageVersion: "h-old",
    },
    expect: {
      slug: "crm",
      version: "h-old",
      state: "failed",
      failedLayer: 2,
      failedStep: "post-workspace",
    },
  },
  {
    name: "failed wins over an older templateApply record",
    settings: {
      provisioningStatus: "failed",
      failedStep: "post-workspace",
      packageSlug: "crm",
      templateApply: { state: "awaiting-approval", version: "h-2", at: "x" },
    },
    expect: { state: "failed", failedLayer: 2 },
  },
  {
    name: "failed with no step recorded = layer 1",
    settings: { provisioningStatus: "failed" },
    expect: { slug: null, state: "failed", failedLayer: 1 },
  },
  {
    name: "a templateApply record of unknown shape still reads unfinished",
    settings: { packageSlug: "crm", templateApply: { state: "weird" } },
    expect: { state: "layer-2-not-run" },
  },
  {
    name: "pre-status legacy space: slug + stamp, no provisioningStatus",
    settings: { packageSlug: "crm", packageVersion: "1.0.0" },
    expect: { slug: "crm", version: "1.0.0", state: "active" },
  },
  {
    name: "plugin seed (invites seedPlugin)",
    settings: { provisioningStatus: "active", packageSlug: "devplane" },
    expect: { slug: "devplane", state: "active" },
  },
  {
    name: "a plain space that only carries packs (legacy '' = no version)",
    settings: {
      installedPacks: [
        { slug: "sales-pack", version: "", installedAt: "t1" },
        { slug: "view-pack", version: "1.2.0", installedAt: "t2" },
        { nope: true },
      ],
    },
    expect: {
      slug: null,
      state: "active",
      packs: [
        { slug: "sales-pack", version: null, installedAt: "t1" },
        { slug: "view-pack", version: "1.2.0", installedAt: "t2" },
      ],
    },
  },
  {
    name: "slug only on the promoted column",
    settings: { provisioningStatus: "active" },
    columns: { packageSlug: "crm", provisioningStatus: "active" },
    expect: { slug: "crm", state: "active" },
  },
  {
    name: "status only on the promoted column",
    settings: { packageSlug: "crm" },
    columns: { provisioningStatus: "pending" },
    expect: { state: "building" },
  },
];

describe("readTemplateState — legacy derivation", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const got = readTemplateState(row.settings, row.columns);
      if (row.expect === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).toMatchObject(row.expect);
    });
  }

  it("the table covers every state and both failed layers (non-vacuity)", () => {
    const seen = new Set(
      ROWS.map((r) => readTemplateState(r.settings, r.columns)).flatMap((t) =>
        t ? [t.state === "failed" ? `failed:${t.failedLayer}` : t.state] : []
      )
    );
    expect([...seen].sort()).toEqual(
      [
        "active",
        "awaiting-approval",
        "building",
        "failed:1",
        "failed:2",
        "layer-2-not-run",
        "partial",
      ].sort()
    );
  });

  it("templateApplyUnfinished answers exactly what it answered before, on every row", () => {
    for (const row of ROWS) {
      if (row.columns) continue; // the old predicate never saw columns
      expect([row.name, templateApplyUnfinished(row.settings)]).toEqual([
        row.name,
        oldUnfinished(row.settings),
      ]);
    }
  });

  it("isFailedInLayerTwo answers exactly what failedInLayerTwo answered, on every row", () => {
    for (const row of ROWS) {
      if (row.columns) continue;
      expect([
        row.name,
        isFailedInLayerTwo(readTemplateState(row.settings)),
      ]).toEqual([row.name, oldFailedInLayerTwo(row.settings)]);
    }
  });

  it("settings.template wins over the legacy keys", () => {
    const t = readTemplateState({
      provisioningStatus: "failed",
      packageVersion: "h-old",
      template: { slug: "crm", version: "h-2", state: "active", at: "t" },
    });
    expect(t).toEqual({
      slug: "crm",
      version: "h-2",
      state: "active",
      at: "t",
    });
    expect(
      templateApplyUnfinished({ template: t, provisioningStatus: "failed" })
    ).toBe(false);
  });

  it.each([["exploded"], [""], [42], [null]])(
    "an UNKNOWN stored state (%j) reads as unfinished, never as a converged 'active' (review S6 — the legacy path's conservative reading)",
    (state) => {
      const t = readTemplateState({
        template: { slug: "crm", version: "h-2", state, at: "t" },
      });
      expect(t?.state).toBe("layer-2-not-run");
      expect(isTemplateApplyUnfinished(t)).toBe(true);
    }
  );
});

describe("mergeTemplateState + legacyMirror", () => {
  const failed: TemplateState = {
    slug: "crm",
    version: "h-old",
    state: "failed",
    failedLayer: 2,
    failedStep: "post-workspace",
    error: "boom",
    at: "t0",
  };

  it("leaving 'failed' drops the failure fields; the mirror clears them with null", () => {
    const next = mergeTemplateState(
      failed,
      { state: "layer-2-not-run", pendingVersion: "h-2" },
      "t1"
    );
    expect(next).toEqual({
      slug: "crm",
      version: "h-old",
      state: "layer-2-not-run",
      pendingVersion: "h-2",
      at: "t1",
    });
    const m = legacyMirror(next);
    expect(m.set).toMatchObject({
      provisioningStatus: "active",
      failedStep: null,
      failedStepError: null,
      packageSlug: "crm",
      packageVersion: "h-old",
      templateApply: { state: "layer-2-not-run", version: "h-2", at: "t1" },
    });
    expect(m.remove.sort()).toEqual(["completedSteps", "installedPacks"]);
  });

  it("converging drops the unfinished record and stamps", () => {
    const awaiting = mergeTemplateState(
      null,
      {
        slug: "crm",
        state: "awaiting-approval",
        pendingVersion: "h-2",
        proposals: ["p"],
      },
      "t0"
    );
    const done = mergeTemplateState(
      awaiting,
      { state: "active", version: "h-2" },
      "t1"
    );
    expect(done).toEqual({
      slug: "crm",
      version: "h-2",
      state: "active",
      at: "t1",
    });
    expect(legacyMirror(done).set.templateApply).toBeNull();
  });

  it("null clears an optional field; a cleared stamp is REMOVED from the mirror", () => {
    const next = mergeTemplateState(
      { ...failed, state: "active", completedSteps: ["workspace"] },
      { version: null, completedSteps: null },
      "t1"
    );
    expect(next.version).toBeNull();
    expect(next.completedSteps).toBeUndefined();
    expect(legacyMirror(next).remove).toEqual(
      expect.arrayContaining(["packageVersion", "completedSteps"])
    );
  });

  it("building mirrors 'pending'; failed mirrors its step and error", () => {
    expect(
      legacyMirror(mergeTemplateState(null, { state: "building" }, "t")).set
        .provisioningStatus
    ).toBe("pending");
    expect(legacyMirror(failed).set).toMatchObject({
      provisioningStatus: "failed",
      failedStep: "post-workspace",
      failedStepError: "boom",
      templateApply: null,
    });
  });

  it("a round trip through the mirror reads back the same state", () => {
    for (const t of [
      failed,
      mergeTemplateState(
        null,
        {
          slug: "crm",
          state: "partial",
          failures: ["a"],
          pendingVersion: "h-2",
        },
        "t"
      ),
      mergeTemplateState(
        null,
        { slug: "crm", state: "building", completedSteps: ["workspace"] },
        "t"
      ),
    ]) {
      const back = readTemplateState(legacyMirror(t).set);
      expect(back).toMatchObject({ ...t, at: expect.any(String) });
      expect(isTemplateApplyUnfinished(back)).toBe(
        isTemplateApplyUnfinished(t)
      );
    }
  });

  it("withPack: undefined keeps the version, a version replaces it, installedAt is the first", () => {
    let packs = withPack(undefined, { slug: "a" }, "t1");
    expect(packs).toEqual([{ slug: "a", version: null, installedAt: "t1" }]);
    packs = withPack(packs, { slug: "a", version: "1.0" }, "t2");
    expect(packs).toEqual([{ slug: "a", version: "1.0", installedAt: "t1" }]);
    packs = withPack(packs, { slug: "a" }, "t3");
    expect(packs).toEqual([{ slug: "a", version: "1.0", installedAt: "t1" }]);
  });
});

describe("heldForDataChanges — the stamp held for a data change", () => {
  const base = { slug: "crm", version: "v1", state: "active", at: "t" };
  it("is read back from settings.template, both forms", () => {
    expect(
      readTemplateState({
        template: { ...base, heldForDataChanges: ["lead-to-facet"] },
      })
    ).toMatchObject({ heldForDataChanges: ["lead-to-facet"] });
    const unreadable = readTemplateState({
      template: {
        ...base,
        heldForDataChanges: [],
        heldForDataChangesUnreadable: true,
      },
    });
    expect(unreadable).toMatchObject({
      heldForDataChanges: [],
      heldForDataChangesUnreadable: true,
    });
  });
  it("absent or malformed reads as nothing held", () => {
    const plain = readTemplateState({ template: base });
    expect(plain?.heldForDataChanges).toBeUndefined();
    const bad = readTemplateState({
      template: {
        ...base,
        heldForDataChanges: "lead-to-facet",
        heldForDataChangesUnreadable: "yes",
      },
    });
    expect(bad?.heldForDataChanges).toBeUndefined();
    expect(bad?.heldForDataChangesUnreadable).toBeUndefined();
  });
  it("a patch of null clears both", () => {
    const held = readTemplateState({
      template: {
        ...base,
        heldForDataChanges: [],
        heldForDataChangesUnreadable: true,
      },
    });
    const next = mergeTemplateState(
      held,
      { heldForDataChanges: null, heldForDataChangesUnreadable: null },
      "t2"
    );
    expect(next.heldForDataChanges).toBeUndefined();
    expect(next.heldForDataChangesUnreadable).toBeUndefined();
  });
});
