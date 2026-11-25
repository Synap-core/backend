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

vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import { readRenderersStatus } from "../../../_lib/object/content/use-object-renderer";
import { en, fr } from "./copy";
import {
  SYNAP_RENDERERS_SLUG,
  WORDED_REASONS,
  renderersRefusalOf,
  renderersRowView,
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
});

describe("the row's words", () => {
  it("French holds every English key, each well formed", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
