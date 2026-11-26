/**
 * The Renderers card, rendered (react-dom/server) in the states it answers:
 * loading, a failed read (error + Retry, never "Not installed"), not
 * installed (Install), an update (its mark, ONE Update, no Reinstall beside
 * it), an update that needs a newer pod (a door, no Update), a failed updates
 * read (Retry, no Pause/Resume), and a refusal as an ErrorNote with, when the
 * pod is not enrolled, the command that fixes it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/updates",
}));
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import { RenderersBody, type RenderersBodyState } from "./renderers-card";
import type { RenderersCardView } from "./renderers-model";
import { en } from "./copy";

const render = (state: RenderersBodyState) =>
  renderToStaticMarkup(<RenderersBody state={state} />);

const noop = () => {};
const ready = (
  view: Partial<RenderersCardView>,
  pending: Extract<RenderersBodyState, { kind: "ready" }>["pending"] = null
): RenderersBodyState => ({
  kind: "ready",
  view: {
    mark: null,
    secondary: { key: "renderers.version", params: { version: "h-1" } },
    notes: [],
    door: null,
    primary: null,
    overflow: [],
    error: null,
    updates: "ok",
    proposalId: null,
    ...view,
  },
  pending,
  onInstall: noop,
  onReinstall: noop,
  onUpdate: noop,
  onUndo: noop,
  onPause: noop,
  onRetryUpdates: noop,
});

describe("RenderersBody", () => {
  it("loading draws a row skeleton, no state yet", () => {
    const out = render({ kind: "loading" });
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain(en["renderers.state.none"]);
  });

  // Catches: a failed status read shown as "Not installed" with Install.
  it("a failed read is an error with Retry, never Not installed", () => {
    const out = render({ kind: "failed", onRetry: noop });
    expect(out).toContain("Couldn’t read which renderers this pod has.");
    expect(out).toContain(">Retry<");
    expect(out).not.toContain(en["renderers.state.none"]);
    expect(out).not.toContain(">Install<");
  });

  it("not installed: the mark, the short line, and Install", () => {
    const out = render(
      ready({
        mark: { kind: "unknown", label: { key: "renderers.state.none" } },
        secondary: { key: "renderers.none" },
        primary: { kind: "install" },
      })
    );
    expect(out).toContain(en["renderers.state.none"]);
    expect(out).toContain(en["renderers.none"]);
    expect(out).toContain(">Install<");
  });

  it("an update: its mark and ONE Update; Reinstall is not on the card", () => {
    const out = render(
      ready({
        mark: { kind: "stale", label: { key: "renderers.state.available" } },
        secondary: {
          key: "renderers.update.available",
          params: { version: "h-2" },
        },
        notes: [{ key: "renderers.update.soakShortly" }],
        primary: { kind: "update", version: "h-2" },
        overflow: ["pause"],
      })
    );
    expect(out).toContain(en["renderers.state.available"]);
    expect(out).toContain("Version h-2 is available");
    expect(out).toContain(en["renderers.update.soakShortly"]);
    expect(out.match(/>Update</g)).toHaveLength(1);
    expect(out).not.toContain(en["renderers.action.reinstall"]);
    expect(out).toContain(`aria-label="${en["renderers.action.more"]}"`);
  });

  it("the pressed act shows it is running", () => {
    const out = render(
      ready({ primary: { kind: "update", version: "h-2" } }, "update")
    );
    expect(out).toContain('data-loading="true"');
  });

  // Catches: an Update offered for a version this pod refuses.
  it("needs a newer pod: a door to 'How to update now', no Update", () => {
    const out = render(
      ready({
        mark: { kind: "stale", label: { key: "renderers.state.needsPod" } },
        notes: [{ key: "renderers.update.requires" }],
        primary: { kind: "update-pod" },
      })
    );
    expect(out).toContain(en["renderers.action.updatePod"]);
    expect(out).toContain('href="#update-now"');
    expect(out).not.toContain(">Update<");
  });

  it("automatic updates off: a door to the Auto-update card", () => {
    const out = render(
      ready({
        notes: [{ key: "renderers.update.autoOff" }],
        door: "auto-update",
      })
    );
    expect(out).toContain('href="#auto-update"');
  });

  // Catches: a failed updates read that keeps Pause/Resume and no retry.
  it("a failed updates read: an error with Retry", () => {
    const out = render(ready({ updates: "failed", overflow: ["reinstall"] }));
    expect(out).toContain(en["renderers.updates.failed"]);
    expect(out).toContain(">Retry<");
  });

  it("Undo names what it undoes for a screen reader", () => {
    const out = render(
      ready({ primary: { kind: "undo", receiptId: "r", version: "h-2" } })
    );
    expect(out).toContain('aria-label="Undo the update to h-2"');
  });

  // Catches: a refusal that only shows as a raw install error.
  it("a refusal stays on the card as an ErrorNote, in words", () => {
    const out = render(
      ready({
        error: {
          line: { key: "renderers.refused.plan_required" },
          detail: "The official renderers come with a Synap plan…",
          byPassAt: null,
          enroll: false,
        },
      })
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain("needs a Synap plan");
    expect(out).toContain("Copy details");
    expect(out).not.toContain("synap pod-key enroll");
  });

  it("a pod that is not enrolled is told the command", () => {
    const out = render(
      ready({
        error: {
          line: { key: "renderers.refused.pod_not_enrolled" },
          detail: "x",
          byPassAt: "2026-11-23T11:00:00.000Z",
          enroll: true,
        },
      })
    );
    expect(out).toContain(en["renderers.refused.pod_not_enrolled"]);
    expect(out).toContain("synap pod-key enroll");
    expect(out).toContain("This pod tried on its own");
  });

  it("a request in review: its door, and the line saying so", () => {
    const out = render(
      ready({
        primary: { kind: "open-request", proposalId: "p-1" },
        proposalId: "p-1",
      })
    );
    expect(out).toContain(en["renderers.proposed"]);
    expect(out).toContain(en["renderers.proposed.open"]);
    expect(out).not.toContain(">Install<");
  });
});
