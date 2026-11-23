/**
 * Pod updates' Renderers row: (status) → state and action, driven from the
 * pod's wire shape through the parser the object frame uses; a failed install
 * → the refusal it words, read from `error.data.reasonCode`; and every reason
 * the pod's renderer fetch can throw is worded (read from the pod's SOURCE,
 * so a new reason joins this test by existing).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { catalogProblems } from "@synap-core/types/i18n";
import type { PackageUpdateReceipt } from "@synap-core/types/package-updates";

vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import { readRenderersStatus } from "../../../_lib/object/content/use-object-renderer";
import { en, fr } from "./copy";
import {
  SYNAP_RENDERERS_SLUG,
  WORDED_REASONS,
  readRenderersUpdates,
  renderersRefusalOf,
  renderersRowView,
  renderersUpdatesView,
} from "./renderers-model";

/** `renderers.status` as the pod sends it. */
const wire = (bundle: Record<string, unknown> | null) => ({
  bundle,
  defaults: {},
  installed: [],
});

const view = (bundle: Record<string, unknown> | null) => {
  const status = readRenderersStatus(wire(bundle));
  if (!status) throw new Error("fixture: not a status");
  return renderersRowView(status);
};

describe("renderersRowView", () => {
  it("no bundle: not installed, Install", () => {
    expect(view(null)).toEqual({ state: { kind: "none" }, action: "install" });
  });

  it("Synap's bundle: installed at its version, Reinstall latest", () => {
    expect(
      view({
        slug: SYNAP_RENDERERS_SLUG,
        version: "h-0123456789ab",
        setSha256: "a".repeat(64),
        reactVersion: "19.1.0",
      })
    ).toEqual({
      state: { kind: "installed", version: "h-0123456789ab" },
      action: "reinstall",
    });
  });

  // Catches: an Install button that can only be refused (one set per pod).
  it("another bundle: named, and no action offered", () => {
    expect(
      view({
        slug: "acme-renderers",
        version: "1.2.0",
        setSha256: "b".repeat(64),
        reactVersion: "19.1.0",
      })
    ).toEqual({
      state: { kind: "other", slug: "acme-renderers", version: "1.2.0" },
      action: null,
    });
  });
});

describe("renderersRefusalOf", () => {
  const refusal = (reasonCode: unknown) =>
    renderersRefusalOf({
      message: "x",
      data: { code: "FORBIDDEN", reasonCode },
    });

  it("reads each typed refusal from error.data.reasonCode", () => {
    expect(refusal("renderer_bundle_plan_required")).toBe("plan_required");
    expect(refusal("renderer_bundle_pod_not_enrolled")).toBe(
      "pod_not_enrolled"
    );
    expect(refusal("renderer_bundle_no_control_plane")).toBe(
      "no_control_plane"
    );
    expect(refusal("renderer_bundle_insecure_control_plane")).toBe(
      "insecure_control_plane"
    );
    expect(refusal("renderer_bundle_pod_not_live")).toBe("pod_not_live");
    expect(refusal("RENDERER_HOST_SET_TAKEN")).toBe("other_renderers");
  });

  it("anything untyped is a plain failure, never a guessed reason", () => {
    expect(refusal("SOMETHING_ELSE")).toBe("failed");
    expect(refusal(undefined)).toBe("failed");
    expect(renderersRefusalOf(new Error("network"))).toBe("failed");
    expect(renderersRefusalOf(null)).toBe("failed");
    expect(renderersRefusalOf({ data: null })).toBe("failed");
  });
});

describe("every reason the pod's renderer install throws is worded", () => {
  const APP_ROOT = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../.."
  );
  const SERVICES = join(APP_ROOT, "../../packages/api/src/services/renderers");
  const fetchSource = readFileSync(
    join(SERVICES, "official-renderer-bundle.ts"),
    "utf8"
  );
  const installSource = readFileSync(
    join(SERVICES, "install-renderer-bundle.ts"),
    "utf8"
  );
  // Every `renderer_bundle_*` reason the fetch declares (derived, not listed).
  const fetchReasons = [
    ...new Set(
      Array.from(
        fetchSource.matchAll(/"(renderer_bundle_[a-z_]+)"/g),
        (m) => m[1]
      )
    ),
  ];

  it("finds the fetch's reasons (non-vacuity)", () => {
    expect(fetchReasons).toContain("renderer_bundle_plan_required");
    expect(fetchReasons.length).toBeGreaterThanOrEqual(5);
  });

  it("maps each of them", () => {
    expect(fetchReasons.filter((r) => !WORDED_REASONS.includes(r))).toEqual([]);
  });

  it("maps the one-set refusal the install throws", () => {
    expect(installSource).toContain('"RENDERER_HOST_SET_TAKEN"');
    expect(WORDED_REASONS).toContain("RENDERER_HOST_SET_TAKEN");
  });

  it("maps the 'needs a newer pod' refusal the install throws", () => {
    expect(installSource).toContain('"RENDERER_BUNDLE_REQUIRES_UNMET"');
    expect(WORDED_REASONS).toContain("RENDERER_BUNDLE_REQUIRES_UNMET");
  });
});

describe("renderersUpdatesView (plan ad703ccd L2)", () => {
  const NOW = Date.parse("2026-11-23T12:00:00.000Z");
  const V1 = "h-111111111111";
  const V2 = "h-222222222222";
  const status = (version: string | null) => {
    const s = readRenderersStatus(
      wire(
        version
          ? {
              slug: SYNAP_RENDERERS_SLUG,
              version,
              setSha256: "a".repeat(64),
              reactVersion: "19.1.0",
            }
          : null
      )
    );
    if (!s) throw new Error("fixture: not a status");
    return s;
  };
  /** `renderers.updates` as the pod sends it. */
  const updates = (over: Record<string, unknown> = {}) =>
    readRenderersUpdates({
      slug: SYNAP_RENDERERS_SLUG,
      latestVersion: V2,
      latestPublishedAt: "2026-11-23T10:00:00.000Z",
      checkedAt: "2026-11-23T11:50:00.000Z",
      installedRetired: false,
      refusal: null,
      hold: null,
      stoppedAt: null,
      applyAfter: null,
      ...over,
    });
  const receipt = (over: Record<string, unknown> = {}): PackageUpdateReceipt =>
    ({
      id: "r-1",
      slug: SYNAP_RENDERERS_SLUG,
      kind: "renderer-bundle",
      name: "Synap renderers",
      fromVersion: V1,
      toVersion: V2,
      appliedAt: "2026-11-23T11:00:00.000Z",
      source: "automatic" as const,
      changes: [],
      undoUntil: "2026-12-23T11:00:00.000Z",
      undoneAt: null,
      ...over,
    }) as PackageUpdateReceipt;

  it("a newer version applying on its own after its soak", () => {
    const v = renderersUpdatesView(
      status(V1),
      updates({ applyAfter: "2026-11-24T10:00:00.000Z" }),
      null,
      NOW
    );
    expect(v.available).toEqual({
      version: V2,
      wait: "auto",
      applyAfter: "2026-11-24T10:00:00.000Z",
    });
    expect(v.undoable).toBeNull();
  });

  it("why it waits for the person: stopped beats a hold beats automatic off", () => {
    const wait = (over: Record<string, unknown>) =>
      renderersUpdatesView(status(V1), updates(over), null, NOW).available
        ?.wait;
    expect(wait({})).toBe("manual");
    const hold = { version: V2, reason: "requires", detail: "x", at: "t" };
    expect(wait({ hold })).toBe("requires");
    expect(wait({ hold: { ...hold, reason: "undone" } })).toBe("undone");
    expect(wait({ hold, stoppedAt: "t" })).toBe("stopped");
    // A hold on another version does not hold this one.
    expect(wait({ hold: { ...hold, version: "h-0" }, applyAfter: "t" })).toBe(
      "auto"
    );
  });

  // Catches: "update available" for the version already installed.
  it("up to date: nothing available", () => {
    expect(
      renderersUpdatesView(status(V2), updates(), null, NOW).available
    ).toBeNull();
  });

  it("the last update can be undone while its window is open and it is still installed", () => {
    expect(
      renderersUpdatesView(status(V2), updates(), receipt(), NOW).undoable
    ).toEqual({
      receiptId: "r-1",
      version: V2,
      at: "2026-11-23T11:00:00.000Z",
      automatic: true,
    });
    const undoable = (r: Record<string, unknown>, installed = V2) =>
      renderersUpdatesView(status(installed), updates(), receipt(r), NOW)
        .undoable;
    expect(undoable({ undoneAt: "t" })).toBeNull();
    expect(undoable({ undoUntil: "2026-11-01T00:00:00.000Z" })).toBeNull();
    expect(undoable({}, V1)).toBeNull(); // the pod moved on
  });

  // D2: the pod's own first-sync install was refused.
  it("a refusal the pass recorded is worded by the install's reason map", () => {
    const v = renderersUpdatesView(
      status(null),
      updates({
        latestVersion: null,
        refusal: {
          reasonCode: "renderer_bundle_plan_required",
          message: "x",
          at: "2026-11-23T11:50:00.000Z",
        },
      }),
      null,
      NOW
    );
    expect(v.refusal).toBe("plan_required");
    expect(v.available).toBeNull();
  });

  it("an answer it does not know reads as nothing, never as up to date", () => {
    expect(readRenderersUpdates(null)).toBeNull();
    expect(readRenderersUpdates({ latestVersion: V2 })).toBeNull();
    expect(
      updates({ hold: { version: V2, reason: "other", at: "t" } })?.hold
    ).toBeNull();
  });
});

describe("the row's words", () => {
  it("French holds every English key, each well formed", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
