/**
 * Pod updates' Renderers card, through its ONE pure view
 * (`renderersCardView`), driven from the pod's wire shapes:
 *   - each state has one mark, one primary and a ⋯ menu (no Reinstall beside
 *     an Update, no Update for a version that needs a newer pod, no Install
 *     while a request is in review);
 *   - has-an-update is the one rule (`packageHasUpdate`);
 *   - why a version waits is the pod's recorded reason, never guessed from a
 *     missing date;
 *   - a failed updates read is a retry and offers no Pause/Resume; a 403 omits
 *     the part;
 *   - a refusal is worded by the one reason map, whoever met it; every reason
 *     the pod's renderer fetch and install throw is worded (read from the
 *     pod's SOURCE, so a new reason joins this test by existing).
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
  renderersActFailureOf,
  renderersCardView,
  renderersRefusalOf,
  type RenderersCardInput,
  type RenderersLast,
  type RenderersUpdatesRead,
} from "./renderers-model";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const V1 = "h-111111111111";
const V2 = "h-222222222222";

/** `renderers.status` as the pod sends it. */
const status = (bundle: Record<string, unknown> | null) => {
  const s = readRenderersStatus({ bundle, defaults: {}, installed: [] });
  if (!s) throw new Error("fixture: not a status");
  return s;
};
const ours = (version: string) =>
  status({
    slug: SYNAP_RENDERERS_SLUG,
    version,
    setSha256: "a".repeat(64),
    reactVersion: "19.1.0",
  });

/** `renderers.updates` as the pod sends it. */
const updates = (over: Record<string, unknown> = {}): RenderersUpdatesRead => ({
  read: "ok",
  state: readRenderersUpdates({
    slug: SYNAP_RENDERERS_SLUG,
    latestVersion: V2,
    latestPublishedAt: "2026-11-23T10:00:00.000Z",
    checkedAt: "2026-11-23T11:50:00.000Z",
    installedRetired: false,
    refusal: null,
    hold: null,
    pausedAt: null,
    waitReason: null,
    applyAfter: null,
    ...over,
  }),
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
    source: "automatic",
    changes: [],
    undoUntil: "2026-12-23T11:00:00.000Z",
    undoneAt: null,
    ...over,
  }) as PackageUpdateReceipt;

const view = (over: Partial<RenderersCardInput>) =>
  renderersCardView({
    status: status(null),
    updates: { read: "ok", state: null },
    receipt: null,
    last: null,
    now: NOW,
    when: { until: (iso) => `until ${iso}`, since: (iso) => `since ${iso}` },
    ...over,
  });

describe("renderersCardView: the states", () => {
  it("none: Not installed, short line, Install, no menu", () => {
    expect(view({})).toMatchObject({
      mark: { kind: "unknown", label: { key: "renderers.state.none" } },
      secondary: { key: "renderers.none" },
      primary: { kind: "install" },
      overflow: [],
      updates: "omit",
    });
  });

  // Catches: a second proposal filed from a card that already sent one.
  it("none, after a request was sent: its door, never a second Install", () => {
    const v = view({ last: { kind: "proposed", proposalId: "p-1" } });
    expect(v.primary).toEqual({ kind: "open-request", proposalId: "p-1" });
    expect(v.proposalId).toBe("p-1");
  });

  it("another set: named shortly, why in a note, no act", () => {
    const v = view({
      status: status({
        slug: "acme-renderers",
        version: "1.2.0",
        setSha256: "b".repeat(64),
        reactVersion: "19",
      }),
    });
    expect(v.secondary).toEqual({
      key: "renderers.other",
      params: { slug: "acme-renderers", version: "1.2.0" },
    });
    expect(v.notes).toEqual([{ key: "renderers.other.why" }]);
    expect(v.primary).toBeNull();
    expect(v.overflow).toEqual([]);
  });

  it("current: no mark (healthy), no primary, Reinstall and Pause in ⋯", () => {
    const v = view({ status: ours(V2), updates: updates() });
    expect(v.mark).toBeNull();
    expect(v.primary).toBeNull();
    expect(v.overflow).toEqual(["reinstall", "pause"]);
  });

  // Catches: Reinstall beside Update (it skips the receipt, the soak and Undo).
  it("update available: a mark, Update, Pause in ⋯ and no Reinstall", () => {
    const v = view({
      status: ours(V1),
      updates: updates({
        waitReason: "soak",
        applyAfter: "2026-11-24T10:00:00.000Z",
      }),
    });
    expect(v.mark).toEqual({
      kind: "stale",
      label: { key: "renderers.state.available" },
    });
    expect(v.secondary).toEqual({
      key: "renderers.update.available",
      params: { version: V2 },
    });
    expect(v.notes).toEqual([
      {
        key: "renderers.update.soak",
        params: { when: "until 2026-11-24T10:00:00.000Z" },
      },
    ]);
    expect(v.primary).toEqual({ kind: "update", version: V2 });
    expect(v.overflow).toEqual(["pause"]);
  });

  it("a soak already over says 'shortly', never 'now'", () => {
    const v = view({
      status: ours(V1),
      updates: updates({
        waitReason: "soak",
        applyAfter: "2026-11-23T11:00:00.000Z",
      }),
    });
    expect(v.notes).toEqual([{ key: "renderers.update.soakShortly" }]);
  });

  // Catches: an Update button for a version the pod refuses.
  it("needs a newer pod: its mark, and a door to update the pod instead of Update", () => {
    const v = view({
      status: ours(V1),
      updates: updates({
        waitReason: "held",
        hold: { version: V2, reason: "requires", detail: "x", at: "t" },
      }),
    });
    expect(v.mark?.label.key).toBe("renderers.state.needsPod");
    expect(v.primary).toEqual({ kind: "update-pod" });
    expect(v.notes).toEqual([{ key: "renderers.update.requires" }]);
  });

  // Catches: "automatic updates are off" said when they are on.
  it("why it waits is the pod's recorded reason", () => {
    const why = (over: Record<string, unknown>) =>
      view({ status: ours(V1), updates: updates(over) });
    expect(why({ waitReason: "auto_off" })).toMatchObject({
      notes: [{ key: "renderers.update.autoOff" }],
      door: "auto-update",
    });
    expect(why({ waitReason: "setting_unreadable" }).notes).toEqual([
      { key: "renderers.update.settingUnreadable" },
    ]);
    expect(why({ waitReason: "no_owner" }).notes).toEqual([
      { key: "renderers.update.noOwner" },
    ]);
    // Frozen catalog: nothing to press.
    expect(why({ waitReason: "frozen" }).primary).toBeNull();
    for (const reason of ["kit", "undone", "failed"]) {
      const v = why({
        waitReason: "held",
        hold: { version: V2, reason, detail: "", at: "t" },
      });
      expect(v.notes[0]?.key).toBe(
        {
          kit: "renderers.update.kit",
          undone: "renderers.update.undone",
          failed: "renderers.update.failed",
        }[reason]
      );
      expect(v.primary).toEqual({ kind: "update", version: V2 });
    }
    // A hold on another version does not hold this one; no reason, no note.
    expect(
      why({ hold: { version: "h-0", reason: "kit", detail: "", at: "t" } })
        .notes
    ).toEqual([]);
  });

  it("paused: its mark; Update still applies by hand; Resume in ⋯", () => {
    const v = view({
      status: ours(V1),
      updates: updates({ pausedAt: "t", waitReason: "paused" }),
    });
    expect(v.mark).toEqual({
      kind: "unknown",
      label: { key: "renderers.state.paused" },
    });
    expect(v.primary).toEqual({ kind: "update", version: V2 });
    expect(v.overflow).toEqual(["resume"]);
    // Nothing waiting: Resume is the primary.
    const idle = view({
      status: ours(V2),
      updates: updates({ pausedAt: "t" }),
    });
    expect(idle.primary).toEqual({ kind: "resume" });
    expect(idle.overflow).toEqual(["reinstall"]);
  });

  it("updated, Undo open: Undo is the primary, with a line saying when", () => {
    const v = view({
      status: ours(V2),
      updates: updates(),
      receipt: receipt(),
    });
    expect(v.primary).toEqual({ kind: "undo", receiptId: "r-1", version: V2 });
    expect(v.notes).toEqual([
      {
        key: "renderers.updated.auto",
        params: { version: V2, when: "since 2026-11-23T11:00:00.000Z" },
      },
    ]);
    const closed = (over: Record<string, unknown>, installed = V2) =>
      view({
        status: ours(installed),
        updates: updates({ latestVersion: installed }),
        receipt: receipt(over),
      }).primary;
    expect(closed({ undoneAt: "t" })).toBeNull();
    expect(closed({ undoUntil: "2026-11-01T00:00:00.000Z" })).toBeNull();
    expect(closed({}, V1)).toBeNull(); // the pod moved on
  });

  // Catches: Pause/Resume drawn over a state the card never read.
  it("a failed updates read: a retry, no Pause/Resume, no Undo; a 403 omits the part", () => {
    const failed = view({
      status: ours(V1),
      updates: { read: "failed" },
      receipt: receipt({ toVersion: V1 }),
    });
    expect(failed.updates).toBe("failed");
    expect(failed.overflow).toEqual(["reinstall"]);
    expect(failed.primary).toBeNull();
    const forbidden = view({
      status: ours(V1),
      updates: { read: "forbidden" },
    });
    expect(forbidden.updates).toBe("omit");
    expect(forbidden.overflow).toEqual(["reinstall"]);
  });

  it("has-an-update is the one rule: two versions that are equal are not an update", () => {
    const v = view({
      status: ours(V2),
      updates: updates({ latestVersion: V2 }),
    });
    expect(v.mark).toBeNull();
  });
});

describe("renderersCardView: refusals, whoever met them", () => {
  it("a refusal the pod's own pass recorded: worded by the install's map, with when", () => {
    const v = view({
      updates: updates({
        latestVersion: null,
        refusal: {
          reasonCode: "renderer_bundle_plan_required",
          message: "detail",
          at: "2026-11-23T11:50:00.000Z",
        },
      }),
    });
    expect(v.error).toEqual({
      line: { key: "renderers.refused.plan_required" },
      detail: "detail",
      byPassAt: "2026-11-23T11:50:00.000Z",
      enroll: false,
    });
  });

  it("…on an installed pod too", () => {
    const v = view({
      status: ours(V1),
      updates: updates({
        waitReason: "refused",
        refusal: {
          reasonCode: "renderer_bundle_pod_not_enrolled",
          message: "",
          at: "t",
        },
      }),
    });
    expect(v.error?.line.key).toBe("renderers.refused.pod_not_enrolled");
    expect(v.error?.enroll).toBe(true);
  });

  it("the pass's held first install reads as the install's refusal", () => {
    const v = view({
      updates: updates({
        hold: { version: V2, reason: "requires", detail: "d", at: "t" },
      }),
    });
    expect(v.error?.line.key).toBe("renderers.refused.needs_newer_pod");
  });

  it("this visit's failed act is worded: a typed refusal, a conflict, a plain failure", () => {
    const failed = (act: "update" | "undo" | "pause", err: unknown) => {
      const last: RenderersLast = {
        kind: "act-failed",
        act,
        failure: renderersActFailureOf(err),
        detail: "d",
      };
      return view({ status: ours(V1), updates: updates(), last }).error?.line
        .key;
    };
    expect(
      failed("update", {
        data: {
          code: "PRECONDITION_FAILED",
          reasonCode: "RENDERER_BUNDLE_REQUIRES_UNMET",
        },
      })
    ).toBe("renderers.refused.needs_newer_pod");
    expect(failed("update", { data: { code: "CONFLICT" } })).toBe(
      "renderers.update.conflict"
    );
    expect(failed("undo", { data: { code: "CONFLICT" } })).toBe(
      "renderers.undo.conflict"
    );
    expect(failed("undo", { data: { code: "PRECONDITION_FAILED" } })).toBe(
      "renderers.undo.expired"
    );
    expect(failed("pause", new Error("x"))).toBe("renderers.pause.failed");
    expect(failed("update", new Error("x"))).toBe("renderers.update.failedNow");
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

describe("readRenderersUpdates", () => {
  it("an answer it does not know reads as nothing, never as up to date", () => {
    expect(readRenderersUpdates(null)).toBeNull();
    expect(readRenderersUpdates({ latestVersion: V2 })).toBeNull();
    const s = updates({
      hold: { version: V2, reason: "other", at: "t" },
      waitReason: "nonsense",
    });
    expect(s.read === "ok" && s.state?.hold).toBeNull();
    expect(s.read === "ok" && s.state?.waitReason).toBeNull();
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

  it("maps the one-set and 'needs a newer pod' refusals the install throws", () => {
    for (const code of [
      "RENDERER_HOST_SET_TAKEN",
      "RENDERER_BUNDLE_REQUIRES_UNMET",
    ]) {
      expect(installSource).toContain(`"${code}"`);
      expect(WORDED_REASONS).toContain(code);
    }
  });
});

describe("the page's words", () => {
  it("French holds every English key, each well formed", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
